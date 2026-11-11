import {
  KIN_RECORD_CHANGES_CAP,
  KinChatError,
  type KinOrgId,
  type KinWorkAssignInput,
  type KinWorkCreateInput,
  type KinWorkListInput,
  type KinWorkPrincipal,
  type KinWorkSummary,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import type { PersonIdentity } from "../chat/KinIdentity.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { KinRecords, type Writer } from "./KinRecords.ts";
import {
  endOfDay,
  iso,
  notFound,
  ownerZone,
  principal,
  toRecord,
  unavailable,
} from "./recordRows.ts";

/**
 * What the owner's clients read and do in Work. Slice 1 is owner only: anyone else, a teammate's
 * chat-only session included, is refused here as well as by the RPC scopes.
 */

const ownerOnly = new KinChatError({
  reason: "not_allowed",
  message: "Only the owner can see Work yet.",
});
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const theOwner = Effect.fn("KinWork.owner")(function* (
  people: ReadonlyArray<PersonIdentity>,
  orgId: KinOrgId,
) {
  const { owner } = yield* KinIdentity;
  const person = people.find((candidate) => candidate.orgId === orgId);
  if (person === undefined || person.orgId !== owner.orgId || person.personId !== owner.personId)
    return yield* ownerOnly;
  return person;
});

const millis = (value: string, field: string) => {
  const ms = Date.parse(value);
  return Number.isFinite(ms)
    ? Effect.succeed(ms)
    : Effect.fail(
        new KinChatError({ reason: "invalid_state", message: `${field} is not a time.` }),
      );
};

export const list = Effect.fn("KinWork.list")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinWorkListInput,
) {
  yield* theOwner(people, input.orgId);
  const records = yield* KinRecords;
  const offset =
    input.cursor === undefined ? 0 : Number.parseInt(input.cursor.replace(/^o:/, ""), 10);
  if (!Number.isFinite(offset) || offset < 0)
    return yield* new KinChatError({
      reason: "invalid_state",
      message: "That page cursor is stale.",
    });
  const limit = input.limit ?? 50;
  const page = yield* records.query(input.orgId, {
    ...(input.owner === undefined ? {} : { owner: input.owner }),
    ...(input.states === undefined ? {} : { states: input.states }),
    ...(input.open === undefined ? {} : { open: input.open }),
    ...(input.late === undefined ? {} : { late: input.late }),
    ...(input.dueBy === undefined ? {} : { dueBy: yield* millis(input.dueBy, "dueBy") }),
    ...(input.text === undefined ? {} : { text: input.text }),
    offset,
    limit,
  });
  const now = yield* Clock.currentTimeMillis;
  return {
    records: page.rows.map((row) => toRecord(row, now)),
    total: page.total,
    nextCursor: offset + page.rows.length < page.total ? `o:${offset + page.rows.length}` : null,
    seq: page.seq,
    asOf: iso(now),
  };
});

export const get = Effect.fn("KinWork.get")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: { readonly orgId: KinOrgId; readonly key: string },
) {
  yield* theOwner(people, input.orgId);
  const records = yield* KinRecords;
  const row = yield* records.get(input.orgId, input.key);
  if (row === undefined) return yield* notFound(input.key);
  return yield* records.detail(row, KIN_RECORD_CHANGES_CAP);
});

type Counts = { open: number; doing: number; waiting: number; late: number; dueThisWeek: number };
export const summary = Effect.fn("KinWork.summary")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: { readonly orgId: KinOrgId },
) {
  yield* theOwner(people, input.orgId);
  const sql = yield* SqlClient.SqlClient;
  const records = yield* KinRecords;
  const now = yield* Clock.currentTimeMillis;
  const rows = yield* sql<{ ownerKind: string; ownerId: string } & Counts>`
    SELECT owner_kind AS "ownerKind", owner_id AS "ownerId", COUNT(*) AS open,
      SUM(state = 'doing') AS doing, SUM(state = 'waiting') AS waiting,
      SUM(due_at IS NOT NULL AND due_at < ${now}) AS late,
      SUM(due_at IS NOT NULL AND due_at >= ${now} AND due_at < ${now + WEEK_MS}) AS "dueThisWeek"
    FROM kin_records WHERE org_id = ${input.orgId} AND state NOT IN ('done', 'dropped')
    GROUP BY owner_kind, owner_id ORDER BY COUNT(*) DESC, owner_kind, owner_id`.pipe(
    Effect.mapError(() => unavailable),
  );
  const zero: Counts = { open: 0, doing: 0, waiting: 0, late: 0, dueThisWeek: 0 };
  const owners = rows.flatMap((row) => {
    const owner = principal(row.ownerKind, row.ownerId);
    return owner === null
      ? []
      : [
          {
            owner,
            open: row.open,
            doing: row.doing,
            waiting: row.waiting,
            late: row.late,
            dueThisWeek: row.dueThisWeek,
          },
        ];
  });
  const total = owners.reduce(
    (sum, row) => ({
      open: sum.open + row.open,
      doing: sum.doing + row.doing,
      waiting: sum.waiting + row.waiting,
      late: sum.late + row.late,
      dueThisWeek: sum.dueThisWeek + row.dueThisWeek,
    }),
    zero,
  );
  return {
    ...total,
    owners,
    seq: yield* records.seq(input.orgId),
    asOf: iso(now),
  } satisfies KinWorkSummary;
});

export const subscribe = (
  people: ReadonlyArray<PersonIdentity>,
  input: { readonly orgId: KinOrgId },
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      yield* theOwner(people, input.orgId);
      const records = yield* KinRecords;
      return records
        .changes(input.orgId)
        .pipe(Stream.map((seq) => ({ _tag: "changed" as const, seq })));
    }),
  );

/** The owner's own words, so it is confirmed; given to a lead, it is an instruction to do it. */
export const create = Effect.fn("KinWork.create")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinWorkCreateInput,
) {
  const person = yield* theOwner(people, input.orgId);
  const records = yield* KinRecords;
  const dueAt =
    input.dueAt === undefined
      ? null
      : input.dueAllDay === true && /^\d{4}-\d{2}-\d{2}$/.test(input.dueAt)
        ? endOfDay(input.dueAt, yield* ownerZone(input.orgId))
        : yield* millis(input.dueAt, "dueAt");
  const owner: KinWorkPrincipal = input.owner ?? { _tag: "person", personId: person.personId };
  const { row } = yield* records.create(input.orgId, ownerWriter(person), {
    originKey: `owner:${input.clientRequestId}`,
    title: input.title,
    owner,
    dueAt,
    dueAllDay: input.dueAllDay === true,
    ...(input.notes === undefined ? {} : { notes: input.notes }),
    ...(input.category === undefined ? {} : { category: input.category }),
  });
  return yield* records.detail(row, KIN_RECORD_CHANGES_CAP);
});

export const assign = Effect.fn("KinWork.assign")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinWorkAssignInput,
) {
  const person = yield* theOwner(people, input.orgId);
  const records = yield* KinRecords;
  const row = yield* records.update(
    input.orgId,
    ownerWriter(person),
    input.key,
    { owner: input.to },
    input.rev,
  );
  return yield* records.detail(row, KIN_RECORD_CHANGES_CAP);
});

const ownerWriter = (person: PersonIdentity): Writer => ({
  actor: { _tag: "person", personId: person.personId },
  via: "owner",
  askedBy: person.personId,
});
