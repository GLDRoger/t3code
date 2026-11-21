import {
  KIN_CAMPAIGN_SOURCE,
  KIN_RECORDS_PAGE_CAP,
  KIN_PROJECT_BILLING,
  isCalendarDay,
  KinChatError,
  KinRecordId,
  type KinBlockedOn,
  type KinCampaignResults,
  type KinMoney,
  type KinContact,
  type KinOrgId,
  type KinPartyDetail,
  type KinPartyKind,
  type KinPartyPage,
  type KinPartyRow,
  type KinProjectDetail,
  type KinProjectHealth,
  type KinProjectPage,
  type KinProjectRow,
  type KinProjectState,
  type KinRecord,
  type KinRecordRef,
  type KinWorkHistoryItem,
  type KinWorkPrincipal,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { stageLine, stagesOf } from "./dealStages.ts";
import {
  fieldList,
  fieldText,
  isMoney,
  listOf,
  parseFields,
  sensitiveFields,
  listNameOf,
  workListOf,
} from "./lists.ts";
import {
  meetingsOf,
  milestonesOf,
  moneyOf,
  peopleOf,
  principalOfText,
  projectSpecChanges,
} from "./projectSpine.ts";
import {
  crmSeenBy,
  crmSeesAs,
  KIN_OWNER_LEVEL,
  personSeesAs,
  seenBy,
  type KinViewer,
} from "./teamView.ts";
import {
  actorOf,
  iso,
  parseChanges,
  partyKind,
  principal,
  type RecordRow,
  recordSeq,
  selectRecords,
  toRecord,
} from "./recordRows.ts";
import { contactAll, contactSensitive } from "./contactDetails.ts";
import { spellingsOf } from "./tags.ts";
import { lastContacts, touchesOf } from "./touches.ts";

/**
 * The light CRM's read model: the client page, the project page and their history, computed on
 * every read from entries and their change logs. Nothing here is stored, and every query and join
 * stays inside one org. Callers check who may read; this answers for the owner.
 */

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const SUMMARY_CAP = 20;
const TOUCHES_SHOWN = 5;
const OPEN = ["open", "doing", "waiting"] as const;

type Sql = SqlClient.SqlClient;
const titled = (title: string) => title as KinRecord["title"];
const ref = (recordId: string, key: string, title: string): KinRecordRef => ({
  recordId: KinRecordId.make(recordId),
  key,
  title: titled(title),
});
const owned = (kind: string, id: string) =>
  principal(kind, id) ?? { _tag: "person" as const, personId: id as never };

/** When an entry last became `waiting`, from its change log; its last change if none says so. */
export const waitingSince = (sql: Sql, alias: string) => sql`COALESCE((
    SELECT MAX(c.at) FROM kin_record_changes c, json_each(c.fields_json) j
    WHERE c.org_id = ${sql(alias)}.org_id AND c.record_id = ${sql(alias)}.record_id
      AND json_extract(j.value, '$.field') = 'state'
      AND json_extract(j.value, '$.to') = 'waiting'),
  ${sql(alias)}.updated_at)`;

/** The rule, applied on read: never stored and never typed by anyone. */
const healthOf = (input: {
  readonly state: string;
  readonly targetAt: number | null;
  readonly late: number;
  readonly waitingOverAWeek: number;
  readonly now: number;
}): KinProjectHealth | null =>
  input.state === "done" || input.state === "dropped"
    ? null
    : input.targetAt !== null && input.targetAt < input.now
      ? "late"
      : input.late > 0 || input.waitingOverAWeek > 0
        ? "at_risk"
        : "on_track";

type PartyRowSql = {
  readonly recordId: string;
  readonly key: string;
  readonly title: string;
  readonly category: string | null;
  readonly ownerKind: string;
  readonly ownerId: string;
  readonly state: string;
  readonly sensitive: number;
  readonly rev: number;
  readonly fieldsJson: string;
  readonly weOwe: number | null;
  readonly theyOwe: number | null;
  readonly late: number | null;
  readonly overdue: number | null;
};

/** The campaigns these sources name that this viewer sees in Clients, by key. */
export const campaignsNamed = Effect.fn("KinCrm.campaignsNamed")(function* (
  orgId: KinOrgId,
  sources: ReadonlyArray<string | null>,
  viewer: KinViewer,
) {
  const keys = [
    ...new Set(
      sources.flatMap((source) =>
        source?.startsWith(KIN_CAMPAIGN_SOURCE) === true
          ? [source.slice(KIN_CAMPAIGN_SOURCE.length)]
          : [],
      ),
    ),
  ];
  if (keys.length === 0) return new Map<string, KinRecordRef>();
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ recordId: string; key: string; title: string }>`
    SELECT r.record_id AS "recordId", r.key, r.title FROM kin_records r
    WHERE r.org_id = ${orgId} AND r.register_id = 'projects' AND r.key IN ${sql.in(keys)}
      AND ${crmSeenBy(sql, viewer)}
    ORDER BY r.key`;
  return new Map(rows.map((row) => [row.key, ref(row.recordId, row.key, row.title)]));
});

/** A source as read: a campaign by its name, or the word alone for one this viewer can't see. */
export const sourceShown = (
  source: string | null,
  campaigns: ReadonlyMap<string, KinRecordRef>,
) => {
  if (source === null) return {};
  if (!source.startsWith(KIN_CAMPAIGN_SOURCE)) return { source: titled(source) };
  const campaign = campaigns.get(source.slice(KIN_CAMPAIGN_SOURCE.length));
  return campaign === undefined
    ? { source: titled("Campaign") }
    : { source: campaign.title, campaign };
};

