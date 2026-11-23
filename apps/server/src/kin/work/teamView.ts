import {
  kinCurrenciesWithDecimals,
  type KinAgentId,
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

import { personReads } from "../chat/sharing.ts";
import { directKey } from "../lead/LeadAccess.ts";
import { targetless } from "../numbers/numberRows.ts";
import { LISTS, TEAM_LIST_RESERVED } from "./lists.ts";
import { listDef, sensitiveKeys } from "./registers.ts";
import {
  inheritedSensitive,
  iso,
  issuedNumber,
  keySensitive,
  keyWithheld,
  notFound,
  type RecordRow,
  samePrincipal,
  sensitiveNow,
  wordsOf,
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

const listMoneyFor = (
  sql: SqlClient.SqlClient,
  people: ReadonlyArray<KinPersonId | Statement.Fragment>,
) =>
  sql`(r.register_id IN ${sql.in(TEAM_LIST_RESERVED)} OR ${
    people.length === 0
      ? sql`0 = 1`
      : sql.and(people.map((person) => placeOn(sql, person, "sees_money")))
  })`;

export const listMoneySeenBy = (sql: SqlClient.SqlClient, viewer: KinViewer) =>
  viewer._tag === "ownerLevel" ? sql`1 = 1` : listMoneyFor(sql, viewer.people);

export const privateListField = (sql: SqlClient.SqlClient, key: string | Statement.Fragment) =>
  sql`EXISTS (SELECT 1 FROM kin_registers g, json_each(g.definition_json, '$.fields') spec
    WHERE g.org_id = r.org_id AND g.register_id = r.register_id
      AND json_extract(spec.value, '$.key') = ${key}
      AND (json_extract(spec.value, '$.sensitive') = 1 OR json_extract(spec.value, '$.type') = 'money'))`;

export const listNumberSeenBy = (sql: SqlClient.SqlClient, viewer: KinViewer) =>
  viewer._tag === "ownerLevel"
    ? sql`1 = 1`
    : sql`(${listMoneySeenBy(sql, viewer)} OR NOT ${privateListField(sql, "number")})`;

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

/** Every picture's doc (`kin_picture`) has an origin key that starts with this. */
export const PICTURE_DOC_ORIGIN = "picture:";

/**
 * Version `pv` of a picture was made in a turn others read and posted on a reply this person reads
 * now: in its chat, from their join on (`personReads`).
 */
const pictureVersionReader = (
  sql: SqlClient.SqlClient,
  personId: KinPersonId | Statement.Fragment,
) =>
  sql`(pv.audience = 'shared' AND EXISTS (SELECT 1 FROM kin_picture_images pi
    JOIN kin_message_attachments pa ON pa.org_id = pi.org_id AND pa.attachment_id = pi.attachment_id
    JOIN kin_messages ON kin_messages.org_id = pa.org_id AND kin_messages.message_id = pa.message_id
    WHERE pi.org_id = pv.org_id AND pi.record_id = pv.record_id AND pi.version = pv.version
      AND kin_messages.status <> 'deleted' AND ${personReads(sql, personId)}))`;

/**
 * Version `pv` of picture doc `r`, for someone below the owner level: unlabelled, and its reply
 * read or the doc shared with the team (`sees_docs`). The one rule its doc, history, file, image
 * and `doc_read` follow, with `pictureReader` for the doc itself.
 */
export const pictureVersionSeen = (
  sql: SqlClient.SqlClient,
  personId: KinPersonId | Statement.Fragment,
) =>
  sql`(NOT ${sensitiveNow(sql)} AND (${pictureVersionReader(sql, personId)}
    OR (r.team_shared = 1 AND ${placeOn(sql, personId, "sees_docs")})))`;

/** `r` is a picture whose latest version this person reads; a later owner-only one takes it back. */
const pictureReader = (sql: SqlClient.SqlClient, personId: KinPersonId | Statement.Fragment) =>
  sql`(r.origin_key LIKE ${`${PICTURE_DOC_ORIGIN}%`} AND EXISTS (SELECT 1 FROM kin_doc_versions pv
    WHERE pv.org_id = r.org_id AND pv.record_id = r.record_id
      AND pv.version = (SELECT MAX(lv.version) FROM kin_doc_versions lv
        WHERE lv.org_id = r.org_id AND lv.record_id = r.record_id)
      AND ${pictureVersionSeen(sql, personId)}))`;

/** Version `pv` of picture doc `r`, its file and its chat image: its doc and that version seen. */
export const pictureFileReader = (
  sql: SqlClient.SqlClient,
  personId: KinPersonId | Statement.Fragment,
) => sql`(${pictureReader(sql, personId)} AND ${pictureVersionSeen(sql, personId)})`;

const isPicture = (sql: SqlClient.SqlClient) =>
  sql`(r.register_id = 'docs' AND r.origin_key LIKE ${`${PICTURE_DOC_ORIGIN}%`})`;

/** `r` is a meeting this person is one of the people at (`fields.attendees`). */
const attends = (sql: SqlClient.SqlClient, personId: KinPersonId | Statement.Fragment) =>
  sql`EXISTS (SELECT 1 FROM json_each(r.fields_json, '$.attendees') a
    WHERE a.value = 'person:' || ${personId})`;

/** `r` is a task this person is on besides its holder (`fields.alsoOn`). */
export const alsoOnIt = (sql: SqlClient.SqlClient, personId: KinPersonId | Statement.Fragment) =>
  sql`(r.register_id = 'work' AND EXISTS (SELECT 1 FROM json_each(r.fields_json, '$.alsoOn') o
    WHERE o.value = 'person:' || ${personId}))`;

const teamListRow = (sql: SqlClient.SqlClient, personId: KinPersonId | Statement.Fragment) =>
  sql`(r.team_shared = 1 AND ${ownLabelOff(sql)}
    AND NOT ${inheritedSensitive(sql)} AND ${placeOn(sql, personId, "sees_money")})`;

/** A defined team list `g`. */
const teamRegister = (sql: SqlClient.SqlClient) =>
  sql`(g.built_in = 0 AND g.register_id NOT IN ${sql.in(TEAM_LIST_RESERVED)}
    AND lower(trim(g.name)) <> 'bank transactions'
    AND json_type(g.definition_json, '$.sensitive') = 'false'
    AND json_type(g.definition_json, '$.team') = 'true'
    AND json_type(g.definition_json, '$.teamSince') = 'integer'
    AND json_extract(g.definition_json, '$.teamSince') >= 0)`;

/** For a team list, only payments place it in a switchable section (`sectionOfRegister`). */
const teamSectionOff = (sql: SqlClient.SqlClient) =>
  sql`(g.register_id NOT IN ('dates', 'subscriptions')
    AND json_type(g.definition_json, '$.payments') IS 'true'
    AND EXISTS (SELECT 1 FROM kin_company_shell sh, json_each(sh.shell_json) section
      WHERE sh.org_id = g.org_id AND json_extract(section.value, '$.id') = 'money'
        AND json_type(section.value, '$.on') = 'false'))`;

export const teamLists = Effect.fn("KinTeamView.lists")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ id: string }>`SELECT g.register_id AS id FROM kin_registers g
    WHERE g.org_id = ${orgId} AND ${teamRegister(sql)} AND NOT ${teamSectionOff(sql)}
    ORDER BY g.register_id`;
  return new Set(rows.map((row) => row.id));
});

