import {
  kinCurrenciesWithDecimals,
  KinChatError,
  type KinOrgId,
  type KinRecordId,
  type KinRecordKey,
  type KinPersonId,
  type KinRecord,
  type KinRecordChange,
  type KinRecordDetail,
  type KinRecordCan,
  type KinRecordLink,
  KIN_RECORD_LINKED_FROM_CAP,
  type KinRecordState,
  type KinWorkPrincipal,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";

import { LISTS } from "./lists.ts";
import {
  inheritedSensitive,
  iso,
  keySensitive,
  notFound,
  samePrincipal,
  sensitiveNow,
} from "./recordRows.ts";

/** Lists a project's lead writes in, inside that project; quotes and invoices only as drafts. */
const LEAD_LISTS = ["work", "milestones", "docs", "quotes", "invoices"] as const;
const DRAFT_LISTS = ["quotes", "invoices"] as const;
/** Registers that are not one of the company's lists of money and records. */
const NOT_LISTS = [
  "work",
  "milestones",
  "docs",
  "clients",
  "contacts",
  "projects",
  "deals",
  "bank_transactions",
];

/** A place the owner switched on for this person (`kin_people.sees_*`). */
const placeOn = (
  sql: SqlClient.SqlClient,
  personId: KinPersonId | Statement.Fragment,
  place: "sees_clients" | "sees_docs" | "sees_money",
) =>
  sql`EXISTS (SELECT 1 FROM kin_people sp WHERE sp.org_id = r.org_id AND sp.person_id = ${personId}
    AND sp.${sql.literal(place)} = 1)`;

/**
 * `r` carries no label of the owner's own: money lists label every entry sensitive by default
 * (`registers.ts`), which hides it from no one the owner let see it.
 */
const ownLabelOff = (sql: SqlClient.SqlClient) =>
  sql`(r.sensitive = 0 OR EXISTS (SELECT 1 FROM kin_registers g WHERE g.org_id = r.org_id
    AND g.register_id = r.register_id AND g.built_in = 0
    AND json_extract(g.definition_json, '$.sensitive') = 1))`;

/** `r` is a project this person leads, filed under one, or its client or a contact of it. */
const inLedProject = (sql: SqlClient.SqlClient, personId: KinPersonId | Statement.Fragment) =>
  sql`EXISTS (SELECT 1 FROM kin_records lp WHERE lp.org_id = r.org_id
    AND lp.register_id = 'projects' AND lp.owner_kind = 'person' AND lp.owner_id = ${personId}
    AND (lp.record_id = r.record_id OR lp.record_id = r.project_id
      OR (r.register_id = 'clients' AND lp.party_id = r.record_id)
      OR (r.register_id = 'contacts' AND lp.party_id = r.party_id)))`;

/** `r`'s project (or `r`, given `r.record_id`) names this person among its `fields.members`. */
const onProject = (
  sql: SqlClient.SqlClient,
  personId: KinPersonId | Statement.Fragment,
  project = sql`r.project_id`,
) =>
  sql`EXISTS (SELECT 1 FROM kin_records mp, json_each(mp.fields_json, '$.members') m
    WHERE mp.org_id = r.org_id AND mp.register_id = 'projects' AND mp.record_id = ${project}
      AND m.value = 'person:' || ${personId})`;

/** `r` is filed under (or is) a project this person leads, is a member of, or holds a task in. */
const projectPerson = (
  sql: SqlClient.SqlClient,
  personId: KinPersonId | Statement.Fragment,
  project = sql`r.project_id`,
) =>
  sql`(${onProject(sql, personId, project)} OR EXISTS (SELECT 1 FROM kin_records pw
    WHERE pw.org_id = r.org_id AND pw.owner_kind = 'person' AND pw.owner_id = ${personId}
      AND ((pw.register_id = 'work' AND pw.project_id = ${project})
        OR (pw.register_id = 'projects' AND pw.record_id = ${project}))))`;

/** `r` is a meeting this person is one of the people at (`fields.attendees`). */
const attends = (sql: SqlClient.SqlClient, personId: KinPersonId | Statement.Fragment) =>
  sql`EXISTS (SELECT 1 FROM json_each(r.fields_json, '$.attendees') a
    WHERE a.value = 'person:' || ${personId})`;

/**
 * What a non-owner-level person sees everywhere: a task they hold, attend or marked private; unlabelled,
 * what they made, gave or share, their projects with those projects' entries and docs (never a
 * private task), company docs with Docs on, and with Clients on the deals of clients they see.
 */
export const personSees = (sql: SqlClient.SqlClient, personId: KinPersonId | Statement.Fragment) =>
  sql`((r.register_id = 'work' AND ((r.owner_kind = 'person' AND r.owner_id = ${personId})
      OR ${attends(sql, personId)} OR r.marked_by_person_id = ${personId}
      OR (r.sensitive = 0 AND ((r.created_by_kind = 'person' AND r.created_by_id = ${personId})
        OR r.assigned_by_person_id = ${personId}))))
  OR (r.register_id IN ('work', 'milestones') AND r.sensitive = 0
    AND (r.team_shared = 1 OR ${onProject(sql, personId)}))
  OR (${ownLabelOff(sql)} AND r.register_id <> 'bank_transactions'
    AND ${inLedProject(sql, personId)})
  OR (NOT ${sensitiveNow(sql)} AND (
    (r.register_id = 'projects' AND ${onProject(sql, personId, sql`r.record_id`)})
    OR (r.register_id IN ('clients', 'contacts') AND ${placeOn(sql, personId, "sees_clients")})
    OR (r.register_id = 'docs' AND r.project_id IS NOT NULL AND ${projectPerson(sql, personId)})
    OR (r.register_id = 'docs' AND (r.team_shared = 1
      OR json_extract(r.fields_json, '$.home') = 'company')
      AND ${placeOn(sql, personId, "sees_docs")})))
  OR (r.register_id = 'deals' AND NOT ${keySensitive(sql)}
    AND ${placeOn(sql, personId, "sees_clients")})
  OR (r.register_id NOT IN ${sql.in(NOT_LISTS)} AND r.team_shared = 1 AND ${ownLabelOff(sql)}
    AND NOT ${inheritedSensitive(sql)} AND ${placeOn(sql, personId, "sees_money")}))`;

/** `personSees` over another alias of `kin_records`, such as a directory's `c` or `p`. */
export const personSeesAs = (sql: SqlClient.SqlClient, personId: KinPersonId, alias: string) =>
  sql`EXISTS (SELECT 1 FROM kin_records r WHERE r.org_id = ${sql(alias)}.org_id
    AND r.record_id = ${sql(alias)}.record_id AND ${personSees(sql, personId)})`;

/**
 * `r` is money: an entry of one of the company's lists (quotes, invoices, receipts and the rest),
 * or a doc that is a quote or was made from such an entry.
 */
const moneyKind = (sql: SqlClient.SqlClient) =>
  sql`(r.register_id NOT IN ${sql.in(NOT_LISTS.filter((one) => one !== "bank_transactions"))}
    OR (r.register_id = 'docs' AND (r.category = 'quote' OR EXISTS (SELECT 1
      FROM kin_doc_versions mv
      JOIN kin_doc_jobs mj ON mj.org_id = mv.org_id AND mj.worker_id = mv.worker_id
      JOIN kin_records me ON me.org_id = mj.org_id AND me.record_id = mj.entry_record_id
      WHERE mv.org_id = r.org_id AND mv.record_id = r.record_id
        AND me.register_id NOT IN ${sql.in(NOT_LISTS)}))))`;

/**
 * What Clients shows this person of `r`'s money: all of it with the Money switch, none without,
 * whichever project they lead. Money's own screens keep `personSees`.
 */
export const clientMoneySeen = (
  sql: SqlClient.SqlClient,
  personId: KinPersonId | Statement.Fragment,
) => sql`(NOT ${moneyKind(sql)} OR ${placeOn(sql, personId, "sees_money")})`;

/**
 * What a member reads in Clients (rows, counts, next steps, contact, history, contacts): what
 * `personSees` shows them, less anything labelled itself or through its client or project, tasks
 * included, and less money without the Money switch. Tasks keeps `personSees`.
 */
export const crmSees = (sql: SqlClient.SqlClient, personId: KinPersonId) =>
  sql`(${personSees(sql, personId)} AND NOT ${keySensitive(sql)}
    AND ${clientMoneySeen(sql, personId)})`;

/** `crmSees` for every one of a viewer's people; the owner level reads everything. */
export const crmSeenBy = (sql: SqlClient.SqlClient, viewer: KinViewer) =>
  viewer._tag === "ownerLevel"
    ? sql`1 = 1`
    : viewer.people.length === 0
      ? sql`0 = 1`
      : sql`(${sql.and(viewer.people.map((person) => crmSees(sql, person)))})`;

/** `crmSees` over another alias of `kin_records`, such as the directory's `c`. */
export const crmSeesAs = (sql: SqlClient.SqlClient, personId: KinPersonId, alias: string) =>
  sql`EXISTS (SELECT 1 FROM kin_records r WHERE r.org_id = ${sql(alias)}.org_id
    AND r.record_id = ${sql(alias)}.record_id AND ${crmSees(sql, personId)})`;

/** Of these, the ones this member may see in Clients (`crmSees`), read through the caller's transaction. */
export const crmVisible = Effect.fn("KinTeamView.crmVisible")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  recordIds: ReadonlyArray<string>,
) {
  if (recordIds.length === 0) return new Set<string>();
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ recordId: string }>`SELECT r.record_id AS "recordId" FROM kin_records r
    WHERE r.org_id = ${orgId} AND r.record_id IN ${sql.in([...new Set(recordIds)])}
      AND ${crmSees(sql, personId)}
    ORDER BY r.record_id`;
  return new Set(rows.map((row) => row.recordId));
});

