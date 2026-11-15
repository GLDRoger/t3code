import {
  KIN_RECORD_CHANGES_CAP,
  KinChatError,
  type KinOrgId,
  type KinRecord,
  KinRecordState,
  type KinWorkAssignInput,
  type KinWorkConfirmInput,
  type KinWorkCreateInput,
  type KinWorkGetInput,
  type KinWorkListInput,
  type KinWorkPrincipal,
  type KinWorkShareInput,
  type KinWorkSummary,
  type KinWorkUpdateInput,
  calendarTimeMillis,
  isCalendarDay,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import type { PersonIdentity } from "../chat/KinIdentity.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import { readableFrom } from "../chat/sharing.ts";
import { summaryGroups } from "./crm.ts";
import {
  KinRecords,
  requestHashOf,
  type Patch,
  type Tick,
  type Totals,
  type Writer,
} from "./KinRecords.ts";
import { fieldList, LISTS, type ListName, parseFields } from "./lists.ts";
import { isBuiltIn, listDef, unknownList } from "./registers.ts";
import {
  effectivelySensitive,
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
import {
  teamDetail,
  teamKeys,
  teamMayWrite,
  teamRecord,
  teamSees,
  teamSeq,
  teamVisible,
} from "./teamView.ts";

/**
 * What people's clients read and do in Work. The owner reads and does everything; a teammate
 * reads the tasks `teamView.ts` gives them and changes their own, and nothing else here.
 */

const ownerOnly = new KinChatError({
  reason: "not_allowed",
  message: "Only the owner can do that in Work.",
});
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export const theOwner = Effect.fn("KinWork.owner")(function* (
  people: ReadonlyArray<PersonIdentity>,
  orgId: KinOrgId,
) {
  const viewer = yield* viewerOf(people, orgId);
  if (viewer.teammate) return yield* ownerOnly;
  return viewer.person;
});

/** The caller in this org, and whether they are a teammate rather than its owner. */
const viewerOf = Effect.fn("KinWork.viewer")(function* (
  people: ReadonlyArray<PersonIdentity>,
  orgId: KinOrgId,
) {
  const { owner } = yield* KinIdentity;
  const person = people.find((candidate) => candidate.orgId === orgId);
  if (person === undefined) return yield* ownerOnly;
  return {
    person,
    teammate: person.orgId !== owner.orgId || person.personId !== owner.personId,
  };
});
type Viewer = Effect.Success<ReturnType<typeof viewerOf>>;

const millis = (value: string, field: string) => {
  const ms = calendarTimeMillis(value);
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
/** A client or project named on a task; to a teammate, a sensitive one is no such thing. */
const refId = Effect.fn("KinWork.refId")(function* (
  viewer: Viewer,
  orgId: KinOrgId,
  key: string | null | undefined,
  list: "clients" | "projects",
) {
  if (key === undefined) return undefined;
  if (key === null) return null;
  const row = yield* inList(orgId, key, list);
  if (
    viewer.teammate &&
    (yield* effectivelySensitive(orgId, row.recordId).pipe(workFailure)) !== false
  )
    return yield* new KinChatError({
      reason: "not_found",
      message: `No ${LISTS[list].noun} ${key.slice(0, 40)} in Work.`,
    });
  return row.recordId;
});

const teamRefused = new KinChatError({
  reason: "not_allowed",
  message: "Only the owner changes that.",
});

/** A task a teammate may change: one they can't see is unknown; one they only see is refused. */
const teamWritable = Effect.fn("KinWork.teamWritable")(function* (
  person: PersonIdentity,
  row: { readonly recordId: string; readonly key: string },
) {
  const seen = yield* teamVisible(person.orgId, person.personId, [row.recordId]).pipe(workFailure);
  if (!seen.has(row.recordId)) return yield* notFound(row.key);
  if (!(yield* teamMayWrite(person.orgId, person.personId, row.recordId).pipe(workFailure)))
    return yield* new KinChatError({
      reason: "not_allowed",
      message: `Only whoever holds ${row.key}, or gave it to them, can change it.`,
    });
});

/**
 * An agent a teammate gives a task to: one whose owner lets them message it, and their direct
 * chat with it, where it reports. Any other looks like no agent at all.
 */
const teamAgent = Effect.fn("KinWork.teamAgent")(function* (
  person: PersonIdentity,
  to: KinWorkPrincipal,
) {
  if (to._tag !== "agent") return;
  // Without the chat service (a bare test layer) the wake still refuses an agent with no chat.
  const chats = yield* Effect.serviceOption(KinChatService);
  if (Option.isNone(chats)) return;
  yield* chats.value.createDirect(person, { orgId: person.orgId, agentId: to.agentId }).pipe(
    Effect.mapError((error) =>
      error._tag === "KinChatError" &&
      (error.reason === "not_found" || error.reason === "not_allowed")
        ? new KinChatError({
            reason: "not_found",
            message: `No agent ${to.agentId.slice(0, 60)} here to own it.`,
          })
        : unavailable,
    ),
  );
});

export const list = Effect.fn("KinWork.list")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinWorkListInput,
) {
  const viewer = yield* viewerOf(people, input.orgId);
  if (viewer.teammate) {
    if (input.list !== undefined && input.list !== "work") return yield* unknownList(input.list);
    if (
      input.totalsBy !== undefined ||
      input.listCategory !== undefined ||
      input.dateFrom !== undefined ||
      input.dateTo !== undefined ||
      input.paidFrom !== undefined ||
      input.paidTo !== undefined
    )
      return yield* ownerOnly;
  }
  const records = yield* KinRecords;
  const cursor = yield* parseCursor(input.cursor);
  const partyId = yield* refId(viewer, input.orgId, input.party, "clients");
  const projectId = yield* refId(viewer, input.orgId, input.project, "projects");
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
    ...(input.party === null ? { partyId: null } : {}),
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
    ...(viewer.teammate ? { team: viewer.person.personId } : {}),
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
    records: page.rows.map((row): KinRecord => {
      const record = toRecord(row, at);
      if (viewer.teammate) return teamRecord(record);
      const fields = isBuiltIn(row.registerId) ? {} : parseFields(row.fieldsJson);
      return Object.keys(fields).length === 0 ? record : { ...record, fields };
    }),
    total: page.total,
    nextCursor: next < page.total ? `o:${next}:${at}` : null,
    seq: page.seq,
    asOf: iso(at),
    ...(totals === undefined ? {} : { totals: listTotals(totals) }),
  };
});