const onTeamList = (sql: SqlClient.SqlClient) =>
  sql`(r.register_id NOT IN ${sql.in(TEAM_LIST_RESERVED)}
    AND EXISTS (SELECT 1 FROM kin_registers g WHERE g.org_id = r.org_id
      AND g.register_id = r.register_id AND ${teamRegister(sql)}))`;

const teamListHidden = (sql: SqlClient.SqlClient) =>
  sql`EXISTS (SELECT 1 FROM kin_registers g WHERE g.org_id = r.org_id
    AND g.register_id = r.register_id AND ${teamRegister(sql)}
    AND (${teamSectionOff(sql)} OR NOT ${ownLabelOff(sql)} OR ${inheritedSensitive(sql)}))`;

const openedListRow = (sql: SqlClient.SqlClient, personId: KinPersonId | Statement.Fragment) =>
  sql`(${ownLabelOff(sql)} AND NOT ${inheritedSensitive(sql)}
    AND EXISTS (SELECT 1 FROM kin_registers g WHERE g.org_id = r.org_id
      AND g.register_id = r.register_id AND ${teamRegister(sql)}
      AND (r.created_at >= json_extract(g.definition_json, '$.teamSince')
        OR (r.created_by_kind = 'person' AND r.created_by_id = ${personId}))))`;