/** Of these, the clients and prospects this person reaches through their Clients switch. */
export const teamClients = Effect.fn("KinTeamView.clients")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  recordIds: ReadonlyArray<string>,
) {
  if (recordIds.length === 0) return new Set<string>();
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ recordId: string }>`SELECT r.record_id AS "recordId" FROM kin_records r
    WHERE r.org_id = ${orgId} AND r.record_id IN ${sql.in([...new Set(recordIds)])}
      AND r.register_id = 'clients' AND ${placeOn(sql, personId, "sees_clients")}
      AND ${crmSees(sql, personId)}
    ORDER BY r.record_id`;
  return new Set(rows.map((row) => row.recordId));
});

/**
 * Of these clients (by id or key), the ones a task of theirs may name to this person: one their
 * Clients switch reaches, or one whose name they see through a project they lead (`personSees`).
 */
export const taskClients = Effect.fn("KinTeamView.taskClients")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  refs: ReadonlyArray<string>,
) {
  if (refs.length === 0) return new Set<string>();
  const sql = yield* SqlClient.SqlClient;
  const asked = [...new Set(refs)];
  const rows = yield* sql<{ recordId: string; key: string }>`SELECT r.record_id AS "recordId",
      r.key FROM kin_records r
    WHERE r.org_id = ${orgId} AND r.register_id = 'clients'
      AND (r.record_id IN ${sql.in(asked)} OR r.key IN ${sql.in(asked)})
      AND ${personSees(sql, personId)}
    ORDER BY r.record_id`;
  return new Set(rows.flatMap((row) => [row.recordId, row.key]));
});

/** The places this person has beyond Tasks, and the projects they lead, read per request. */
export const placesOf = Effect.fn("KinTeamView.placesOf")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ clients: number; docs: number; money: number }>`SELECT
      sees_clients AS clients, sees_docs AS docs, sees_money AS money
    FROM kin_people WHERE org_id = ${orgId} AND person_id = ${personId}`;
  const leads = yield* ledProjects(orgId, personId);
  const lead = leads.length > 0;
  // Someone on a project reads its docs without the Docs place, so they reach the screen too.
  const [onOne] = yield* sql`SELECT 1 FROM kin_records r
    WHERE r.org_id = ${orgId} AND r.register_id = 'docs' AND r.project_id IS NOT NULL
      AND ${projectPerson(sql, personId)} LIMIT 1`;
  return {
    clients: row?.clients === 1,
    docs: row?.docs === 1,
    money: row?.money === 1,
    leads,
    /** Whether they have the place at all: switched on, or leading a project that has one. */
    reaches: {
      clients: row?.clients === 1 || lead,
      docs: row?.docs === 1 || lead || onOne !== undefined,
      money: row?.money === 1 || lead,
    },
  };
});

/** The projects this person leads, by name. */
export const ledProjects = Effect.fn("KinTeamView.ledProjects")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ recordId: KinRecordId; key: KinRecordKey; title: string }>`SELECT
      record_id AS "recordId", key, title FROM kin_records
    WHERE org_id = ${orgId} AND register_id = 'projects' AND owner_kind = 'person'
      AND owner_id = ${personId}
    ORDER BY lower(title), key`;
});

/**
 * A row a shared turn reads whole: a doc or list entry they all see, or a task of a project every
 * one of them leads. Anything else they read as a teammate (`teamRecord`, `teamChanges`).
 */