const listTotals = ({ counted: _counted, groups, ...sums }: Totals) => ({
  ...sums,
  groups: groups ?? [],
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
  const viewer = yield* viewerOf(people, input.orgId);
  const records = yield* KinRecords;
  const row = yield* found(input.orgId, input);
  return yield* shownTo(viewer, yield* records.detail(row, KIN_RECORD_CHANGES_CAP), input);
});

/** An entry's sheet for this viewer; one a teammate may not see fails as an unknown one does. */
const shownTo = Effect.fn("KinWork.shownTo")(function* (
  viewer: Viewer,
  detail: Effect.Success<ReturnType<KinRecords["Service"]["detail"]>>,
  ref: { readonly key: string } | { readonly recordId: string },
) {
  if (!viewer.teammate) return detail;
  const { personId } = viewer.person;
  const seen = yield* teamVisible(detail.orgId, personId, [detail.recordId]).pipe(workFailure);
  if (!seen.has(detail.recordId)) return yield* notFound("key" in ref ? ref.key : "with that id");
  return yield* teamDetail(detail, personId).pipe(workFailure);
});

type Counts = { open: number; doing: number; waiting: number; late: number; dueThisWeek: number };
export const summary = Effect.fn("KinWork.summary")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: { readonly orgId: KinOrgId },
) {
  const viewer = yield* viewerOf(people, input.orgId);
  const sql = yield* SqlClient.SqlClient;
  const records = yield* KinRecords;
  const now = yield* Clock.currentTimeMillis;
  const team = viewer.teammate ? teamSees(sql, viewer.person.personId) : sql`1 = 1`;
  const [closed] = yield* sql<{ closed: number }>`SELECT COUNT(*) AS closed FROM kin_records r
    WHERE r.org_id = ${input.orgId} AND r.register_id = 'work' AND r.state IN ('done', 'dropped')
      AND ${team}`.pipe(Effect.mapError(() => unavailable));
  const rows = yield* sql<{ ownerKind: string; ownerId: string } & Counts>`
    SELECT r.owner_kind AS "ownerKind", r.owner_id AS "ownerId", COUNT(*) AS open,
      SUM(r.state = 'doing') AS doing, SUM(r.state = 'waiting') AS waiting,
      SUM(r.due_at IS NOT NULL AND r.due_at < ${now}) AS late,
      SUM(r.due_at IS NOT NULL AND r.due_at >= ${now} AND r.due_at < ${now + WEEK_MS}) AS "dueThisWeek"
    FROM kin_records r WHERE r.org_id = ${input.orgId} AND r.register_id = 'work'
      AND r.state NOT IN ('done', 'dropped') AND ${team}
    GROUP BY r.owner_kind, r.owner_id ORDER BY COUNT(*) DESC, r.owner_kind, r.owner_id`.pipe(
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
  // Clients' and projects' counts are the owner's: they add up work a teammate can't see.
  const groups = viewer.teammate
    ? { parties: [], projects: [] }
    : yield* summaryGroups(input.orgId, now).pipe(Effect.mapError(() => unavailable));
  return {
    ...total,
    closed: closed?.closed ?? 0,
    owners,
    parties: groups.parties,
    projects: groups.projects,
    seq: viewer.teammate
      ? yield* teamSeq(input.orgId, viewer.person.personId).pipe(workFailure)
      : yield* records.seq(input.orgId),
    asOf: iso(now),
  } satisfies KinWorkSummary;
});