export const allSeeMoney = Effect.fn("KinTeamView.allSeeMoney")(function* (
  orgId: KinOrgId,
  people: ReadonlyArray<KinPersonId>,
) {
  const sql = yield* SqlClient.SqlClient;
  const ids = [...new Set(people)];
  if (ids.length === 0) return false;
  const [row] = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM kin_people
    WHERE org_id = ${orgId} AND person_id IN ${sql.in(ids)}
      AND removed_at IS NULL AND sees_money = 1`;
  return row?.count === ids.length;
});

/**
 * What a non-owner-level person sees: a picture by `pictureReader` alone; else a task they hold, are
 * on, attend or marked private; what they made, gave or share; their projects' entries and docs;
 * their drafts; company docs with Docs on; with Clients on, the deals of clients they see; and
 * unlabelled entries from a team list's opening or made by the teammate.
 */
export const personSees = (sql: SqlClient.SqlClient, personId: KinPersonId | Statement.Fragment) =>
  sql`(CASE WHEN ${isPicture(sql)} THEN ${pictureReader(sql, personId)}
  WHEN r.register_id = 'goals' AND ${targetless(sql)}
    THEN json_type(r.fields_json, '$.spec') IS NULL AND ${teamListRow(sql, personId)}
  WHEN r.register_id NOT IN ${sql.in(TEAM_LIST_RESERVED)} AND ${teamListHidden(sql)} THEN 0
  ELSE ((r.register_id = 'work' AND ((r.owner_kind = 'person' AND r.owner_id = ${personId})
      OR ${attends(sql, personId)} OR ${alsoOnIt(sql, personId)} OR r.marked_by_person_id = ${personId}
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
    OR (r.register_id = 'docs' AND json_extract(r.fields_json, '$.draftFor') = ${personId})
    OR (r.register_id = 'docs' AND (r.team_shared = 1
      OR json_extract(r.fields_json, '$.home') = 'company')
      AND ${placeOn(sql, personId, "sees_docs")})))
  OR (r.register_id = 'deals' AND NOT ${keySensitive(sql)}
    AND ${placeOn(sql, personId, "sees_clients")})
  OR (r.register_id NOT IN ${sql.in(NOT_LISTS)}
    AND (${teamListRow(sql, personId)} OR ${openedListRow(sql, personId)}))) END)`;

/** Version `pv` of doc `r` as this person reads it: the doc, and a picture's version by its own rule. */
export const docVersionSeen = (
  sql: SqlClient.SqlClient,
  personId: KinPersonId | Statement.Fragment,
) =>
  sql`(${personSees(sql, personId)} AND (NOT ${isPicture(sql)} OR ${pictureVersionSeen(sql, personId)}))`;

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
  sql`(${
    viewer._tag === "ownerLevel"
      ? sql`1 = 1`
      : viewer.people.length === 0
        ? sql`0 = 1`
        : sql.and(viewer.people.map((person) => crmSees(sql, person)))
  } AND ${keyedAs(sql, viewer)})`;

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
  // Someone on a project, or in a chat Kin drew a picture in, reads those docs without the Docs
  // place, so they reach the screen too.
  const [onOne] = yield* sql`SELECT 1 FROM kin_records r
    WHERE r.org_id = ${orgId} AND r.register_id = 'docs'
      AND ((r.project_id IS NOT NULL AND ${projectPerson(sql, personId)})
        OR ${pictureReader(sql, personId)}) LIMIT 1`;
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
  | { readonly _tag: "ownerLevel"; readonly keyed?: true }
  | { readonly _tag: "people"; readonly people: ReadonlyArray<KinPersonId>; readonly keyed?: true };
/** The unscoped read: the owner, a co-owner, or Kin's own work for them. */
export const KIN_OWNER_LEVEL: KinViewer = { _tag: "ownerLevel" };
export const viewerOfPeople = (people: ReadonlyArray<KinPersonId>): KinViewer => ({
  _tag: "people",
  people,
});
/**
 * The same viewer read through a coding agent's key: every read scoped by it also leaves out what
 * a key never carries (`keyWithheld`), before any match, sort, count or limit.
 */
export const keyedViewer = (viewer: KinViewer): KinViewer => ({ ...viewer, keyed: true });
/** With a keyed viewer, `alias` (default `r`) is nothing a key never carries; else always true. */
export const keyedAs = (sql: SqlClient.SqlClient, viewer: KinViewer, alias = "r") =>
  viewer.keyed !== true
    ? sql`1 = 1`
    : alias === "r"
      ? sql`NOT ${keyWithheld(sql)}`
      : // oxlint-disable-next-line t3code/kin-viewer-scoped-reads -- the same row as `alias`, only narrowed further
        sql`NOT EXISTS (SELECT 1 FROM kin_records r WHERE r.org_id = ${sql(alias)}.org_id
          AND r.record_id = ${sql(alias)}.record_id AND ${keyWithheld(sql)})`;
/** Entries `r` this viewer sees. */
export const seenBy = (sql: SqlClient.SqlClient, viewer: KinViewer) =>
  sql`(${viewer._tag === "ownerLevel" ? sql`1 = 1` : viewSees(sql, viewer.people)} AND ${keyedAs(sql, viewer)})`;

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
 * Whether every one of these people may read this version of the entry now: the entry, and for a
 * picture that version by its own rule (`pictureVersionSeen`).
 */
export const viewVersionVisible = Effect.fn("KinTeamView.viewVersionVisible")(function* (
  orgId: KinOrgId,
  people: ReadonlyArray<KinPersonId>,
  recordId: string,
  version: number,
) {
  const sql = yield* SqlClient.SqlClient;
  if (people.length === 0) return false;
  const rows = yield* sql`SELECT 1 FROM kin_records r JOIN kin_doc_versions pv
      ON pv.org_id = r.org_id AND pv.record_id = r.record_id AND pv.version = ${version}
    WHERE r.org_id = ${orgId} AND r.record_id = ${recordId}
      AND ${sql.and(people.map((person) => docVersionSeen(sql, person)))} LIMIT 1`;
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
  write: TeamWrite & {
    readonly row: Pick<RecordRow, "recordId" | "key" | "registerId"> | undefined;
  },
  /** The agent's turn making the write, which `draftDoc` reads its ask from. */
  turn?: { readonly agentId: KinAgentId; readonly wakeupId: string },
) {
  if (view.people.length === 0) return yield* noLongerTeam;
  const taskUpdate = write.changes && write.row?.registerId === "work";
  const fields = write.input.fields;
  const changesWith =
    taskUpdate && typeof fields === "object" && fields !== null && "alsoOn" in fields;
  if (changesWith && view.askers.length === 0) return yield* TEAM_REFUSED;
  if (yield* roomWork(orgId, view.people, write)) {
    if (taskUpdate)
      for (const person of view.askers)
        yield* teamGuard(orgId, person, write, { room: !changesWith });
    return;
  }
  const draft = yield* draftDoc(orgId, view, write, turn);
  if (draft === "filed") return { draftFor: view.people[0]! };
  for (const person of view.people)
    yield* teamGuard(
      orgId,
      person,
      {
        ...write,
        changes: write.changes && view.askers.includes(person),
      },
      { readOnly: view.askers.length === 0, teamListChanges: write.changes },
    ).pipe(
      Effect.mapError((error) =>
        draft === "elsewhere" && error === TEAM_REFUSED ? DRAFT_OWN_CHAT_ONLY : error,
      ),
    );
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

/** What a doc filed at one teammate's own ask may carry besides its text (`draftDoc`). */
const DRAFT_DOC_FIELDS: ReadonlySet<string> = new Set(["list", "source", "partyId", "projectId"]);
/** Kinds whose text sets how Kin works for everyone (`playbooks.ts`): the owner level's to file. */
const COMPANY_DOC_KINDS: ReadonlyArray<unknown> = ["playbook", "policy"];

/**
 * A doc filed at the one teammate's ask behind the turn, marked theirs (`draftFor`), so they see
 * it (`personSees`) and their turns may revise its text (`teamRule`): no label, sharing, money or
 * company home, under a client they see and a project they are in.
 */
const draftDoc = Effect.fn("KinTeamView.draftDoc")(function* (
  orgId: KinOrgId,
  view: {
    readonly people: ReadonlyArray<KinPersonId>;
    readonly askers: ReadonlyArray<KinPersonId>;
  },
  write: Parameters<typeof teamGuard>[2],
  turn: { readonly agentId: KinAgentId; readonly wakeupId: string } | undefined,
) {
  const { row, input } = write;
  const [person] = view.people;
  if (
    person === undefined ||
    view.people.length !== 1 ||
    view.askers.length !== 1 ||
    view.askers[0] !== person ||
    input.list !== "docs" ||
    COMPANY_DOC_KINDS.includes(input.category) ||
    write.changes ||
    OWNERS_FIELDS.some((field) => input[field] !== undefined && !DRAFT_DOC_FIELDS.has(field))
  )
    return undefined;
  if (row === undefined && (turn === undefined || !(yield* ownDirectAsk(orgId, person, turn))))
    return "elsewhere" as const;
  const facts = yield* teamFactsOf(
    orgId,
    person,
    row === undefined ? [] : [row.recordId],
    typeof input.partyId === "string" ? [input.partyId] : [],
  );
  const own = facts(row?.recordId);
  if (!own.member) return yield* noLongerTeam;
  if (row !== undefined)
    return own.seen !== null && own.seen !== undefined ? ("filed" as const) : undefined;
  if (typeof input.partyId === "string" && !(own.clients.on && own.clients.seen.has(input.partyId)))
    return undefined;
  return typeof input.projectId !== "string" || (yield* inProject(orgId, person, input.projectId))
    ? ("filed" as const)
    : undefined;
});

export const DRAFT_OWN_CHAT_ONLY = new KinChatError({
  reason: "not_allowed",
  message:
    "A teammate's doc is filed only at their own word in their own chat with you. Nothing was written.",
});

/**
 * The turn answers this person's own message in their own direct chat with the agent, or a task
 * they gave it there by their own hand in words only they wrote, and nothing in it was carried
 * from another chat, person or agent.
 */
const ownDirectAsk = Effect.fn("KinTeamView.ownDirectAsk")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  turn: { readonly agentId: KinAgentId; readonly wakeupId: string },
) {
  const sql = yield* SqlClient.SqlClient;
  const key = directKey(personId, turn.agentId);
  const toAgent = `agent:${turn.agentId}`;
  const asks = yield* sql<{
    own: number | null;
    recordId: string | null;
    seq: number | null;
  }>`SELECT CASE e.tag WHEN 'chat.message' THEN
        (m.author_kind = 'human' AND m.author_person_id = ${personId} AND m.origin_json IS NULL
          AND json_extract(e.json, '$.origin') IS NULL AND c.kind = 'direct'
          AND c.archived_at IS NULL AND c.direct_key = ${key})
      ELSE (json_extract(e.json, '$.origin.personId') = ${personId}
        AND json_extract(e.json, '$.reason') = 'assigned' AND t.kind = 'direct'
        AND t.archived_at IS NULL AND t.direct_key = ${key}
        AND EXISTS (SELECT 1 FROM kin_record_changes rc, json_each(rc.fields_json) f
          WHERE rc.org_id = e.org_id AND rc.record_id = json_extract(e.json, '$.recordId')
          AND rc.seq = json_extract(e.json, '$.seq') AND rc.actor_kind = 'person'
          AND rc.actor_id = ${personId} AND rc.coding_agent_key IS NULL
          AND json_extract(f.value, '$.field') = 'owner'
          AND json_extract(f.value, '$.to') = ${toAgent}
          AND json_extract(f.value, '$.from') IS NOT ${toAgent})) END AS own,
      json_extract(e.json, '$.recordId') AS "recordId", json_extract(e.json, '$.seq') AS seq
    FROM kin_events e
    LEFT JOIN kin_messages m ON m.org_id = e.org_id
      AND m.message_id = json_extract(e.json, '$.messageId')
    LEFT JOIN kin_chats c ON c.org_id = m.org_id AND c.chat_id = m.chat_id
    LEFT JOIN kin_chats t ON t.org_id = e.org_id AND t.chat_id = json_extract(e.json, '$.origin.chatId')
    WHERE e.org_id = ${orgId} AND e.agent_id = ${turn.agentId} AND e.wakeup_id = ${turn.wakeupId}
      AND e.tag IN ('chat.message', 'record.changed')
    ORDER BY e.event_id`;
  if (asks.length === 0 || asks.some((ask) => ask.own !== 1)) return false;
  for (const ask of asks) {
    if (ask.recordId === null || ask.seq === null) continue;
    const { writers, madeBy } = yield* wordsOf(orgId, ask.recordId, ask.seq);
    const hers = (kind: string, id: string | null) => kind === "person" && id === personId;
    if (
      madeBy === undefined ||
      !hers(madeBy.kind, madeBy.id) ||
      !writers.every((one) => hers(one.actorKind, one.actorId) && one.coding === 0)
    )
      return false;
  }
  return true;
});

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
 * A teammate changes only a task they hold, gave to whoever holds it or marked private,
 * never one they only see; a project's lead also anything of the project in `LEAD_LISTS`, quotes
 * and invoices as drafts.
 */
const teamWrites = (sql: SqlClient.SqlClient, personId: KinPersonId) =>
  sql`(${personSees(sql, personId)} AND ((r.owner_kind = 'person' AND r.owner_id = ${personId})
    OR (r.assigned_by_person_id = ${personId} AND r.register_id <> 'docs')
    OR r.marked_by_person_id = ${personId}
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
    number: unknown;
    total: number;
  }>`SELECT l.relation, l.created_at AS "createdAt", r.record_id AS "recordId", r.key, r.title,
      CASE WHEN ${listNumberSeenBy(sql, viewer)} THEN json_extract(r.fields_json, '$.number') END
        AS "number", COUNT(*) OVER () AS total
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
            ...issuedNumber(row.number),
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
  /** The repository checked that this patch only takes this person off the task. */
  readonly leaveBy?: KinPersonId | undefined;
  readonly input: Readonly<
    Partial<Record<(typeof OWNERS_FIELDS)[number] | "state" | "category", unknown>>
  >;
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
          onTask: number;
          ownerKind: string;
          ownerId: string;
          leads: number;
          marked: number;
          gave: number;
          draft: number;
          registerId: string;
          partyId: string | null;
          projectId: string | null;
          projectPartyId: string | null;
          teamList: number;
          madeByViewer: number;
        }>`SELECT
          r.record_id AS "recordId", ${teamWrites(sql, personId)} AS writes,
          ${onTeamList(sql)} AS "teamList",
          r.created_by_kind = 'person' AND r.created_by_id = ${personId} AS "madeByViewer",
          ${alsoOnIt(sql, personId)} AS "onTask", r.owner_kind AS "ownerKind", r.owner_id AS "ownerId",
          r.party_id AS "partyId", r.project_id AS "projectId",
          (SELECT p.party_id FROM kin_records p WHERE p.org_id = r.org_id
            AND p.record_id = r.project_id) AS "projectPartyId",
          COALESCE(r.assigned_by_person_id = ${personId}, 0) AS gave,
          COALESCE(r.register_id = 'docs'
            AND json_extract(r.fields_json, '$.draftFor') = ${personId}, 0) AS draft,
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

const TEAM_LIST_REFUSED = new KinChatError({
  reason: "not_allowed",
  message: "Only the owner or a co-owner can do that on this list.",
});
const TEAM_LIST_EDITS: ReadonlySet<string> = new Set([
  "state",
  "fields",
  "title",
  "notes",
  "amount",
]);
const teamListEdit = (facts: TeamFacts, write: TeamWrite) => {
  if (write.input.state === "dropped" && facts.seen?.madeByViewer !== 1) return TEAM_LIST_REFUSED;
  return Object.entries(write.input).some(
    ([key, value]) => value !== undefined && !TEAM_LIST_EDITS.has(key),
  )
    ? TEAM_REFUSED
    : undefined;
};

/**
 * Whether a teammate's write goes through, and the refusal when it doesn't: they are still let in,
 * the task is one they see (else it is no task at all) and, for a change, one they hold or gave
 * away, or one of a project they lead. Both the write (`teamGuard`) and what a sheet offers
 * (`teamCan`) ask this, so a control the host offers is one it takes.
 */
const teamRule = (facts: TeamFacts, write: TeamWrite): KinChatError | undefined => {
  if (!facts.member) return noLongerTeam;
  if (facts.seen?.teamList === 1) return teamListEdit(facts, write);
  if (write.changes && withOnly(facts)) return WITH_REFUSED;
  // Who is on a task besides its holder is set by whoever may change the task.
  if (alsoOnOnly(facts, write))
    return teamRule(facts, { ...write, input: { ...write.input, fields: undefined } });
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
    // Their own draft (`draftDoc`): a new version of its text, and nothing else about it.
    if (write.changes && seen.writes !== 1 && seen.draft === 1)
      return Object.values(write.input).some((value) => value !== undefined)
        ? TEAM_REFUSED
        : undefined;
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

const withOnly = (facts: TeamFacts) => facts.seen?.onTask === 1 && facts.seen.writes !== 1;
const WITH_REFUSED = new KinChatError({
  reason: "not_allowed",
  message: "You're on this task, not holding it: you can comment or leave.",
});

/** A write to a task whose only list detail is who is on it (`fields.alsoOn`). */
const alsoOnOnly = (facts: TeamFacts, write: TeamWrite) => {
  const { fields } = write.input;
  const task =
    write.row === undefined
      ? (typeof write.input.list === "string" ? write.input.list : "work") === "work"
      : facts.seen?.registerId === "work";
  return (
    task &&
    typeof fields === "object" &&
    fields !== null &&
    Object.keys(fields).length === 1 &&
    "alsoOn" in fields
  );
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
  options?: {
    readonly room?: boolean;
    readonly readOnly?: boolean;
    readonly teamListChanges?: boolean;
  },
) {
  const factsOf = yield* teamFactsOf(
    orgId,
    personId,
    write.row === undefined ? [] : [write.row.recordId],
    typeof write.input.partyId === "string" ? [write.input.partyId] : [],
  );
  const facts = factsOf(write.row?.recordId);
  if (facts.member && facts.seen != null) {
    if (write.leaveBy === personId && facts.seen.onTask === 1) return;
    if (options?.room === true && !withOnly(facts)) return;
  }
  const list = write.row === undefined ? write.input.list : facts.seen?.registerId;
  const teamList =
    facts.member &&
    typeof list === "string" &&
    !TEAM_LIST_RESERVED.includes(list) &&
    (write.row === undefined ? (yield* teamLists(orgId)).has(list) : facts.seen?.teamList === 1);
  if (teamList) {
    if (options?.readOnly === true) return yield* TEAM_LIST_REFUSED;
    const refused =
      write.row !== undefined && (options?.teamListChanges ?? write.changes)
        ? teamListEdit(facts, write)
        : OWNERS_FIELDS.some(
              (field) =>
                field !== "list" &&
                field !== "fields" &&
                field !== "amount" &&
                write.input[field] !== undefined,
            )
          ? TEAM_REFUSED
          : undefined;
    if (refused !== undefined) return yield* refused;
    const { fields, amount } = write.input;
    if (fields !== undefined || amount !== undefined) {
      const def = yield* listDef(orgId, list);
      if (def === undefined) return yield* TEAM_REFUSED;
      if (
        (amount !== undefined ||
          (typeof fields === "object" &&
            fields !== null &&
            sensitiveKeys(def).some((key) => Object.hasOwn(fields, key)))) &&
        !(yield* allSeeMoney(orgId, [personId]))
      )
        return yield* TEAM_REFUSED;
    }
    return;
  }
  const refused = teamRule(facts, write);
  if (refused === WITH_REFUSED && facts.seen != null) {
    const sql = yield* SqlClient.SqlClient;
    const { ownerKind, ownerId } = facts.seen;
    const [holder] =
      ownerKind === "agent"
        ? yield* sql<{ name: string }>`SELECT display_name AS name FROM kin_agents
            WHERE org_id = ${orgId} AND agent_id = ${ownerId}`
        : yield* sql<{ name: string }>`SELECT display_name AS name FROM kin_people
            WHERE org_id = ${orgId} AND person_id = ${ownerId}`;
    const name = holder?.name.trim() || "Whoever holds it";
    return yield* new KinChatError({
      reason: "not_allowed",
      message: `${WITH_REFUSED.message} ${name} can change it.`,
    });
  }
  if (refused !== undefined) return yield* refused;
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
        give: open && moves && facts.seen?.teamList !== 1,
        takeBack:
          open &&
          moves &&
          facts.seen?.teamList !== 1 &&
          !samePrincipal(row.owner, { _tag: "person", personId }),
        mark: takes({ sensitive: true }),
        unmark: takes({ sensitive: false }),
        share: false,
        confirm: false,
        repeat: takes({ repeat: { every: "month" } }),
        ...(facts.seen?.teamList === 1 ? { links: false } : {}),
      };
      return [row.recordId, can] as const;
    }),
  );
});