export const viewReadsWhole = Effect.fn("KinTeamView.readsWhole")(function* (
  orgId: KinOrgId,
  people: ReadonlyArray<KinPersonId>,
  row: { readonly registerId: string; readonly projectId: string | null | undefined },
) {
  if (row.registerId === "clients" || row.registerId === "contacts") return false;
  if (row.registerId !== "work") return true;
  const projectId = row.projectId;
  if (projectId === null || projectId === undefined || people.length === 0) return false;
  for (const person of people) {
    const led = yield* ledProjects(orgId, person);
    if (!led.some((project) => project.recordId === projectId)) return false;
  }
  return true;
});

/** What every one of these people sees: a turn's view (`turnPeople`). None sees nothing. */
export const viewSees = (sql: SqlClient.SqlClient, people: ReadonlyArray<KinPersonId>) =>
  people.length === 0
    ? sql`0 = 1`
    : sql`(${sql.and(people.map((person) => personSees(sql, person)))})`;

/**
 * Who a read is for. Every read model a person reaches takes one (`t3code/kin-viewer-scoped-reads`):
 * `people` reads what every one of them sees, `ownerLevel` everything.
 */
export type KinViewer =
  | { readonly _tag: "ownerLevel" }
  | { readonly _tag: "people"; readonly people: ReadonlyArray<KinPersonId> };
/** The unscoped read: the owner, a co-owner, or Kin's own work for them. */
export const KIN_OWNER_LEVEL: KinViewer = { _tag: "ownerLevel" };
export const viewerOfPeople = (people: ReadonlyArray<KinPersonId>): KinViewer => ({
  _tag: "people",
  people,
});
/** Entries `r` this viewer sees. */
export const seenBy = (sql: SqlClient.SqlClient, viewer: KinViewer) =>
  viewer._tag === "ownerLevel" ? sql`1 = 1` : viewSees(sql, viewer.people);

/** Whether every one of these people may see this entry now. */
export const viewVisible = Effect.fn("KinTeamView.viewVisible")(function* (
  orgId: KinOrgId,
  people: ReadonlyArray<KinPersonId>,
  recordId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`SELECT 1 FROM kin_records r
    WHERE r.org_id = ${orgId} AND r.record_id = ${recordId} AND ${viewSees(sql, people)} LIMIT 1`;
  return rows.length > 0;
});

/**
 * A turn's write in a chat others read, inside its transaction. A task, meeting or milestone that
 * everyone there sees, and stays shared, may be made or changed for any of them (`roomWork`);
 * anything else only as each person behind it could on their own screens.
 */
export const viewGuard = Effect.fn("KinTeamView.viewGuard")(function* (
  orgId: KinOrgId,
  view: {
    readonly people: ReadonlyArray<KinPersonId>;
    readonly askers: ReadonlyArray<KinPersonId>;
  },
  write: Parameters<typeof teamGuard>[2],
) {
  if (view.people.length === 0) return yield* noLongerTeam;
  if (yield* roomWork(orgId, view.people, write)) return;
  for (const person of view.people)
    yield* teamGuard(orgId, person, {
      ...write,
      changes: write.changes && view.askers.includes(person),
    });
});

/** Lists a turn others read writes for the room, shared with the team (`KinRecords.insert`). */
export const ROOM_LISTS = ["work", "milestones"] as const;
/** What a room's write never sets: labels, sharing, money, repeats, sources, links, lists. */
const ROOM_REFUSED = [
  "sensitive",
  "team",
  "confirmed",
  "amount",
  "repeat",
  "source",
  "links",
] as const;
const ROOM_FIELDS: ReadonlySet<string> = new Set(LISTS.work.fields);

/** Whether the write is team-visible work everyone behind the turn sees, before and after. */
const roomWork = Effect.fn("KinTeamView.roomWork")(function* (
  orgId: KinOrgId,
  people: ReadonlyArray<KinPersonId>,
  write: Parameters<typeof teamGuard>[2],
) {
  const { row, input } = write;
  if (ROOM_REFUSED.some((field) => input[field] !== undefined)) return false;
  const fields = input.fields;
  if (
    fields !== undefined &&
    (typeof fields !== "object" ||
      fields === null ||
      Object.keys(fields).some((key) => !ROOM_FIELDS.has(key)))
  )
    return false;
  const sql = yield* SqlClient.SqlClient;
  const letIn = yield* sql<{ personId: string }>`SELECT DISTINCT b.person_id AS "personId"
    FROM kin_session_bindings b WHERE b.org_id = ${orgId} AND b.revoked_at IS NULL
      AND b.person_id IN ${sql.in(people)} ORDER BY b.person_id`;
  if (letIn.length !== new Set(people).size) return yield* noLongerTeam;
  // A client set or changed for the room is one each of them could set on their own screen.
  if (input.partyId !== undefined)
    for (const person of people) {
      const facts = yield* teamFactsOf(
        orgId,
        person,
        row === undefined ? [] : [row.recordId],
        typeof input.partyId === "string" ? [input.partyId] : [],
      );
      if (!clientFits(facts(row?.recordId), input)) return false;
    }
  if (row === undefined) {
    const list = typeof input.list === "string" ? input.list : "work";
    return (ROOM_LISTS as ReadonlyArray<string>).includes(list);
  }
  if (input.list !== undefined) return false;
  const seen = yield* sql`SELECT 1 FROM kin_records r WHERE r.org_id = ${orgId}
    AND r.record_id = ${row.recordId} AND r.register_id IN ${sql.in(ROOM_LISTS)}
    AND r.sensitive = 0 AND ${viewSees(sql, people)} LIMIT 1`;
  return seen.length > 0;
});

/**
 * A teammate changes only a task they hold, gave to whoever holds it or marked private, never one
 * they only see; a project's lead also anything of the project in `LEAD_LISTS`, quotes and
 * invoices as drafts.
 */
const teamWrites = (sql: SqlClient.SqlClient, personId: KinPersonId) =>
  sql`(${personSees(sql, personId)} AND ((r.owner_kind = 'person' AND r.owner_id = ${personId})
    OR r.assigned_by_person_id = ${personId} OR r.marked_by_person_id = ${personId}
    OR ${leadWrites(sql, personId)}))`;

const leadWrites = (sql: SqlClient.SqlClient, personId: KinPersonId) =>
  sql`(${ownLabelOff(sql)} AND r.register_id IN ${sql.in(LEAD_LISTS)}
    AND (r.register_id NOT IN ${sql.in(DRAFT_LISTS)} OR r.state = 'open')
    AND ${inLedProject(sql, personId)})`;