/**
 * Clients, prospects and vendors with what each side owes, from one grouped read of the open Work
 * entries `viewer` sees in Clients (`crmSeenBy`): a count or a next step never names work they can't.
 */
const partyRowsWhere = Effect.fn("KinCrm.partyRows")(function* (
  orgId: KinOrgId,
  now: number,
  where: ReadonlyArray<ReturnType<Sql["and"]>>,
  order: "name" | "open" | "attention",
  limit: number,
  offset: number,
  viewer: KinViewer,
) {
  const sql = yield* SqlClient.SqlClient;
  const filter = sql.and([sql`c.org_id = ${orgId}`, sql`c.register_id = 'clients'`, ...where]);
  const rows = yield* sql<PartyRowSql>`
    SELECT c.record_id AS "recordId", c.key, c.title, c.category, c.owner_kind AS "ownerKind",
      c.owner_id AS "ownerId", c.state, c.sensitive, c.rev, c.fields_json AS "fieldsJson",
      n."weOwe", n."theyOwe", n.late, n.overdue
    FROM kin_records c LEFT JOIN (
      SELECT r.party_id, SUM(r.side = 'ours') AS "weOwe", SUM(r.side = 'theirs') AS "theyOwe",
        SUM(r.side = 'ours' AND r.due_at < ${now}) AS late,
        SUM(r.side = 'theirs' AND r.due_at < ${now}) AS overdue
      FROM kin_records r WHERE r.org_id = ${orgId} AND r.register_id = 'work'
        AND r.state IN ${sql.in(OPEN)} AND r.party_id IS NOT NULL AND ${crmSeenBy(sql, viewer)}
      GROUP BY r.party_id) n ON n.party_id = c.record_id
    WHERE ${filter}
    ORDER BY ${
      order === "name"
        ? sql`lower(c.title), c.key`
        : order === "attention"
          ? // Late first, then those with no next step, then by name (the list says so).
            sql`COALESCE(n.late, 0) + COALESCE(n.overdue, 0) = 0,
              c.category = 'vendor' OR COALESCE(n."weOwe", 0) > 0, lower(c.title), c.key`
          : sql`COALESCE(n."weOwe", 0) + COALESCE(n."theyOwe", 0) DESC, lower(c.title), c.key`
    }
    LIMIT ${limit} OFFSET ${offset}`;
  const ids = rows.map((row) => row.recordId);
  const next =
    ids.length === 0
      ? []
      : yield* sql<{
          partyId: string;
          key: string;
          title: string;
          dueAt: number | null;
          dueAllDay: number;
        }>`SELECT party_id AS "partyId", key, title, due_at AS "dueAt", due_all_day AS "dueAllDay"
          FROM (SELECT party_id, key, title, due_at, due_all_day, ROW_NUMBER() OVER (
              PARTITION BY party_id ORDER BY due_at IS NULL, due_at, key) AS n
            FROM kin_records r WHERE r.org_id = ${orgId} AND r.register_id = 'work'
              AND r.side = 'ours' AND r.state IN ${sql.in(OPEN)} AND r.party_id IN ${sql.in(ids)}
              AND ${crmSeenBy(sql, viewer)})
          WHERE n = 1 ORDER BY party_id`;
  const nextBy = new Map(next.map((row) => [row.partyId, row]));
  const last = yield* lastContacts(orgId, ids, now, viewer);
  const campaigns = yield* campaignsNamed(
    orgId,
    rows.map((row) => fieldText(parseFields(row.fieldsJson), "source")),
    viewer,
  );
  return rows.map((row): KinPartyRow => {
    const soonest = nextBy.get(row.recordId);
    const fields = parseFields(row.fieldsJson);
    const source = fieldText(fields, "source");
    const tags = fieldList(fields, "tags");
    return {
      recordId: KinRecordId.make(row.recordId),
      key: row.key,
      name: titled(row.title),
      kind: partyKind(row.category),
      ...(row.category === "prospect" ? { prospect: true as const } : {}),
      ...sourceShown(source, campaigns),
      ...(tags.length === 0 ? {} : { tags: tags.map(titled) }),
      owner: owned(row.ownerKind, row.ownerId),
      active: row.state === "open",
      sensitive: row.sensitive === 1,
      weOwe: row.weOwe ?? 0,
      theyOwe: row.theyOwe ?? 0,
      late: row.late ?? 0,
      overdue: row.overdue ?? 0,
      lastContactAt: last.has(row.recordId) ? iso(last.get(row.recordId)!) : null,
      next:
        soonest === undefined
          ? null
          : {
              key: soonest.key,
              title: titled(soonest.title),
              dueAt: soonest.dueAt === null ? null : iso(soonest.dueAt),
              dueAllDay: soonest.dueAllDay === 1,
              late: soonest.dueAt !== null && soonest.dueAt < now,
            },
      rev: row.rev,
    };
  });
});