export const subscribe = (
  people: ReadonlyArray<PersonIdentity>,
  input: { readonly orgId: KinOrgId },
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const viewer = yield* viewerOf(people, input.orgId);
      const records = yield* KinRecords;
      const changes = records.changes(input.orgId);
      const named = (tick: Tick) => ({
        _tag: "changed" as const,
        seq: tick.seq,
        ...(tick.key === undefined ? {} : { key: tick.key }),
      });
      if (!viewer.teammate) return changes.pipe(Stream.map(named));
      const { personId } = viewer.person;
      // What they could see when the stream began or since: a change hiding one reaches them.
      let seen = new Set<string>();
      return changes.pipe(
        Stream.mapEffect((tick) =>
          Effect.gen(function* () {
            if (tick.key === undefined) {
              seen = yield* teamKeys(input.orgId, personId);
              return [{ _tag: "changed" as const, seq: yield* teamSeq(input.orgId, personId) }];
            }
            if (tick.registerId === "clients" || tick.registerId === "projects") {
              // A client or project labelled sensitive hides its tasks without a change to them.
              const still = yield* teamKeys(input.orgId, personId);
              const hidden = [...seen].filter((key) => !still.has(key));
              seen = new Set([...seen].filter((key) => still.has(key)));
              return hidden.map((key) => named({ seq: tick.seq, key }));
            }
            const shown = tick.seenBy?.includes(personId) === true;
            const was = seen.has(tick.key);
            if (shown) seen.add(tick.key);
            else seen.delete(tick.key);
            return shown || was ? [named(tick)] : [];
          }).pipe(workFailure),
        ),
        Stream.flattenIterable,
      );
    }),
  );

/** The owner's own words, so it is confirmed; given to a lead, it is an instruction to do it. */
export const create = Effect.fn("KinWork.create")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinWorkCreateInput,
) {
  const viewer = yield* viewerOf(people, input.orgId);
  const { person } = viewer;
  const records = yield* KinRecords;
  const dueAt =
    input.dueAt === undefined ? null : yield* dueMillis(input.orgId, input.dueAt, input.dueAllDay);
  const owner: KinWorkPrincipal = input.owner ?? { _tag: "person", personId: person.personId };
  const partyId = yield* refId(viewer, input.orgId, input.party, "clients");
  const projectId = yield* refId(viewer, input.orgId, input.project, "projects");
  if (viewer.teammate) yield* teamAgent(person, owner);
  const { row } = yield* records.create(input.orgId, ownerWriter(person), {
    // A teammate's requests have their own keys, so a retry never finds someone else's entry.
    originKey: viewer.teammate
      ? `member:${person.personId}:${input.clientRequestId}`
      : `owner:${input.clientRequestId}`,
    // What a teammate files is company work, in the open for the team.
    ...(viewer.teammate ? { team: true } : {}),
    requestHash: requestHashOf(input),
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
  return yield* shownTo(viewer, yield* records.detail(row, KIN_RECORD_CHANGES_CAP), row);
});

/** A closed entry is refused: reopen it first. Taking it back (`to: null`) returns it to the owner. */
export const assign = Effect.fn("KinWork.assign")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinWorkAssignInput,
) {
  const viewer = yield* viewerOf(people, input.orgId);
  const { person } = viewer;
  const row = yield* inList(input.orgId, input.key, "work");
  if (viewer.teammate) yield* teamWritable(person, row);
  const to: KinWorkPrincipal = input.to ?? { _tag: "person", personId: person.personId };
  if (viewer.teammate) yield* teamAgent(person, to);
  return yield* change(viewer, input.orgId, input.key, { owner: to }, input.rev);
});