/** Whether this person leads, is a member of, or holds a task in this unlabelled project. */
export const inProject = Effect.fn("KinTeamView.inProject")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  projectId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql`SELECT 1 FROM kin_records r WHERE r.org_id = ${orgId}
    AND r.record_id = ${projectId} AND r.register_id = 'projects' AND r.sensitive = 0
    AND ${projectPerson(sql, personId, sql`r.record_id`)}`;
  return row !== undefined;
});

/** The record ids of these this teammate may see, read through the caller's transaction. */
export const teamVisible = Effect.fn("KinTeamView.visible")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  recordIds: ReadonlyArray<string>,
) {
  if (recordIds.length === 0) return new Set<string>();
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ recordId: string }>`SELECT r.record_id AS "recordId" FROM kin_records r
    WHERE r.org_id = ${orgId} AND r.record_id IN ${sql.in([...new Set(recordIds)])}
      AND ${personSees(sql, personId)}
    ORDER BY r.record_id`;
  return new Set(rows.map((row) => row.recordId));
});

/**
 * The entries and docs linking to this one that `viewer` sees, newest first, and how many more.
 * One that this one links back to is in its own `links` already, so it is left out here.
 */
export const linkedFromOf = Effect.fn("KinTeamView.linkedFrom")(function* (
  orgId: KinOrgId,
  recordId: string,
  viewer: KinViewer,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    relation: KinRecordLink["relation"];
    createdAt: number;
    recordId: KinRecordId;
    key: KinRecordKey;
    title: KinRecord["title"];
    total: number;
  }>`SELECT l.relation, l.created_at AS "createdAt", r.record_id AS "recordId", r.key, r.title,
      COUNT(*) OVER () AS total
    FROM kin_record_links l
    JOIN kin_records r ON r.org_id = l.org_id AND r.record_id = l.record_id
    WHERE l.org_id = ${orgId} AND l.kind = 'record' AND l.target = ${recordId}
      AND NOT EXISTS (SELECT 1 FROM kin_record_links b WHERE b.org_id = l.org_id
        AND b.record_id = l.target AND b.kind = 'record' AND b.target = l.record_id)
      AND ${seenBy(sql, viewer)}
    ORDER BY l.created_at DESC, r.key
    LIMIT ${KIN_RECORD_LINKED_FROM_CAP}`;
  const more = (rows[0]?.total ?? 0) - rows.length;
  return {
    ...(rows.length === 0
      ? {}
      : {
          linkedFrom: rows.map((row): KinRecordLink => ({
            kind: "record",
            relation: row.relation,
            target: row.recordId,
            chatId: null,
            label: null,
            createdAt: iso(row.createdAt),
            record: { recordId: row.recordId, key: row.key, title: row.title },
          })),
        }),
    ...(more > 0 ? { linkedFromMore: more } : {}),
  } satisfies Pick<KinRecordDetail, "linkedFrom" | "linkedFromMore">;
});

export const TEAM_REFUSED = new KinChatError({
  reason: "not_allowed",
  message: "Only the owner or a co-owner changes that.",
});
const REPEAT_REFUSED = new KinChatError({
  reason: "not_allowed",
  message: "Only the owner, a co-owner or whoever gave the task changes how it repeats.",
});
const noLongerTeam = new KinChatError({
  reason: "not_allowed",
  message: "Only the owner or a co-owner can do that in Work.",
});

/** What a teammate's write may never touch: labels, sharing, money, list detail, clients, projects. */
const OWNERS_FIELDS = [
  "sensitive",
  "team",
  "confirmed",
  "amount",
  "repeat",
  "dateAt",
  "dateAllDay",
  "fields",
  "partyId",
  "projectId",
  "list",
  "source",
  "links",
] as const;

/** A write that changes only who is on a project (`fields.members`): its lead may make it. */
const peopleOnly = (input: TeamWrite["input"]) => {
  const { fields, ...rest } = input;
  return (
    typeof fields === "object" &&
    fields !== null &&
    Object.keys(fields).length > 0 &&
    Object.keys(fields).every((key) => key === "members") &&
    Object.values(rest).every((value) => value === undefined)
  );
};

/** What a lead's write in their project still leaves to the owner: links, sources and clients. */
const LEADS_REFUSED = ["confirmed", "repeat", "partyId", "source", "links"] as const;
const DRAFTS_ONLY = new KinChatError({
  reason: "not_allowed",
  message:
    "Only the owner or a co-owner issues, sends or marks a quote or invoice paid; a project's lead keeps it a draft (state open).",
});

type TeamWrite = {
  readonly row: { readonly recordId: string; readonly key: string } | undefined;
  /** A change to the task, not a retry of the create that made it. */
  readonly changes: boolean;
  readonly input: Readonly<Partial<Record<(typeof OWNERS_FIELDS)[number] | "state", unknown>>>;
};

/** What `teamRule` decides these entries' writes on: read once, inside the write's transaction. */
const teamFactsOf = Effect.fn("KinTeamView.facts")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  recordIds: ReadonlyArray<string>,
  /** Clients a write would put an entry under. */
  partyIds: ReadonlyArray<string> = [],
) {
  const sql = yield* SqlClient.SqlClient;
  const member = yield* sql`SELECT 1 FROM kin_session_bindings b
    JOIN kin_people p ON p.org_id = b.org_id AND p.person_id = b.person_id
    WHERE b.org_id = ${orgId} AND b.person_id = ${personId} AND b.revoked_at IS NULL LIMIT 1`;
  const led = new Set((yield* ledProjects(orgId, personId)).map((project) => project.recordId));
  const seen =
    recordIds.length === 0
      ? []
      : yield* sql<{
          recordId: string;
          writes: number;
          leads: number;
          marked: number;
          gave: number;
          registerId: string;
          partyId: string | null;
          projectId: string | null;
          projectPartyId: string | null;
        }>`SELECT
          r.record_id AS "recordId", ${teamWrites(sql, personId)} AS writes,
          r.party_id AS "partyId", r.project_id AS "projectId",
          (SELECT p.party_id FROM kin_records p WHERE p.org_id = r.org_id
            AND p.record_id = r.project_id) AS "projectPartyId",
          COALESCE(r.assigned_by_person_id = ${personId}, 0) AS gave,
          ${leadWrites(sql, personId)} AS leads,
          COALESCE(r.marked_by_person_id = ${personId}, 0) AS marked, r.register_id AS "registerId"
        FROM kin_records r WHERE r.org_id = ${orgId}
          AND r.record_id IN ${sql.in([...new Set(recordIds)])} AND ${personSees(sql, personId)}
        ORDER BY r.record_id`;
  const byId = new Map(seen.map((row) => [row.recordId, row]));
  const [switched] = yield* sql<{ on: number }>`SELECT sees_clients AS "on" FROM kin_people
    WHERE org_id = ${orgId} AND person_id = ${personId}`;
  const clients = {
    on: switched?.on === 1,
    seen: yield* teamClients(orgId, personId, [
      ...partyIds,
      ...seen.flatMap((row) => (row.partyId === null ? [] : [row.partyId])),
    ]),
  };
  /** One entry's facts; `undefined` for a write that makes one. */
  return (recordId: string | undefined) => ({
    member: member.length > 0,
    led,
    clients,
    seen: recordId === undefined ? undefined : (byId.get(recordId) ?? null),
  });
});
type TeamFacts = ReturnType<Effect.Success<ReturnType<typeof teamFactsOf>>>;