type ProjectRowSql = {
  readonly recordId: string;
  readonly key: string;
  readonly title: string;
  readonly partyId: string | null;
  readonly partyKey: string | null;
  readonly partyTitle: string | null;
  readonly partyCategory: string | null;
  readonly partySensitive: number | null;
  readonly category: string | null;
  readonly ownerKind: string;
  readonly ownerId: string;
  readonly state: KinProjectState;
  readonly dueAt: number | null;
  readonly dueAllDay: number;
  readonly sensitive: number;
  readonly rev: number;
  readonly open: number | null;
  readonly late: number | null;
  readonly waitingLong: number | null;
};

/** Projects with their open and late counts and the health those give, in one grouped read. */
const projectRowsWhere = Effect.fn("KinCrm.projectRows")(function* (
  orgId: KinOrgId,
  now: number,
  where: ReadonlyArray<ReturnType<Sql["and"]>>,
  order: "target" | "attention",
  limit: number,
  offset: number,
  viewer: KinViewer,
  seen: typeof seenBy = seenBy,
) {
  const sql = yield* SqlClient.SqlClient;
  const filter = sql.and([sql`p.org_id = ${orgId}`, sql`p.register_id = 'projects'`, ...where]);
  const health = sql`CASE WHEN p.state IN ('done', 'dropped') THEN 3
    WHEN p.due_at < ${now} THEN 0
    WHEN COALESCE(n.late, 0) + COALESCE(n."waitingLong", 0) > 0 THEN 1 ELSE 2 END`;
  const rows = yield* sql<ProjectRowSql>`
    SELECT p.record_id AS "recordId", p.key, p.title, p.party_id AS "partyId",
      pa.key AS "partyKey", pa.title AS "partyTitle", pa.category AS "partyCategory",
      pa.sensitive AS "partySensitive", p.category,
      p.owner_kind AS "ownerKind", p.owner_id AS "ownerId", p.state, p.due_at AS "dueAt",
      p.due_all_day AS "dueAllDay", p.sensitive, p.rev, n.open, n.late, n."waitingLong"
    FROM kin_records p
    LEFT JOIN kin_records pa ON pa.org_id = p.org_id AND pa.record_id = p.party_id
    LEFT JOIN (
      SELECT r.project_id, COUNT(*) AS open,
        SUM(r.due_at IS NOT NULL AND r.due_at < ${now}) AS late,
        SUM(r.state = 'waiting' AND ${waitingSince(sql, "r")} < ${now - WEEK_MS}) AS "waitingLong"
      FROM kin_records r WHERE r.org_id = ${orgId} AND r.register_id = 'work'
        AND r.state IN ${sql.in(OPEN)} AND r.project_id IS NOT NULL AND ${seen(sql, viewer)}
      GROUP BY r.project_id) n ON n.project_id = p.record_id
    WHERE ${filter}
    ORDER BY ${
      order === "target"
        ? sql`p.state IN ('done', 'dropped'), p.due_at IS NULL, p.due_at, lower(p.title), p.key`
        : sql`${health}, p.due_at IS NULL, p.due_at, lower(p.title), p.key`
    }
    LIMIT ${limit} OFFSET ${offset}`;
  return rows.map((row) => {
    const late = row.late ?? 0;
    const waitingOverAWeek = row.waitingLong ?? 0;
    return {
      row: {
        recordId: KinRecordId.make(row.recordId),
        key: row.key,
        name: titled(row.title),
        party:
          row.partyId === null || row.partyKey === null || row.partyTitle === null
            ? null
            : {
                ...ref(row.partyId, row.partyKey, row.partyTitle),
                kind: partyKind(row.partyCategory),
              },
        owner: owned(row.ownerKind, row.ownerId),
        state: row.state,
        targetAt: row.dueAt === null ? null : iso(row.dueAt),
        targetAllDay: row.dueAllDay === 1,
        open: row.open ?? 0,
        late,
        health: healthOf({ state: row.state, targetAt: row.dueAt, late, waitingOverAWeek, now }),
        sensitive: row.sensitive === 1,
        sensitiveInherited: row.partySensitive === 1,
        ...(row.category === "campaign" ? { campaign: true as const } : {}),
        rev: row.rev,
      } satisfies KinProjectRow,
      because: {
        targetPassed:
          row.state !== "done" && row.state !== "dropped" && row.dueAt !== null && row.dueAt < now,
        late,
        waitingOverAWeek,
      },
    };
  });
});

const pageOf = (cursor: string | undefined) => {
  if (cursor === undefined) return Effect.succeed(0);
  const found = /^o:(\d{1,9})$/.exec(cursor);
  return found === null
    ? Effect.fail(
        new KinChatError({ reason: "invalid_state", message: "That page cursor is stale." }),
      )
    : Effect.succeed(Number.parseInt(found[1]!, 10));
};