/**
 * `p` is a teammate who sees `r`: a person let in by an invite, never the owner's own session.
 * An IN list, not EXISTS: SQLite runs an EXISTS last, after `personSees` for everyone, owner too.
 */
const teammateSees = (sql: SqlClient.SqlClient) =>
  sql`(p.person_id IN (SELECT b.person_id FROM kin_session_bindings b WHERE b.org_id = p.org_id)
    AND ${personSees(sql, sql`p.person_id`)})`;

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

/** The key and list of every entry this teammate may see now, for telling them when one is hidden. */
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

/** History lines a teammate reads: what the task says and who is on it, never money or labels. */
const TEAM_FIELDS = new Set([
  "title",
  "state",
  "owner",
  "alsoOn",
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

export const listLinksFor = Effect.fn("KinTeamView.listLinksFor")(function* (
  orgId: KinOrgId,
  viewer: KinViewer,
  links: ReadonlyArray<KinRecordLink>,
) {
  if (viewer._tag === "ownerLevel") return links;
  const targets = links.flatMap((link) =>
    link.kind === "record" && link.number !== undefined ? [link.target] : [],
  );
  if (targets.length === 0) return links;
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ id: string }>`SELECT r.record_id AS id FROM kin_records r
    WHERE r.org_id = ${orgId} AND r.record_id IN ${sql.in(targets)}
      AND ${listNumberSeenBy(sql, viewer)} ORDER BY r.record_id`;
  const seen = new Set(rows.map((row) => row.id));
  return links.map((link): KinRecordLink => {
    if (link.kind !== "record" || link.number === undefined || seen.has(link.target)) return link;
    const { number: _number, ...rest } = link;
    return rest;
  });
});

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
    links: yield* listLinksFor(
      detail.orgId,
      viewerOfPeople([personId]),
      detail.links.filter((link) =>
        link.kind === "pull_request" || link.kind === "url"
          ? true
          : link.kind === "record" &&
            link.record !== undefined &&
            visible.has(link.record.recordId),
      ),
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
const FIGURE_RUN = /\d(?:[\d.,'’]*\d)?/g;
const digitsOf = (run: string) => run.replace(/[.,]00?$/, "").replace(/\D/g, "");

/** `text` without the figures that `own` also carries, however each is grouped ("2,50,000"). */
export const withoutOwnFigures = (text: string, own: string) => {
  const mine = new Set([...own.matchAll(FIGURE_RUN)].map(([run]) => digitsOf(run)));
  // An entry key's number ("INV-3") is no figure of hers: it stays for the hidden-entry check.
  return text.replace(FIGURE_RUN, (run, at: number) =>
    mine.has(digitsOf(run)) && !/[A-Z]-$/.test(text.slice(0, at)) ? "" : run,
  );
};
const fold = (text: string) => text.toLowerCase().replace(/\s+/g, " ");

/**
 * Why `text` can't go to this person, or undefined: no amount, money document number, client's
 * terms, or key or title of an entry they don't see. `askedBy`, a teammate whose own words these
 * are, is held only to what they see, so a refusal never says a guess matches something hidden.
 * `own`: words whose figures are theirs to read, exempt from the amount checks only.
 */
export const unreadableBy = Effect.fn("KinTeamView.unreadableBy")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  text: string,
  askedBy?: KinPersonId,
  own?: string,
) {
  // Keys, titles and terms are matched as written: an exempt figure never hides one.
  const sums = own === undefined ? text : withoutOwnFigures(text, own);
  // The agent is told which words read as a sum, so it can send the rest or ask the owner.
  const figure = (said: string) =>
    `“${said.trim()}” reads as an amount of money, which they may not see`;
  const written =
    AMOUNT.exec(sums) ??
    AMOUNT_WORDS.exec(sums) ??
    MONEY_NUMBER.exec(sums) ??
    EURO_FIGURE.exec(sums) ??
    (MONEY_CONTEXT.test(sums) ? THOUSANDS.exec(sums) : null);
  if (written !== null) return figure(written[0]);
  const sql = yield* SqlClient.SqlClient;
  const known = askedBy === undefined ? sql`1 = 1` : personSees(sql, askedBy);
  // A bare figure that is the sum on something they can't see, however it is written.
  const figures = figuresIn(sums);
  if (figures.length > 0) {
    // The sum in whole units of its own currency, as a person writes it: yen have no minor unit.
    const same = (column: Statement.Fragment, currency: Statement.Fragment) =>
      sql`(${column} IN ${sql.in(figures)} OR (CASE
        WHEN ${currency} IN ${sql.in(kinCurrenciesWithDecimals(0))} THEN ${column}
        WHEN ${currency} IN ${sql.in(kinCurrenciesWithDecimals(3))} THEN ${column} / 1000
        ELSE ${column} / 100 END) IN ${sql.in(figures)})`;
    const figureSeen = sql`(${personSees(sql, personId)} AND ${listMoneyFor(sql, [personId])})`;
    const figureKnown =
      askedBy === undefined ? known : sql`(${known} AND ${listMoneyFor(sql, [askedBy])})`;
    const [hit] = yield* sql<{ hit: number }>`SELECT EXISTS (SELECT 1 FROM kin_records r
        WHERE r.org_id = ${orgId} AND r.amount_minor IS NOT NULL
          AND ${same(sql`r.amount_minor`, sql`r.currency`)} AND NOT ${figureSeen} AND ${figureKnown})
      OR EXISTS (SELECT 1 FROM kin_record_payments p
        JOIN kin_records r ON r.org_id = p.org_id AND r.record_id = p.record_id
        WHERE p.org_id = ${orgId} AND ${same(sql`p.amount_minor`, sql`p.currency`)}
          AND NOT ${figureSeen} AND ${figureKnown}) AS hit`;
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