/**
 * Whether a teammate's write goes through, and the refusal when it doesn't: they are still let in,
 * the task is one they see (else it is no task at all) and, for a change, one they hold or gave
 * away, or one of a project they lead. Both the write (`teamGuard`) and what a sheet offers
 * (`teamCan`) ask this, so a control the host offers is one it takes.
 */
const teamRule = (facts: TeamFacts, write: TeamWrite): KinChatError | undefined => {
  if (!facts.member) return noLongerTeam;
  const { row } = write;
  // Whoever marked it "Only me" may take their own mark off again.
  const unmarked =
    write.input.sensitive === false && facts.seen?.marked === 1
      ? { ...write.input, sensitive: undefined }
      : write.input;
  // Whoever gives a task says whether it comes back; one they make (or retry making) they give.
  const task =
    row === undefined || !write.changes
      ? (typeof unmarked.list === "string" ? unmarked.list : "work") === "work"
      : facts.seen?.registerId === "work" && facts.seen.gave === 1;
  const own = task ? { ...unmarked, repeat: undefined } : unmarked;
  const fits = clientFits(facts, own);
  if (
    fits &&
    row !== undefined &&
    leavesProject(facts, write.changes, own) &&
    teamRule(facts, { ...write, input: { ...own, partyId: undefined, projectId: null } }) !==
      undefined
  )
    return keepsProject(row.key);
  const input = fits ? { ...own, partyId: undefined } : own;
  if (
    !task &&
    unmarked.repeat !== undefined &&
    row !== undefined &&
    facts.seen?.registerId === "work"
  )
    return REPEAT_REFUSED;
  if (row !== undefined && facts.led.has(row.recordId as KinRecordId) && peopleOnly(input))
    return facts.seen === null || facts.seen === undefined ? notFound(row.key) : undefined;
  const intoLed = input.projectId === undefined || facts.led.has(input.projectId as KinRecordId);
  let lead: { readonly draft: boolean } | undefined;
  if (row !== undefined) {
    const seen = facts.seen;
    if (seen === undefined || seen === null) return notFound(row.key);
    if (write.changes && seen.writes !== 1)
      return new KinChatError({
        reason: "not_allowed",
        message: `Only whoever holds ${row.key}, or gave it to them, can change it.`,
      });
    if (seen.leads === 1 && intoLed)
      lead = { draft: (DRAFT_LISTS as ReadonlyArray<string>).includes(seen.registerId) };
    if (lead !== undefined && input.list !== undefined) return TEAM_REFUSED;
  } else {
    const list = typeof input.list === "string" ? input.list : "work";
    if (
      input.projectId !== undefined &&
      intoLed &&
      (LEAD_LISTS as ReadonlyArray<string>).includes(list)
    )
      lead = { draft: (DRAFT_LISTS as ReadonlyArray<string>).includes(list) };
  }
  if (lead === undefined)
    return OWNERS_FIELDS.some((field) => input[field] !== undefined) ? TEAM_REFUSED : undefined;
  // Making something more private is always theirs; un-marking it is the owner's.
  if (LEADS_REFUSED.some((field) => input[field] !== undefined) || input.sensitive === false)
    return TEAM_REFUSED;
  // An invoice is made issued unless it says otherwise, so a lead's new one must say draft.
  if (lead.draft && (row === undefined ? input.state !== "open" : input.state !== undefined))
    return DRAFTS_ONLY;
  return undefined;
};

/** A new client that isn't its project's takes a task out of that project (`KinRecords.update`). */
const leavesProject = (facts: TeamFacts, changes: boolean, input: TeamWrite["input"]) => {
  const seen = facts.seen;
  return (
    changes &&
    seen !== undefined &&
    seen !== null &&
    typeof input.partyId === "string" &&
    input.projectId === undefined &&
    seen.projectPartyId !== null &&
    seen.projectPartyId !== input.partyId &&
    seen.partyId !== input.partyId
  );
};
const keepsProject = (key: string) =>
  new KinChatError({
    reason: "not_allowed",
    message: `${key} is part of a project for another client, so it keeps that client. The owner or a co-owner can take it out of the project first.`,
  });

/**
 * With the Clients switch on, a task of theirs may name a client they see, or drop one they see.
 * Anything else about the client stays the owner's (`OWNERS_FIELDS`).
 */
const clientFits = (facts: TeamFacts, input: TeamWrite["input"]) => {
  const { partyId } = input;
  if (partyId === undefined || !facts.clients.on) return false;
  const task =
    facts.seen === undefined
      ? (typeof input.list === "string" ? input.list : "work") === "work"
      : facts.seen?.registerId === "work";
  if (!task) return false;
  const now = facts.seen?.partyId ?? null;
  if (partyId === null) return now === null || facts.clients.seen.has(now);
  return typeof partyId === "string" && facts.clients.seen.has(partyId);
};

/**
 * A teammate's write, checked inside its transaction before any retry, revision or other answer.
 * The repository runs this, so no caller's earlier read decides it.
 */
export const teamGuard = Effect.fn("KinTeamView.guard")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  write: TeamWrite,
) {
  const facts = yield* teamFactsOf(
    orgId,
    personId,
    write.row === undefined ? [] : [write.row.recordId],
    typeof write.input.partyId === "string" ? [write.input.partyId] : [],
  );
  const refused = teamRule(facts(write.row?.recordId), {
    ...write,
    input: yield* promiseParts(orgId, personId, write),
  });
  if (refused !== undefined) return yield* refused;
});

/**
 * A new task on a client this teammate sees in Clients may say where it was promised
 * (`fields.from`) and sit on one of that client's deals they see (`promises.ts`); those parts
 * are theirs to set, and the rest of the write is decided as any other.
 */