/** The clients directory: active by default, by name, a page at a time. */
export const parties = Effect.fn("KinCrm.parties")(function* (
  orgId: KinOrgId,
  now: number,
  input: {
    readonly kind?: KinPartyKind | undefined;
    readonly prospect?: true | undefined;
    readonly owner?: KinWorkPrincipal | undefined;
    readonly active?: boolean | undefined;
    readonly text?: string | undefined;
    readonly source?: string | undefined;
    readonly tag?: string | undefined;
    readonly cursor?: string | undefined;
    readonly limit?: number | undefined;
  },
  viewer: KinViewer,
) {
  const sql = yield* SqlClient.SqlClient;
  const offset = yield* pageOf(input.cursor);
  const limit = Math.min(input.limit ?? 50, KIN_RECORDS_PAGE_CAP);
  const where = yield* partiesWhere(orgId, input, viewer);
  const [count] = yield* sql<{ total: number }>`SELECT COUNT(*) AS total FROM kin_records c
    WHERE ${sql.and([sql`c.org_id = ${orgId}`, sql`c.register_id = 'clients'`, ...where])}`;
  const shown = yield* partyRowsWhere(orgId, now, where, "attention", limit, offset, viewer);
  const text = input.text?.trim().toLowerCase() ?? "";
  // A client the words found through a contact, not its own name, says which contact.
  const contacts =
    text === "" || shown.length === 0
      ? []
      : yield* sql<{ partyId: string; title: string }>`SELECT ct.party_id AS "partyId", ct.title
          FROM kin_records ct JOIN kin_records c ON c.org_id = ct.org_id
            AND c.record_id = ct.party_id
          WHERE ct.org_id = ${orgId} AND ct.register_id = 'contacts' AND ct.state = 'open'
            AND ct.party_id IN ${sql.in(shown.map((row) => row.recordId))}
            AND instr(lower(c.title), ${text}) = 0 AND instr(lower(ct.title), ${text}) > 0
            AND ${contactSeen(sql, viewer)}
          ORDER BY ct.party_id, lower(ct.title), ct.key`;
  const contactOf = new Map<string, string>();
  for (const one of contacts)
    if (!contactOf.has(one.partyId)) contactOf.set(one.partyId, one.title);
  const rows = shown.map((row) =>
    contactOf.has(row.recordId) ? { ...row, contact: titled(contactOf.get(row.recordId)!) } : row,
  );
  const total = count?.total ?? 0;
  const next = offset + rows.length;
  return { rows, total, nextCursor: next < total ? `o:${next}` : null };
});

/** What of a client's contacts this viewer reads in Clients, over `ct`. */
const contactSeen = (sql: Sql, viewer: KinViewer) =>
  viewer._tag === "ownerLevel"
    ? sql`1 = 1`
    : sql.and(viewer.people.map((person) => crmSeesAs(sql, person, "ct")));

/** The Clients filter as SQL over `c`, for the list and for the contacts at what it shows. */
export const partiesWhere = Effect.fn("KinCrm.partiesWhere")(function* (
  orgId: KinOrgId,
  input: {
    readonly kind?: KinPartyKind | undefined;
    readonly prospect?: true | undefined;
    readonly owner?: KinWorkPrincipal | undefined;
    readonly active?: boolean | undefined;
    readonly text?: string | undefined;
    readonly source?: string | undefined;
    readonly tag?: string | undefined;
  },
  viewer: KinViewer,
) {
  const sql = yield* SqlClient.SqlClient;
  const spellings =
    input.tag === undefined ? undefined : yield* spellingsOf(orgId, input.tag, viewer);
  return [
    ...(viewer._tag === "ownerLevel"
      ? []
      : viewer.people.map((person) => crmSeesAs(sql, person, "c"))),
    input.active === false ? sql`c.state != 'open'` : sql`c.state = 'open'`,
    ...(input.kind === undefined ? [] : [sql`c.category = ${input.kind}`]),
    ...(input.prospect === true ? [sql`c.category = 'prospect'`] : []),
    ...(input.owner === undefined
      ? []
      : [
          sql`c.owner_kind = ${input.owner._tag} AND c.owner_id = ${
            input.owner._tag === "person" ? input.owner.personId : input.owner.agentId
          }`,
        ]),
    ...(input.text === undefined || input.text.trim() === ""
      ? []
      : [
          sql`(instr(lower(c.title), ${input.text.trim().toLowerCase()}) > 0
            OR EXISTS (SELECT 1 FROM kin_records ct WHERE ct.org_id = c.org_id
              AND ct.register_id = 'contacts' AND ct.party_id = c.record_id AND ct.state = 'open'
              AND ${contactSeen(sql, viewer)}
              AND instr(lower(ct.title), ${input.text.trim().toLowerCase()}) > 0))`,
        ]),
    ...(input.source === undefined
      ? []
      : [sql`json_extract(c.fields_json, '$.source') = ${input.source.trim()}`]),
    ...(spellings === undefined
      ? []
      : [
          sql`(EXISTS (SELECT 1 FROM json_each(c.fields_json, '$.tags') t
              WHERE t.value IN ${sql.in(spellings)})
            OR EXISTS (SELECT 1 FROM kin_records ct, json_each(ct.fields_json, '$.tags') t
              WHERE ct.org_id = c.org_id AND ct.register_id = 'contacts'
                AND ct.party_id = c.record_id AND ct.state = 'open' AND ${contactSeen(sql, viewer)}
                AND t.value IN ${sql.in(spellings)}))`,
        ]),
  ];
});

