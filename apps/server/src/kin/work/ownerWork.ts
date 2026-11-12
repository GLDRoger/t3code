import {
  KIN_RECORD_CHANGES_CAP,
  KinChatError,
  type KinOrgId,
  KinRecordState,
  type KinWorkAssignInput,
  type KinWorkConfirmInput,
  type KinWorkCreateInput,
  type KinWorkGetInput,
  type KinWorkListInput,
  type KinWorkPrincipal,
  type KinWorkSummary,
  type KinWorkUpdateInput,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import type { PersonIdentity } from "../chat/KinIdentity.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { summaryGroups } from "./crm.ts";
import { KinRecords, type Patch, type Writer } from "./KinRecords.ts";
import { LISTS, type ListName, parseFields } from "./lists.ts";
import { isBuiltIn, listDef, unknownList } from "./registers.ts";
import {
  endOfDay,
  isClosed,
  iso,
  notFound,
  ownerZone,
  principal,
  toRecord,
  unavailable,
  workFailure,
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

export const theOwner = Effect.fn("KinWork.owner")(function* (
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

/** `o:<offset>` or `o:<offset>:<ms>`: the time the first page judged `late` at, so pages hold. */
const parseCursor = (cursor: string | undefined) => {
  if (cursor === undefined) return Effect.succeed({ offset: 0, at: undefined });
  const found = /^o:(\d{1,9})(?::(\d{1,15}))?$/.exec(cursor);
  return found === null
    ? Effect.fail(
        new KinChatError({ reason: "invalid_state", message: "That page cursor is stale." }),
      )
    : Effect.succeed({
        offset: Number.parseInt(found[1]!, 10),
        at: found[2] === undefined ? undefined : Number.parseInt(found[2], 10),
      });
};

/** A key the owner named, in the list it must be in. */
export const inList = Effect.fn("KinWork.inList")(function* (
  orgId: KinOrgId,
  key: string,
  list: ListName,
) {
  const records = yield* KinRecords;
  const row = yield* records.get(orgId, key);
  // Work's edits also reach the lists defined in chat, whose own fields are typed there.
  const inIt =
    row !== undefined &&
    (row.registerId === list || (list === "work" && !isBuiltIn(row.registerId)));
  if (row === undefined || !inIt)
    return yield* new KinChatError({
      reason: "not_found",
      message: `No ${LISTS[list].noun} ${key.slice(0, 40)} in Work.`,
    });
  return row;
});
const refId = Effect.fn("KinWork.refId")(function* (
  orgId: KinOrgId,
  key: string | null | undefined,
  list: "clients" | "projects",
) {
  if (key === undefined) return undefined;
  if (key === null) return null;
  return (yield* inList(orgId, key, list)).recordId;
});

export const list = Effect.fn("KinWork.list")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinWorkListInput,
) {
  yield* theOwner(people, input.orgId);
  const records = yield* KinRecords;
  const cursor = yield* parseCursor(input.cursor);
  const partyId = yield* refId(input.orgId, input.party, "clients");
  const projectId = yield* refId(input.orgId, input.project, "projects");
  const at = cursor.at ?? (yield* Clock.currentTimeMillis);
  const limit = input.limit ?? 50;
  if (
    input.list !== undefined &&
    (yield* listDef(input.orgId, input.list).pipe(workFailure)) === undefined
  )
    return yield* unknownList(input.list);
  const DAY_MS = 24 * 60 * 60 * 1000;
  const zone =
    input.dateFrom === undefined && input.dateTo === undefined
      ? "UTC"
      : yield* ownerZone(input.orgId).pipe(workFailure);
  const filter = {
    ...(input.list === undefined ? {} : { list: input.list }),
    ...(input.owner === undefined ? {} : { owner: input.owner }),
    ...(input.states === undefined ? {} : { states: input.states }),
    ...(input.open === undefined ? {} : { open: input.open }),
    ...(input.late === undefined ? {} : { late: input.late }),
    ...(input.dueBy === undefined ? {} : { dueBy: yield* millis(input.dueBy, "dueBy") }),
    ...(input.dueAfter === undefined
      ? {}
      : { dueAfter: yield* millis(input.dueAfter, "dueAfter") }),
    ...(input.category === undefined ? {} : { category: input.category }),
    ...(input.list === undefined || input.listCategory === undefined
      ? {}
      : { category: input.listCategory }),
    ...(input.dateFrom === undefined
      ? {}
      : { dateFrom: endOfDay(input.dateFrom, zone) - DAY_MS + 1 }),
    ...(input.dateTo === undefined ? {} : { dateTo: endOfDay(input.dateTo, zone) + 1 }),
    ...(input.paidFrom === undefined ? {} : { paidFrom: input.paidFrom }),
    ...(input.paidTo === undefined ? {} : { paidTo: input.paidTo }),
    ...(input.side === undefined ? {} : { side: input.side }),
    ...(partyId === undefined || partyId === null ? {} : { partyId }),
    ...(projectId === undefined || projectId === null ? {} : { projectId }),
    ...(input.repo === undefined ? {} : { repo: input.repo }),
    ...(input.text === undefined ? {} : { text: input.text }),
    at,
  };
  const page = yield* records.query(input.orgId, { ...filter, offset: cursor.offset, limit });
  // The sums are of every match and the same on each page, so only the first page pays for them.
  const totals =
    input.totalsBy === undefined || input.cursor !== undefined
      ? undefined
      : yield* records.totals(
          input.orgId,
          // A void entry's amount is not money: sums leave it out unless the filter asks for it.
          input.states === undefined && input.open === undefined
            ? { ...filter, states: KinRecordState.literals.filter((state) => state !== "dropped") }
            : filter,
          input.totalsBy === "none" ? undefined : input.totalsBy,
          true,
        );
  const next = cursor.offset + page.rows.length;
  return {
    records: page.rows.map((row) => {
      const record = toRecord(row, at);
      const fields = isBuiltIn(row.registerId) ? {} : parseFields(row.fieldsJson);
      return Object.keys(fields).length === 0 ? record : { ...record, fields };
    }),
    total: page.total,
    nextCursor: next < page.total ? `o:${next}:${at}` : null,
    seq: page.seq,
    asOf: iso(at),
    ...(totals === undefined
      ? {}
      : { totals: { total: totals.total, groups: totals.groups ?? [] } }),
  };
});

const found = Effect.fn("KinWork.found")(function* (
  orgId: KinOrgId,
  ref: { readonly key: string } | { readonly recordId: string },
) {
  const records = yield* KinRecords;
  const row =
    "key" in ref ? yield* records.get(orgId, ref.key) : yield* records.getById(orgId, ref.recordId);
  if (row === undefined) return yield* notFound("key" in ref ? ref.key : "with that id");
  return row;
});

export { found };
export const get = Effect.fn("KinWork.get")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinWorkGetInput,
) {
  yield* theOwner(people, input.orgId);
  const records = yield* KinRecords;
  return yield* records.detail(yield* found(input.orgId, input), KIN_RECORD_CHANGES_CAP);
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
  const [closed] = yield* sql<{ closed: number }>`SELECT COUNT(*) AS closed FROM kin_records
    WHERE org_id = ${input.orgId} AND register_id = 'work' AND state IN ('done', 'dropped')`.pipe(
    Effect.mapError(() => unavailable),
  );
  const rows = yield* sql<{ ownerKind: string; ownerId: string } & Counts>`
    SELECT owner_kind AS "ownerKind", owner_id AS "ownerId", COUNT(*) AS open,
      SUM(state = 'doing') AS doing, SUM(state = 'waiting') AS waiting,
      SUM(due_at IS NOT NULL AND due_at < ${now}) AS late,
      SUM(due_at IS NOT NULL AND due_at >= ${now} AND due_at < ${now + WEEK_MS}) AS "dueThisWeek"
    FROM kin_records WHERE org_id = ${input.orgId} AND register_id = 'work'
      AND state NOT IN ('done', 'dropped')
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
  const groups = yield* summaryGroups(input.orgId, now).pipe(Effect.mapError(() => unavailable));
  return {
    ...total,
    closed: closed?.closed ?? 0,
    owners,
    parties: groups.parties,
    projects: groups.projects,
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
        .pipe(Stream.map((tick) => ({ _tag: "changed" as const, ...tick })));
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
    input.dueAt === undefined ? null : yield* dueMillis(input.orgId, input.dueAt, input.dueAllDay);
  const owner: KinWorkPrincipal = input.owner ?? { _tag: "person", personId: person.personId };
  const partyId = yield* refId(input.orgId, input.party, "clients");
  const projectId = yield* refId(input.orgId, input.project, "projects");
  const { row } = yield* records.create(input.orgId, ownerWriter(person), {
    originKey: `owner:${input.clientRequestId}`,
    title: input.title,
    owner,
    dueAt,
    dueAllDay: input.dueAllDay === true,
    ...(input.notes === undefined ? {} : { notes: input.notes }),
    ...(input.category === undefined ? {} : { category: input.category }),
    ...(partyId === undefined ? {} : { partyId }),
    ...(projectId === undefined ? {} : { projectId }),
    ...(input.side === undefined ? {} : { side: input.side }),
    ...(input.repo === undefined ? {} : { repo: input.repo }),
  });
  return yield* records.detail(row, KIN_RECORD_CHANGES_CAP);
});

/** A closed entry is refused: reopen it first. Taking it back (`to: null`) returns it to the owner. */
export const assign = Effect.fn("KinWork.assign")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinWorkAssignInput,
) {
  const person = yield* theOwner(people, input.orgId);
  yield* inList(input.orgId, input.key, "work");
  const to: KinWorkPrincipal = input.to ?? { _tag: "person", personId: person.personId };
  return yield* change(person, input.orgId, input.key, { owner: to }, input.rev);
});

export const update = Effect.fn("KinWork.update")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinWorkUpdateInput,
) {
  const person = yield* theOwner(people, input.orgId);
  const due: Patch =
    input.dueAt === undefined
      ? input.dueAllDay === undefined
        ? {}
        : { dueAllDay: input.dueAllDay }
      : input.dueAt === null
        ? { dueAt: null, dueAllDay: false }
        : {
            dueAt: yield* dueMillis(input.orgId, input.dueAt, input.dueAllDay),
            dueAllDay: input.dueAllDay === true,
          };
  yield* inList(input.orgId, input.key, "work");
  const partyId = yield* refId(input.orgId, input.party, "clients");
  const projectId = yield* refId(input.orgId, input.project, "projects");
  return yield* change(
    person,
    input.orgId,
    input.key,
    {
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.notes === undefined ? {} : { notes: input.notes }),
      ...(input.state === undefined ? {} : { state: input.state }),
      ...(input.waitingOn === undefined ? {} : { waitingOn: input.waitingOn }),
      ...(input.category === undefined ? {} : { category: input.category }),
      ...(partyId === undefined ? {} : { partyId }),
      ...(projectId === undefined ? {} : { projectId }),
      ...(input.side === undefined ? {} : { side: input.side }),
      ...(input.repo === undefined ? {} : { repo: input.repo }),
      ...(input.sensitive === undefined ? {} : { sensitive: input.sensitive }),
      ...(input.amount === undefined ? {} : { amount: input.amount }),
      ...(input.repeat === undefined ? {} : { repeat: input.repeat }),
      ...due,
      ...(input.dateAt === undefined
        ? input.dateAllDay === undefined
          ? {}
          : { dateAllDay: input.dateAllDay }
        : input.dateAt === null
          ? { dateAt: null, dateAllDay: false }
          : {
              dateAt: yield* dueMillis(input.orgId, input.dateAt, input.dateAllDay),
              dateAllDay: input.dateAllDay === true,
            }),
    },
    input.rev,
  );
});

/** Keeps a lead's suggestion: it counts as the owner's from now on. */
export const confirm = Effect.fn("KinWork.confirm")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinWorkConfirmInput,
) {
  const person = yield* theOwner(people, input.orgId);
  return yield* change(person, input.orgId, input.key, { confirmed: true }, input.rev);
});

/** Declines a lead's suggestion by dropping it; an entry the owner already kept is refused. */
export const decline = Effect.fn("KinWork.decline")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinWorkConfirmInput,
) {
  const person = yield* theOwner(people, input.orgId);
  const row = yield* found(input.orgId, input);
  if (row.confirmed === 1)
    return yield* new KinChatError({
      reason: "invalid_state",
      message: `${row.key} is not a suggestion${isClosed(row.state) ? "" : "; drop it instead"}.`,
    });
  return yield* change(person, input.orgId, input.key, { state: "dropped" }, input.rev);
});

const change = Effect.fn("KinWork.change")(function* (
  person: PersonIdentity,
  orgId: KinOrgId,
  key: string,
  patch: Patch,
  rev: number | undefined,
) {
  const records = yield* KinRecords;
  const row = yield* records.update(orgId, ownerWriter(person), key, patch, rev);
  return yield* records.detail(row, KIN_RECORD_CHANGES_CAP);
});

export const dueMillis = Effect.fn("KinWork.dueMillis")(function* (
  orgId: KinOrgId,
  dueAt: string,
  allDay: boolean | undefined,
) {
  return allDay === true && /^\d{4}-\d{2}-\d{2}$/.test(dueAt)
    ? endOfDay(dueAt, yield* ownerZone(orgId))
    : yield* millis(dueAt, "dueAt");
});

export const ownerWriter = (person: PersonIdentity): Writer => ({
  actor: { _tag: "person", personId: person.personId },
  via: "owner",
  askedBy: person.personId,
});