const promiseParts = Effect.fn("KinTeamView.promiseParts")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  write: TeamWrite,
) {
  const { input } = write;
  const { fields, links, list, ...rest } = input;
  if (write.row !== undefined || typeof input.partyId !== "string") return input;
  if ((typeof list === "string" ? list : "work") !== "work") return input;
  if (fields === undefined && links === undefined) return input;
  const fromOnly =
    fields === undefined ||
    (typeof fields === "object" &&
      fields !== null &&
      Object.keys(fields).every((key) => key === "from"));
  const deals = Array.isArray(links) ? (links as ReadonlyArray<Record<string, unknown>>) : [];
  if (!fromOnly || (links !== undefined && !Array.isArray(links))) return input;
  if (deals.some((link) => link.kind !== "record" || link.relation !== "relates")) return input;
  const targets = deals.map((link) => String(link.target));
  if (targets.length > 0) {
    const sql = yield* SqlClient.SqlClient;
    const onIt = yield* sql<{ recordId: string }>`SELECT r.record_id AS "recordId"
      FROM kin_records r WHERE r.org_id = ${orgId} AND r.register_id = 'deals'
        AND r.party_id = ${input.partyId} AND r.record_id IN ${sql.in(targets)}
        AND ${crmSees(sql, personId)}
      ORDER BY r.record_id`;
    if (onIt.length !== new Set(targets).size) return input;
  }
  return rest;
});

type CanRow = {
  readonly recordId: string;
  readonly key: string;
  readonly state: KinRecordState;
  readonly owner: KinWorkPrincipal;
  /** Its list's states (`checkInput` refuses any other). */
  readonly states: ReadonlyArray<KinRecordState>;
};

/**
 * What a teammate may do to each of these entries, as `teamRule` would answer each write: the
 * same facts, one probe per control, read once for them all.
 */
export const teamCan = Effect.fn("KinTeamView.can")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  rows: ReadonlyArray<CanRow>,
) {
  const factsOf = yield* teamFactsOf(
    orgId,
    personId,
    rows.map((row) => row.recordId),
  );
  return new Map(
    rows.map((row) => {
      const facts = factsOf(row.recordId);
      const takes = (input: TeamWrite["input"]) =>
        teamRule(facts, { row, changes: true, input }) === undefined;
      const open = row.state !== "done" && row.state !== "dropped";
      const led = [...facts.led][0];
      const moves = takes({});
      // Under a project's client, a task's client moves only with the task out of the project.
      const held =
        facts.seen?.projectPartyId !== undefined &&
        facts.seen.projectPartyId !== null &&
        !takes({ projectId: null });
      const can: KinRecordCan = {
        states: row.states.filter((state) => state !== row.state && takes({ state })),
        edit: moves,
        party:
          !held &&
          (takes({ partyId: "" }) ||
            (facts.clients.on && facts.seen?.registerId === "work" && moves)),
        project: led !== undefined && takes({ projectId: led }),
        clearProject: takes({ projectId: null }),
        give: open && moves,
        takeBack: open && moves && !samePrincipal(row.owner, { _tag: "person", personId }),
        mark: takes({ sensitive: true }),
        unmark: takes({ sensitive: false }),
        share: false,
        confirm: false,
        repeat: takes({ repeat: { every: "month" } }),
      };
      return [row.recordId, can] as const;
    }),
  );
});

/** `p` is a teammate who sees `r`: a person let in by an invite, never the owner's own session. */
const teammateSees = (sql: SqlClient.SqlClient) =>
  sql`(EXISTS (SELECT 1 FROM kin_session_bindings b WHERE b.org_id = p.org_id
    AND b.person_id = p.person_id) AND ${personSees(sql, sql`p.person_id`)})`;

/** Who sees which of these entries now, as person and record pairs, through the caller's transaction. */
export const teamPairs = Effect.fn("KinTeamView.pairs")(function* (
  orgId: KinOrgId,
  recordIds: ReadonlyArray<string>,
) {
  if (recordIds.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ personId: string; recordId: string }>`
    SELECT p.person_id AS "personId", r.record_id AS "recordId"
    FROM kin_people p JOIN kin_records r ON r.org_id = p.org_id
    WHERE p.org_id = ${orgId} AND r.record_id IN ${sql.in([...new Set(recordIds)])}
      AND ${teammateSees(sql)}
    ORDER BY p.person_id, r.record_id`;
});

/**
 * The entries whose visibility a client's or project's label, client or lead can change: theirs
 * by any route, and a project's client and that client's contacts.
 */
export const dependents = Effect.fn("KinTeamView.dependents")(function* (
  orgId: KinOrgId,
  recordId: string,
) {
  return (yield* dependentRows(orgId, recordId)).map((row) => row.recordId);
});

/** `dependents`, with each entry's key and list. */
export const dependentRows = Effect.fn("KinTeamView.dependentRows")(function* (
  orgId: KinOrgId,
  recordId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ recordId: string; key: string; registerId: string }>`SELECT
      r.record_id AS "recordId", r.key, r.register_id AS "registerId" FROM kin_records r
    WHERE r.org_id = ${orgId} AND (r.party_id = ${recordId}
      OR r.project_id = ${recordId} OR r.project_id IN (SELECT p.record_id FROM kin_records p
        WHERE p.org_id = r.org_id AND p.register_id = 'projects' AND p.party_id = ${recordId})
      OR r.record_id IN (SELECT p.party_id FROM kin_records p
        WHERE p.org_id = r.org_id AND p.record_id = ${recordId})
      OR (r.register_id = 'contacts' AND r.party_id IN (SELECT p.party_id FROM kin_records p
        WHERE p.org_id = r.org_id AND p.record_id = ${recordId})))
    ORDER BY r.record_id`;
});

/**
 * Moves each person's own change number on by one, in the caller's transaction, and returns the
 * new numbers. A teammate's number counts only changes to tasks they could see before or after.
 */
export const bumpTeamSeqs = Effect.fn("KinTeamView.bump")(function* (
  orgId: KinOrgId,
  personIds: ReadonlyArray<string>,
) {
  if (personIds.length === 0) return new Map<string, number>();
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ personId: string; seq: number }>`
    INSERT INTO kin_team_seqs (org_id, person_id, seq)
    SELECT p.org_id, p.person_id, 1 FROM kin_people p
    WHERE p.org_id = ${orgId} AND p.person_id IN ${sql.in([...new Set(personIds)])}
    ON CONFLICT (org_id, person_id) DO UPDATE SET seq = seq + 1
    RETURNING person_id AS "personId", seq`;
  return new Map(rows.map((row) => [row.personId, row.seq]));
});

/**
 * This teammate's own change number: it moves only when a task they could see changes, so it
 * says nothing of anything else. The owner's number is the org's (`latestSeq`).
 */
export const teamSeq = Effect.fn("KinTeamView.seq")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ seq: number }>`SELECT seq FROM kin_team_seqs
    WHERE org_id = ${orgId} AND person_id = ${personId}`;
  return row?.seq ?? 0;
});