/** Projects: open by default, soonest target first, a page at a time. */
export const projects = Effect.fn("KinCrm.projects")(function* (
  orgId: KinOrgId,
  now: number,
  input: {
    readonly partyId?: string | undefined;
    readonly state?: KinProjectState | undefined;
    readonly text?: string | undefined;
    readonly person?: string | undefined;
    readonly campaign?: true | undefined;
    readonly cursor?: string | undefined;
    readonly limit?: number | undefined;
  },
  /** Counting, for a person, only what they see. */
  viewer: KinViewer,
) {
  const sql = yield* SqlClient.SqlClient;
  const offset = yield* pageOf(input.cursor);
  const limit = Math.min(input.limit ?? 50, KIN_RECORDS_PAGE_CAP);
  const where = [
    ...(viewer._tag === "ownerLevel"
      ? []
      : viewer.people.map((person) => personSeesAs(sql, person, "p"))),
    sql`p.state = ${input.state ?? "open"}`,
    ...(input.partyId === undefined ? [] : [sql`p.party_id = ${input.partyId}`]),
    ...(input.campaign === true ? [sql`p.category = 'campaign'`] : []),
    ...(input.text === undefined || input.text.trim() === ""
      ? []
      : [sql`instr(lower(p.title), ${input.text.trim().toLowerCase()}) > 0`]),
    ...(input.person === undefined
      ? []
      : [
          sql`((p.owner_kind = 'person' AND p.owner_id = ${input.person})
            OR EXISTS (SELECT 1 FROM json_each(p.fields_json, '$.members') m
              WHERE m.value = 'person:' || ${input.person}))`,
        ]),
  ];
  const [count] = yield* sql<{ total: number }>`SELECT COUNT(*) AS total FROM kin_records p
    WHERE ${sql.and([sql`p.org_id = ${orgId}`, sql`p.register_id = 'projects'`, ...where])}`;
  const rows = yield* projectRowsWhere(orgId, now, where, "target", limit, offset, viewer);
  const total = count?.total ?? 0;
  const next = offset + rows.length;
  return { rows: rows.map((row) => row.row), total, nextCursor: next < total ? `o:${next}` : null };
});

/** The Work screen's clients and projects sections: the busiest and the ones needing attention. */
export const summaryGroups = Effect.fn("KinCrm.summaryGroups")(function* (
  orgId: KinOrgId,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const busy = yield* partyRowsWhere(
    orgId,
    now,
    [sql`c.state = 'open'`, sql`COALESCE(n."weOwe", 0) + COALESCE(n."theyOwe", 0) > 0`],
    "open",
    SUMMARY_CAP,
    0,
    KIN_OWNER_LEVEL,
  );
  const active = yield* projectRowsWhere(
    orgId,
    now,
    [sql`p.state = 'open'`],
    "attention",
    SUMMARY_CAP,
    0,
    KIN_OWNER_LEVEL,
  );
  return {
    parties: busy.map((row) => ({
      party: ref(row.recordId, row.key, row.name),
      weOwe: row.weOwe,
      theyOwe: row.theyOwe,
      late: row.late,
      overdue: row.overdue,
    })),
    projects: active.map(({ row }) => ({
      project: ref(row.recordId, row.key, row.name),
      open: row.open,
      late: row.late,
      health: row.health,
    })),
  };
});

export const toContact = (row: RecordRow): KinContact => {
  const fields = parseFields(row.fieldsJson);
  const text = (key: string) => fieldText(fields, key) as KinContact["role"];
  return {
    recordId: KinRecordId.make(row.recordId),
    key: row.key,
    party: ref(row.partyId ?? "", row.partyKey ?? "", row.partyTitle ?? ""),
    name: titled(row.title),
    role: text("role"),
    email: text("email"),
    phone: text("phone"),
    emails: contactAll(fields, "email"),
    phones: contactAll(fields, "phone"),
    ...(fieldList(fields, "tags").length === 0
      ? {}
      : { tags: fieldList(fields, "tags").map(titled) }),
    notes: row.notes,
    active: row.state === "open",
    sensitive: row.sensitive === 1 || row.inheritedSensitive === 1,
    sensitiveFields: contactSensitive(sensitiveFields("contacts"), fields),
    rev: row.rev,
    updatedAt: iso(row.updatedAt),
  };
};

export const partyDetail = Effect.fn("KinCrm.partyDetail")(function* (
  row: RecordRow,
  now: number,
  viewer: KinViewer,
) {
  const sql = yield* SqlClient.SqlClient;
  const orgId = row.orgId as KinOrgId;
  const [counted] = yield* partyRowsWhere(
    orgId,
    now,
    [sql`c.record_id = ${row.recordId}`],
    "name",
    1,
    0,
    viewer,
  );
  const fields = parseFields(row.fieldsJson);
  return {
    ...counted!,
    notes: row.notes,
    terms: fieldText(fields, "terms"),
    address: fieldText(fields, "address"),
    gstin: fieldText(fields, "gstin"),
    placeOfSupply: fieldText(fields, "placeOfSupply"),
    sensitiveFields: [...sensitiveFields("clients")],
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    closedAt: row.closedAt === null ? null : iso(row.closedAt),
    seq: yield* recordSeq(orgId, row.recordId),
  } satisfies KinPartyDetail;
});