export const update = Effect.fn("KinWork.update")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinWorkUpdateInput,
) {
  const viewer = yield* viewerOf(people, input.orgId);
  const { person } = viewer;
  if (
    viewer.teammate &&
    (input.sensitive !== undefined ||
      input.amount !== undefined ||
      input.repeat !== undefined ||
      input.dateAt !== undefined ||
      input.dateAllDay !== undefined ||
      input.listCategory !== undefined ||
      input.fields !== undefined)
  )
    return yield* teamRefused;
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
  const row = yield* inList(input.orgId, input.key, "work");
  if (viewer.teammate) yield* teamWritable(person, row);
  const partyId = yield* refId(viewer, input.orgId, input.party, "clients");
  const projectId = yield* refId(viewer, input.orgId, input.project, "projects");
  const defined = !isBuiltIn(row.registerId);
  if (!defined && (input.fields !== undefined || input.listCategory !== undefined))
    return yield* new KinChatError({
      reason: "invalid_state",
      message: `${row.key} is a Work entry; it has no list details or list category.`,
    });
  const sql = yield* SqlClient.SqlClient;
  const save = change(
    viewer,
    input.orgId,
    input.key,
    {
      ...(input.listCategory === undefined ? {} : { category: input.listCategory }),
      ...(input.fields === undefined ? {} : { fields: input.fields }),
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
  if (input.fields === undefined) return yield* save;
  // The files are checked and kept in one transaction, so none slips in between the two.
  return yield* sql
    .withTransaction(ownFiles(person, row.fieldsJson, input.fields).pipe(Effect.andThen(save)))
    .pipe(workFailure);
});

/**
 * The files an owner's edit adds are ones the owner can read: each on a message, not deleted, in
 * a chat the owner is in. Anything else looks like no file at all.
 */
const ownFiles = Effect.fn("KinWork.ownFiles")(function* (
  person: PersonIdentity,
  storedJson: string,
  fields: Readonly<Record<string, unknown>>,
) {
  const stored = parseFields(storedJson);
  const added = [
    ...new Set(
      Object.entries(fields).flatMap(([key, value]) =>
        Array.isArray(value)
          ? value.filter(
              (id): id is string => typeof id === "string" && !fieldList(stored, key).includes(id),
            )
          : [],
      ),
    ),
  ];
  if (added.length === 0) return;
  const sql = yield* SqlClient.SqlClient;
  const mine = yield* sql`SELECT a.attachment_id FROM kin_message_attachments a
    JOIN kin_messages ON kin_messages.org_id = a.org_id
      AND kin_messages.message_id = a.message_id
    JOIN kin_chat_members c ON c.org_id = a.org_id AND c.chat_id = a.chat_id
      AND c.principal_kind = 'person' AND c.person_id = ${person.personId} AND c.left_at IS NULL
    WHERE a.org_id = ${person.orgId} AND a.attachment_id IN ${sql.in(added)}
      AND kin_messages.status <> 'deleted'
      AND ${readableFrom(sql, person.orgId, sql`COALESCE(c.joined_seq, 0)`)}`;
  if (mine.length !== added.length)
    return yield* new KinChatError({ reason: "not_found", message: "No such file in your chats." });
});

/** Keeps a lead's suggestion: it counts as the owner's from now on. */
export const confirm = Effect.fn("KinWork.confirm")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinWorkConfirmInput,
) {
  const person = yield* theOwner(people, input.orgId);
  return yield* change(
    { person, teammate: false },
    input.orgId,
    input.key,
    { confirmed: true },
    input.rev,
  );
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
  return yield* change(
    { person, teammate: false },
    input.orgId,
    input.key,
    { state: "dropped" },
    input.rev,
  );
});

const change = Effect.fn("KinWork.change")(function* (
  viewer: Viewer,
  orgId: KinOrgId,
  key: string,
  patch: Patch,
  rev: number | undefined,
) {
  const records = yield* KinRecords;
  const row = yield* records.update(orgId, ownerWriter(viewer.person), key, patch, rev);
  return yield* shownTo(viewer, yield* records.detail(row, KIN_RECORD_CHANGES_CAP), row);
});

/**
 * The owner shares tasks with the team or takes them back; taken back, a task stays visible only
 * to the teammate who holds it, made it or gave it away. Labelling one sensitive hides it from all.
 */
export const share = Effect.fn("KinWork.share")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinWorkShareInput,
) {
  const person = yield* theOwner(people, input.orgId);
  const records = yield* KinRecords;
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql
    .withTransaction(
      Effect.forEach([...new Set(input.keys)], (key) =>
        inList(input.orgId, key, "work").pipe(
          Effect.flatMap((row) =>
            row.registerId === "work"
              ? records.update(input.orgId, ownerWriter(person), key, { team: input.shared })
              : Effect.fail(
                  new KinChatError({
                    reason: "invalid_state",
                    message: `${key.slice(0, 40)} is in a list, and only tasks are shared yet.`,
                  }),
                ),
          ),
        ),
      ),
    )
    .pipe(workFailure);
  const now = yield* Clock.currentTimeMillis;
  return { records: rows.map((row) => toRecord(row, now)) };
});

export const dueMillis = Effect.fn("KinWork.dueMillis")(function* (
  orgId: KinOrgId,
  dueAt: string,
  allDay: boolean | undefined,
) {
  return allDay === true && isCalendarDay(dueAt)
    ? endOfDay(dueAt, yield* ownerZone(orgId))
    : yield* millis(dueAt, "dueAt");
});

export const ownerWriter = (person: PersonIdentity): Writer => ({
  actor: { _tag: "person", personId: person.personId },
  via: "owner",
  askedBy: person.personId,
});