/** Whether this teammate may see the entry with this key now. */
export const teamSeesKey = Effect.fn("KinTeamView.seesKey")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  key: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`SELECT 1 FROM kin_records r
    WHERE r.org_id = ${orgId} AND r.key = ${key} AND ${personSees(sql, personId)} LIMIT 1`;
  return rows.length > 0;
});

/** The keys of every task this teammate may see now, for telling them when one is hidden. */
export const teamKeys = Effect.fn("KinTeamView.keys")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ key: string }>`SELECT r.key FROM kin_records r
    WHERE r.org_id = ${orgId} AND ${personSees(sql, personId)} ORDER BY r.key`;
  return new Set(rows.map((row) => row.key));
});

/** `teamKeys`, with each entry's list. */
export const teamKeyLists = Effect.fn("KinTeamView.keyLists")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ key: string; registerId: string }>`SELECT r.key,
      r.register_id AS "registerId" FROM kin_records r
    WHERE r.org_id = ${orgId} AND ${personSees(sql, personId)} ORDER BY r.key`;
  return new Map(rows.map((row) => [row.key, row.registerId]));
});

/** A Work task as a teammate reads it: no client, project, money, list fields, files or payments. */
export const teamRecord = <
  A extends KinRecord & { readonly files?: unknown; readonly payments?: unknown },
>({
  party: _party,
  project: _project,
  amount: _amount,
  balance: _balance,
  received: _received,
  tdsDeducted: _tds,
  fields: _fields,
  list: _list,
  listCategory: _listCategory,
  dateAt: _dateAt,
  dateAllDay: _dateAllDay,
  sensitiveInherited: _inherited,
  files: _files,
  payments: _payments,
  ...record
}: A) => record;

/**
 * `teamRecord`, keeping its project where the teammate sees that project (`personSees`), and its
 * client where they reach it through their Clients switch (`teamClients`).
 */
export const teamRecordIn = <
  A extends KinRecord & { readonly files?: unknown; readonly payments?: unknown },
>(
  record: A,
  seen: ReadonlySet<string>,
  clients: ReadonlySet<string> = new Set(),
) => {
  const plain = teamRecord(record);
  return {
    ...plain,
    ...(record.project !== undefined && seen.has(record.project.recordId)
      ? { project: record.project }
      : {}),
    ...(record.party !== undefined && clients.has(record.party.recordId)
      ? { party: record.party }
      : {}),
  };
};

/** History lines a teammate reads: what the task says and who holds it, never money or labels. */
const TEAM_FIELDS = new Set([
  "title",
  "state",
  "owner",
  "due",
  "dueAllDay",
  "waitingOn",
  "category",
  "side",
  "repo",
  "notes",
  "confirmed",
  "handedBack",
  "repeat",
]);
export const teamSeesField = (field: string) => TEAM_FIELDS.has(field);
/** Numbered among themselves, newest highest: the org's numbers would show what they can't see. */
export const teamChanges = (changes: ReadonlyArray<KinRecordChange>) => {
  const shown = changes.flatMap((change): ReadonlyArray<KinRecordChange> => {
    if (change.kind === "linked") return [];
    const fields = change.fields.filter((field) => teamSeesField(field.field));
    return change.kind === "updated" && fields.length === 0 ? [] : [{ ...change, fields }];
  });
  return shown.map((change, index) => ({ ...change, seq: shown.length - index }));
};

/**
 * A task's sheet as a teammate reads it. Links keep pull requests, web addresses and tasks they
 * may see; messages, workers and memory are the owner's. Where it was first asked is not theirs.
 */
export const teamDetail = Effect.fn("KinTeamView.detail")(function* (
  detail: KinRecordDetail,
  personId: KinPersonId,
  /** Their own change number, read no later than the sheet. */
  seq: number,
  /** A row of a project they lead, a doc or a list entry: read whole, as its owner does. */
  whole = false,
) {
  const linked = detail.links.flatMap((link) =>
    link.kind === "record" && link.record !== undefined ? [link.record.recordId] : [],
  );
  const visible = yield* teamVisible(detail.orgId, personId, [
    ...linked,
    ...(detail.project === undefined ? [] : [detail.project.recordId]),
  ]);
  const clients = yield* teamClients(
    detail.orgId,
    personId,
    detail.party === undefined ? [] : [detail.party.recordId],
  );
  const sheet: KinRecordDetail = {
    ...(whole ? detail : teamRecordIn(detail, visible, clients)),
    source: { chatId: null, messageId: null },
    links: detail.links.filter((link) =>
      link.kind === "pull_request" || link.kind === "url"
        ? true
        : link.kind === "record" && link.record !== undefined && visible.has(link.record.recordId),
    ),
    changes: whole
      ? detail.changes.map((change, index) => ({ ...change, seq: detail.changes.length - index }))
      : teamChanges(detail.changes),
    seq,
  };
  return sheet;
});

const CURRENCY_WORD = "(?:rupees?|dollars?|euros?|pounds?|bucks|rs\\.?|inr|usd|eur|gbp)";
// A figure starts a word: the digits inside a token ("ab3k", "W-3") are no figure of their own.
const FIGURE = "(?<![\\p{L}\\p{N}_.])\\d[\\d,.]*";
// A currency's symbol or word on either side of a figure, or lakh and crore after one.
const AMOUNT = new RegExp(
  `[₹$€£]\\s?\\d[\\d,.]*|${FIGURE}\\s?[₹$€£]|\\b${CURRENCY_WORD}\\s?\\d[\\d,.]*|${FIGURE}\\s?(?:lakhs?|lacs?|crores?|cr|${CURRENCY_WORD})\\b`,
  "iu",
);
// "3k" is a sum only where the words around it are about money: "3k followers" is a count.
const THOUSANDS = new RegExp(`${FIGURE}\\s?k\\b`, "iu");
const MONEY_CONTEXT =
  /\b(?:rupees?|dollars?|euros?|pounds?|bucks|inr|usd|eur|gbp|budget|cost|costs|price|priced|pay|pays|paid|payment|fee|fees|invoice|invoiced|quote|quoted|salary|rate|owe|owed|owes|spend|spent|charge|charged|bill|billed|refund|deposit|advance|revenue|profit|loss|discount|money|amount|cash)\b/i;
const NUMBER_WORD =
  "(?:a|half|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion)";
// "forty thousand rupees", "five lakh", "Rupees fifty thousand": an amount in words is an amount.
const AMOUNT_WORDS = new RegExp(
  `\\b${NUMBER_WORD}(?:[\\s-]+(?:and[\\s-]+)?${NUMBER_WORD})*[\\s-]+(?:lakhs?|lacs?|crores?|${CURRENCY_WORD})\\b|\\b${CURRENCY_WORD}[\\s-]+(?!a\\b)${NUMBER_WORD}\\b`,
  "i",
);
const MONEY_NUMBER = /\b[A-Z]{2,5}\/\d{2}-\d{2}\/\d+\b/;
// "987.654,00": thousands by dots and a decimal comma is a sum of money, not a count.
const EURO_FIGURE = /\b\d{1,3}(?:\.\d{3})+,\d{1,2}\b/;