export const projectDetail = Effect.fn("KinCrm.projectDetail")(function* (
  row: RecordRow,
  now: number,
  viewer: KinViewer,
) {
  const sql = yield* SqlClient.SqlClient;
  const orgId = row.orgId as KinOrgId;
  const [counted] = yield* projectRowsWhere(
    orgId,
    now,
    [sql`p.record_id = ${row.recordId}`],
    "target",
    1,
    0,
    viewer,
  );
  const fields = parseFields(row.fieldsJson);
  // Someone in it who doesn't lead it gets no price or terms, which the notes often carry.
  const leads =
    viewer._tag === "ownerLevel" ||
    viewer.people.every((one) => row.ownerKind === "person" && row.ownerId === one);
  const billing = leads ? fieldText(fields, "billing") : null;
  const value = leads ? fields.value : undefined;
  const day = (key: string) => {
    const text = fieldText(fields, key);
    return text !== null && isCalendarDay(text) ? text : null;
  };
  return {
    ...counted!.row,
    notes: leads ? row.notes : "",
    repos: [...fieldList(fields, "repos")],
    billing: KIN_PROJECT_BILLING.find((kind) => kind === billing) ?? null,
    value: value !== undefined && isMoney(value) ? value : null,
    startsOn: day("startsOn"),
    renewsOn: day("renewsOn"),
    members: fieldList(fields, "members").flatMap((text) => {
      const who = principalOfText(text);
      return who === null ? [] : [who];
    }),
    // A campaign turned off keeps its audience for when it returns; its form shows the kept one.
    ...(row.category === "campaign" || fieldText(fields, "audience") !== null
      ? { audience: fieldText(fields, "audience") as KinProjectDetail["audience"] }
      : {}),
    healthBecause: counted!.because,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    closedAt: row.closedAt === null ? null : iso(row.closedAt),
    seq: yield* recordSeq(orgId, row.recordId),
  } satisfies KinProjectDetail;
});

const capped = Effect.fn("KinCrm.capped")(function* (
  orgId: KinOrgId,
  now: number,
  filter: ReturnType<Sql["and"]>,
  order: ReturnType<Sql["and"]>,
  limit: number = KIN_RECORDS_PAGE_CAP / 2,
) {
  const sql = yield* SqlClient.SqlClient;
  const [count] = yield* sql<{ total: number }>`SELECT COUNT(*) AS total FROM kin_records r
    WHERE ${filter}`;
  const rows = yield* sql<RecordRow>`${selectRecords(sql)} WHERE ${filter}
    ORDER BY ${order} LIMIT ${limit}`;
  return { records: rows.map((row) => toRecord(row, now)), total: count?.total ?? 0 };
});

/**
 * One timeline from the change logs of an anchor and everything pointing at it: a client's
 * contacts, projects and entries, or a project's entries. Newest first, before `beforeSeq`.
 */
export const history = Effect.fn("KinCrm.history")(function* (
  anchor: RecordRow,
  input: { readonly beforeSeq?: number; readonly sinceAt?: number; readonly limit: number },
  viewer: KinViewer,
  seen: typeof seenBy = seenBy,
) {
  const sql = yield* SqlClient.SqlClient;
  const orgId = anchor.orgId as KinOrgId;
  const pointing =
    listOf(anchor.registerId) === "projects"
      ? sql`r.project_id = ${anchor.recordId}`
      : sql`r.party_id = ${anchor.recordId}`;
  const filter = sql.and([
    sql`r.org_id = ${orgId}`,
    sql`(r.record_id = ${anchor.recordId} OR ${pointing})`,
    // A doc's history is its versions (`kin.docs.history`); clients older than Docs can't read it.
    sql`r.register_id != 'docs'`,
    seen(sql, viewer),
    ...(input.beforeSeq === undefined ? [] : [sql`c.seq < ${input.beforeSeq}`]),
    ...(input.sinceAt === undefined ? [] : [sql`c.at >= ${input.sinceAt}`]),
  ]);
  const from = sql`FROM kin_records r JOIN kin_record_changes c
    ON c.org_id = r.org_id AND c.record_id = r.record_id WHERE ${filter}`;
  const rows = yield* sql<{
    seq: number;
    at: number;
    actorKind: string;
    actorId: string | null;
    via: KinWorkHistoryItem["via"];
    kind: KinWorkHistoryItem["kind"];
    fieldsJson: string;
    recordId: string;
    key: string;
    title: string;
    registerId: string;
  }>`SELECT c.seq, c.at, c.actor_kind AS "actorKind", c.actor_id AS "actorId", c.via, c.kind,
      c.fields_json AS "fieldsJson", r.record_id AS "recordId", r.key, r.title,
      r.register_id AS "registerId"
    ${from} ORDER BY c.seq DESC LIMIT ${input.limit}`;
  const stages = rows.some((row) => row.registerId === "deals")
    ? (yield* stagesOf(orgId)).stages
    : [];
  const items = rows.map((row): KinWorkHistoryItem => ({
    seq: row.seq,
    at: iso(row.at),
    by: actorOf(row.actorKind, row.actorId),
    via: row.via,
    kind: row.kind,
    fields: parseChanges(row.fieldsJson)
      .filter((change) => change.field.trim() !== "")
      // A deal's stage is the company's id; the line reads its name.
      .map((change) =>
        row.registerId === "deals" && change.field === "stage" ? stageLine(stages, change) : change,
      ),
    record: {
      ...ref(row.recordId, row.key, row.title),
      list: workListOf(row.registerId),
      ...listNameOf(row.registerId),
    },
  }));
  const total =
    input.sinceAt === undefined
      ? undefined
      : ((yield* sql<{ total: number }>`SELECT COUNT(*) AS total ${from}`)[0]?.total ?? 0);
  return { items, total };
});

export const partyPage = Effect.fn("KinCrm.partyPage")(function* (
  row: RecordRow,
  now: number,
  seq: number,
  viewer: KinViewer,
) {
  const sql = yield* SqlClient.SqlClient;
  const orgId = row.orgId as KinOrgId;
  const open = (side: "ours" | "theirs") =>
    sql.and([
      sql`r.org_id = ${orgId}`,
      sql`r.register_id = 'work'`,
      sql`r.party_id = ${row.recordId}`,
      sql`r.side = ${side}`,
      sql`r.state IN ${sql.in(OPEN)}`,
      crmSeenBy(sql, viewer),
    ]);
  const contacts = yield* sql<RecordRow>`${selectRecords(sql)}
    WHERE r.org_id = ${orgId} AND r.register_id = 'contacts' AND r.party_id = ${row.recordId}
      AND ${crmSeenBy(sql, viewer)}
    ORDER BY r.state != 'open', lower(r.title), r.key LIMIT ${KIN_RECORDS_PAGE_CAP}`;
  const projectRows = yield* projectRowsWhere(
    orgId,
    now,
    [
      sql`p.party_id = ${row.recordId}`,
      ...(viewer._tag === "ownerLevel"
        ? []
        : viewer.people.map((person) => crmSeesAs(sql, person, "p"))),
    ],
    "target",
    KIN_RECORDS_PAGE_CAP,
    0,
    viewer,
    crmSeenBy,
  );
  return {
    party: yield* partyDetail(row, now, viewer),
    contacts: contacts.map(toContact),
    projects: projectRows.map((project) => project.row),
    weOwe: yield* capped(orgId, now, open("ours"), sql`r.due_at IS NULL, r.due_at, r.key`),
    theyOwe: yield* capped(
      orgId,
      now,
      open("theirs"),
      sql`(r.due_at IS NOT NULL AND r.due_at < ${now}) DESC, r.due_at IS NULL, r.due_at, r.key`,
    ),
    touches: yield* touchesOf(orgId, row.recordId, now, TOUCHES_SHOWN, viewer),
    seq,
    asOf: iso(now),
  } satisfies KinPartyPage;
});