const SMALL: Readonly<Record<string, number>> = Object.fromEntries([
  ..."zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen"
    .split(" ")
    .map((word, n) => [word, n] as const),
  ..."twenty thirty forty fifty sixty seventy eighty ninety"
    .split(" ")
    .map((word, n) => [word, (n + 2) * 10] as const),
]);
const SCALE: Readonly<Record<string, number>> = {
  thousand: 1e3,
  lakh: 1e5,
  lakhs: 1e5,
  lac: 1e5,
  lacs: 1e5,
  million: 1e6,
  crore: 1e7,
  crores: 1e7,
  billion: 1e9,
};
/** Every whole figure of four digits or more the text writes, in digits or in words. */
const figuresIn = (text: string) => {
  const found = new Set<number>();
  const keep = (n: number) => {
    if (Number.isSafeInteger(n) && n >= 1000) found.add(n);
  };
  for (const [run] of text.matchAll(/\d(?:[\d.,'’]*\d)?/g)) {
    keep(Number(run.replace(/\D/g, "")));
    keep(Number(run.replace(/[.,]\d{1,2}$/, "").replace(/\D/g, "")));
  }
  let total = 0;
  let current = 0;
  let inRun = false;
  const end = () => {
    if (inRun) keep(total + current);
    total = 0;
    current = 0;
    inRun = false;
  };
  for (const word of text.toLowerCase().split(/[^a-z]+/)) {
    if (word in SMALL) {
      current += SMALL[word]!;
      inRun = true;
    } else if (word === "hundred" && inRun) current *= 100;
    else if (word in SCALE && inRun) {
      total += current * SCALE[word]!;
      current = 0;
    } else if (word !== "and" || !inRun) end();
  }
  end();
  return [...found];
};
const ENTRY_KEY = /\b[A-Z]{1,4}-\d{1,6}\b/g;
const fold = (text: string) => text.toLowerCase().replace(/\s+/g, " ");

/**
 * Why `text` can't go to this person, or undefined: no amount, money document number, client's
 * terms, or key or title of an entry they don't see. `askedBy`, a teammate whose own words these
 * are, is held only to what they see, so a refusal never says a guess matches something hidden.
 */
export const unreadableBy = Effect.fn("KinTeamView.unreadableBy")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  text: string,
  askedBy?: KinPersonId,
) {
  // The agent is told which words read as a sum, so it can send the rest or ask the owner.
  const figure = (said: string) =>
    `“${said.trim()}” reads as an amount of money, which they may not see`;
  const written =
    AMOUNT.exec(text) ??
    AMOUNT_WORDS.exec(text) ??
    MONEY_NUMBER.exec(text) ??
    EURO_FIGURE.exec(text) ??
    (MONEY_CONTEXT.test(text) ? THOUSANDS.exec(text) : null);
  if (written !== null) return figure(written[0]);
  const sql = yield* SqlClient.SqlClient;
  const known = askedBy === undefined ? sql`1 = 1` : personSees(sql, askedBy);
  // A bare figure that is the sum on something they can't see, however it is written.
  const figures = figuresIn(text);
  if (figures.length > 0) {
    // The sum in whole units of its own currency, as a person writes it: yen have no minor unit.
    const same = (column: Statement.Fragment, currency: Statement.Fragment) =>
      sql`(${column} IN ${sql.in(figures)} OR (CASE
        WHEN ${currency} IN ${sql.in(kinCurrenciesWithDecimals(0))} THEN ${column}
        WHEN ${currency} IN ${sql.in(kinCurrenciesWithDecimals(3))} THEN ${column} / 1000
        ELSE ${column} / 100 END) IN ${sql.in(figures)})`;
    const [hit] = yield* sql<{ hit: number }>`SELECT EXISTS (SELECT 1 FROM kin_records r
        WHERE r.org_id = ${orgId} AND r.amount_minor IS NOT NULL
          AND ${same(sql`r.amount_minor`, sql`r.currency`)} AND NOT ${personSees(sql, personId)} AND ${known})
      OR EXISTS (SELECT 1 FROM kin_record_payments p
        JOIN kin_records r ON r.org_id = p.org_id AND r.record_id = p.record_id
        WHERE p.org_id = ${orgId} AND ${same(sql`p.amount_minor`, sql`p.currency`)}
          AND NOT ${personSees(sql, personId)} AND ${known}) AS hit`;
    if (hit?.hit === 1) return "it carries a figure that is a sum they may not see";
  }
  const keys = [...new Set(text.match(ENTRY_KEY) ?? [])];
  if (keys.length > 0) {
    const rows = yield* sql<{ key: string }>`SELECT r.key FROM kin_records r
      WHERE r.org_id = ${orgId} AND r.key IN ${sql.in(keys)} AND NOT ${personSees(sql, personId)}
        AND ${known}
      ORDER BY r.key LIMIT 1`;
    if (rows[0] !== undefined) return `${rows[0].key} is something they can't see`;
  }
  const folded = fold(text);
  // Labelled entries they can't see, and every client's terms, by their words.
  const hidden = yield* sql<{ words: string | null }>`SELECT r.title AS words FROM kin_records r
      WHERE r.org_id = ${orgId} AND ${sensitiveNow(sql)} AND NOT ${personSees(sql, personId)}
        AND length(r.title) >= 6 AND ${known}
    UNION ALL SELECT json_extract(r.fields_json, '$.terms') FROM kin_records r
      WHERE r.org_id = ${orgId} AND r.register_id = 'clients'
        AND length(json_extract(r.fields_json, '$.terms')) >= 10 AND ${known}
    LIMIT 2000`;
  const named = hidden.find((row) => row.words !== null && folded.includes(fold(row.words)));
  if (named !== undefined) return "it repeats a private entry or a client's terms they can't see";
  const termsFigures = yield* sql<{ terms: string }>`SELECT json_extract(r.fields_json, '$.terms')
      AS terms FROM kin_records r
    WHERE r.org_id = ${orgId} AND r.register_id = 'clients'
      AND json_extract(r.fields_json, '$.terms') GLOB '*[0-9]*' AND ${known}
    LIMIT 2000`;
  return figures.length > 0 &&
    termsFigures.some((row) => figuresIn(row.terms).some((n) => figures.includes(n)))
    ? "it carries a figure from a client's terms they may not see"
    : undefined;
});