const pullNumber = (url: string) => {
  const found = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d{1,9})(?:[/?#]|$)/.exec(url)?.[1];
  return found === undefined ? undefined : Number.parseInt(found, 10);
};

export const projectPage = Effect.fn("KinCrm.projectPage")(function* (
  row: RecordRow,
  now: number,
  seq: number,
  viewer: KinViewer,
) {
  const sql = yield* SqlClient.SqlClient;
  const orgId = row.orgId as KinOrgId;
  const inProject = sql`r.org_id = ${orgId} AND r.register_id = 'work'
    AND r.project_id = ${row.recordId} AND ${seenBy(sql, viewer)}`;
  const [counts] = yield* sql<{
    open: number | null;
    doing: number | null;
    waiting: number | null;
    done: number | null;
    dropped: number | null;
    late: number | null;
  }>`SELECT SUM(r.state = 'open') AS open, SUM(r.state = 'doing') AS doing,
      SUM(r.state = 'waiting') AS waiting, SUM(r.state = 'done') AS done,
      SUM(r.state = 'dropped') AS dropped,
      SUM(r.due_at IS NOT NULL AND r.due_at < ${now} AND r.state IN ${sql.in(OPEN)}) AS late
    FROM kin_records r WHERE ${inProject}`;
  const since = yield* sql<{ recordId: string; since: number }>`SELECT r.record_id AS "recordId",
      ${waitingSince(sql, "r")} AS since
    FROM kin_records r WHERE ${inProject} AND r.state = 'waiting'
    ORDER BY since, r.key LIMIT ${KIN_RECORDS_PAGE_CAP / 2}`;
  const waitingRows =
    since.length === 0
      ? []
      : yield* sql<RecordRow>`${selectRecords(sql)}
          WHERE r.org_id = ${orgId} AND r.record_id IN ${sql.in(since.map((row) => row.recordId))}
          ORDER BY r.record_id`;
  const byId = new Map(waitingRows.map((entry) => [entry.recordId, entry]));
  const waiting = since.flatMap((row) => {
    const entry = byId.get(row.recordId);
    return entry === undefined ? [] : [{ entry, since: row.since }];
  });
  const [next] = yield* sql<RecordRow>`${selectRecords(sql)} WHERE ${inProject}
    AND r.state IN ${sql.in(OPEN)} AND r.due_at >= ${now} ORDER BY r.due_at, r.key LIMIT 1`;
  // Linked directly, or through a worker that opened one; only entries still open.
  const pulls = yield* sql<{ url: string; recordId: string; key: string; title: string }>`
    SELECT url, "recordId", key, title FROM (
      SELECT l.target AS url, r.record_id AS "recordId", r.key, r.title
      FROM kin_record_links l JOIN kin_records r
        ON r.org_id = l.org_id AND r.record_id = l.record_id
      WHERE l.org_id = ${orgId} AND l.kind = 'pull_request' AND ${inProject}
        AND r.state IN ${sql.in(OPEN)}
      UNION
      SELECT k.pull_request_url, r.record_id, r.key, r.title
      FROM kin_record_links l JOIN kin_records r
        ON r.org_id = l.org_id AND r.record_id = l.record_id
      JOIN kin_workers k ON k.org_id = l.org_id AND k.worker_id = l.target
      WHERE l.org_id = ${orgId} AND l.kind = 'worker' AND ${inProject}
        AND r.state IN ${sql.in(OPEN)} AND k.pull_request_url IS NOT NULL)
    ORDER BY key, url LIMIT ${KIN_RECORDS_PAGE_CAP}`;
  const seen = new Set<string>();
  const pullRequests = pulls.flatMap((pull) => {
    const number = pullNumber(pull.url);
    if (number === undefined || seen.has(pull.url.toLowerCase())) return [];
    seen.add(pull.url.toLowerCase());
    return [{ url: pull.url, number, record: ref(pull.recordId, pull.key, pull.title) }];
  });
  const week = yield* history(row, { sinceAt: now - WEEK_MS, limit: 20 }, viewer);
  const milestones = yield* milestonesOf(orgId, row.recordId, now, viewer);
  return {
    project: yield* projectDetail(row, now, viewer),
    counts: {
      open: counts?.open ?? 0,
      doing: counts?.doing ?? 0,
      waiting: counts?.waiting ?? 0,
      done: counts?.done ?? 0,
      dropped: counts?.dropped ?? 0,
      late: counts?.late ?? 0,
    },
    blocked: waiting.map(({ entry, since: at }) => {
      const record = toRecord(entry, now);
      const on: KinBlockedOn | null =
        record.waitingOn ??
        (record.party === undefined ? null : { _tag: "party" as const, ...record.party });
      return { record, on, since: iso(at) };
    }),
    nextDue: next === undefined ? null : toRecord(next, now),
    pullRequests,
    changedThisWeek: { items: week.items, total: week.total ?? week.items.length },
    milestones,
    people: yield* peopleOf(row, now, viewer),
    meetings: yield* meetingsOf(orgId, row.recordId, now, viewer),
    specChanged: yield* projectSpecChanges(orgId, row.recordId, viewer),
    money: yield* moneyOf(orgId, row.recordId, viewer),
    seq,
    asOf: iso(now),
  } satisfies KinProjectPage;
});

type Counted = {
  readonly currency: string | null;
  readonly minor: number | null;
  readonly count: number;
};
const countedOf = (rows: ReadonlyArray<Counted>) => ({
  count: rows.reduce((sum, row) => sum + row.count, 0),
  values: rows.flatMap((row) =>
    row.currency === null || row.minor === null
      ? []
      : [{ minor: row.minor, currency: row.currency as KinMoney["currency"] }],
  ),
});

/** Deals at the clients and prospects that came from this campaign, as the viewer sees them. */
export const dealsFromCampaign = (
  sql: SqlClient.SqlClient,
  orgId: KinOrgId,
  key: string,
  viewer: KinViewer,
) =>
  // Its client must be seen too; `crmSeenBy` reads `r`, which inside names the client.
  sql`r.party_id IN (SELECT r.record_id FROM kin_records r
    WHERE r.org_id = ${orgId} AND r.register_id = 'clients'
      AND json_extract(r.fields_json, '$.source') = ${`${KIN_CAMPAIGN_SOURCE}${key}`}
      AND ${crmSeenBy(sql, viewer)})`;

/**
 * A campaign's results, counted from what this viewer reads in Clients (`crmSeenBy`) over every
 * row: one hidden from them is left out of every count, so no count says it is there.
 */
export const campaignResults = Effect.fn("KinCrm.campaignResults")(function* (
  orgId: KinOrgId,
  campaign: RecordRow,
  viewer: KinViewer,
) {
  const sql = yield* SqlClient.SqlClient;
  const source = `${KIN_CAMPAIGN_SOURCE}${campaign.key}`;
  const [parties] = yield* sql<{ prospects: number | null; clients: number | null }>`
    SELECT SUM(r.category = 'prospect') AS prospects, SUM(r.category = 'client') AS clients
    FROM kin_records r WHERE r.org_id = ${orgId} AND r.register_id = 'clients'
      AND r.state = 'open' AND json_extract(r.fields_json, '$.source') = ${source}
      AND ${crmSeenBy(sql, viewer)}`;
  const fromIt = dealsFromCampaign(sql, orgId, campaign.key, viewer);
  const deals = (state: "open" | "done") => sql<Counted>`
    SELECT json_extract(r.fields_json, '$.value.currency') AS currency,
      SUM(json_extract(r.fields_json, '$.value.minor')) AS minor, COUNT(*) AS count
    FROM kin_records r WHERE r.org_id = ${orgId} AND r.register_id = 'deals'
      AND r.state = ${state} AND ${fromIt} AND ${crmSeenBy(sql, viewer)}
    GROUP BY json_extract(r.fields_json, '$.value.currency') ORDER BY currency`;
  const audience = fieldText(parseFields(campaign.fieldsJson), "audience");
  const spellings = audience === null ? [] : yield* spellingsOf(orgId, audience, viewer);
  const [people] =
    spellings.length === 0
      ? [{ n: 0 }]
      : yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_records r
          WHERE r.org_id = ${orgId} AND r.register_id = 'contacts' AND r.state = 'open'
            AND EXISTS (SELECT 1 FROM json_each(r.fields_json, '$.tags') t
              WHERE t.value IN ${sql.in(spellings)})
            AND ${crmSeenBy(sql, viewer)}`;
  return {
    prospects: parties?.prospects ?? 0,
    clients: parties?.clients ?? 0,
    open: countedOf(yield* deals("open")),
    won: countedOf(yield* deals("done")),
    audience: people?.n ?? 0,
  } satisfies KinCampaignResults;
});
