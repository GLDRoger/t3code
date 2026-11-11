import {
  KIN_RECORDS_PAGE_CAP,
  KinChatError,
  KinRecordId,
  type KinBlockedOn,
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
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { fieldList, fieldText, listOf, parseFields, sensitiveFields } from "./lists.ts";
import {
  actorOf,
  iso,
  parseChanges,
  principal,
  type RecordRow,
  recordSeq,
  selectRecords,
  toRecord,
} from "./recordRows.ts";

/**
 * The light CRM's read model: the client page, the project page and their history, computed on
 * every read from entries and their change logs. Nothing here is stored, and every query and join
 * stays inside one org. Callers check who may read; this answers for the owner.
 */

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const SUMMARY_CAP = 20;
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
const waitingSince = (sql: Sql, alias: string) => sql`COALESCE((
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
  readonly weOwe: number | null;
  readonly theyOwe: number | null;
  readonly late: number | null;
  readonly overdue: number | null;
};

/** Clients and vendors with what each side owes, from one grouped read of open Work entries. */
const partyRowsWhere = Effect.fn("KinCrm.partyRows")(function* (
  orgId: KinOrgId,
  now: number,
  where: ReadonlyArray<ReturnType<Sql["and"]>>,
  order: "name" | "open",
  limit: number,
  offset = 0,
) {
  const sql = yield* SqlClient.SqlClient;
  const filter = sql.and([sql`c.org_id = ${orgId}`, sql`c.register_id = 'clients'`, ...where]);
  const rows = yield* sql<PartyRowSql>`
    SELECT c.record_id AS "recordId", c.key, c.title, c.category, c.owner_kind AS "ownerKind",
      c.owner_id AS "ownerId", c.state, c.sensitive, c.rev, n."weOwe", n."theyOwe", n.late,
      n.overdue
    FROM kin_records c LEFT JOIN (
      SELECT party_id, SUM(side = 'ours') AS "weOwe", SUM(side = 'theirs') AS "theyOwe",
        SUM(side = 'ours' AND due_at < ${now}) AS late,
        SUM(side = 'theirs' AND due_at < ${now}) AS overdue
      FROM kin_records WHERE org_id = ${orgId} AND register_id = 'work'
        AND state IN ${sql.in(OPEN)} AND party_id IS NOT NULL
      GROUP BY party_id) n ON n.party_id = c.record_id
    WHERE ${filter}
    ORDER BY ${
      order === "name"
        ? sql`lower(c.title), c.key`
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
            FROM kin_records WHERE org_id = ${orgId} AND register_id = 'work' AND side = 'ours'
              AND state IN ${sql.in(OPEN)} AND party_id IN ${sql.in(ids)})
          WHERE n = 1 ORDER BY party_id`;
  const nextBy = new Map(next.map((row) => [row.partyId, row]));
  return rows.map((row): KinPartyRow => {
    const soonest = nextBy.get(row.recordId);
    return {
      recordId: KinRecordId.make(row.recordId),
      key: row.key,
      name: titled(row.title),
      kind: (row.category === "vendor" ? "vendor" : "client") satisfies KinPartyKind,
      owner: owned(row.ownerKind, row.ownerId),
      active: row.state === "open",
      sensitive: row.sensitive === 1,
      weOwe: row.weOwe ?? 0,
      theyOwe: row.theyOwe ?? 0,
      late: row.late ?? 0,
      overdue: row.overdue ?? 0,
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
  readonly partySensitive: number | null;
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
  offset = 0,
) {
  const sql = yield* SqlClient.SqlClient;
  const filter = sql.and([sql`p.org_id = ${orgId}`, sql`p.register_id = 'projects'`, ...where]);
  const health = sql`CASE WHEN p.state IN ('done', 'dropped') THEN 3
    WHEN p.due_at < ${now} THEN 0
    WHEN COALESCE(n.late, 0) + COALESCE(n."waitingLong", 0) > 0 THEN 1 ELSE 2 END`;
  const rows = yield* sql<ProjectRowSql>`
    SELECT p.record_id AS "recordId", p.key, p.title, p.party_id AS "partyId",
      pa.key AS "partyKey", pa.title AS "partyTitle", pa.sensitive AS "partySensitive",
      p.owner_kind AS "ownerKind", p.owner_id AS "ownerId", p.state, p.due_at AS "dueAt",
      p.due_all_day AS "dueAllDay", p.sensitive, p.rev, n.open, n.late, n."waitingLong"
    FROM kin_records p
    LEFT JOIN kin_records pa ON pa.org_id = p.org_id AND pa.record_id = p.party_id
    LEFT JOIN (
      SELECT w.project_id, COUNT(*) AS open,
        SUM(w.due_at IS NOT NULL AND w.due_at < ${now}) AS late,
        SUM(w.state = 'waiting' AND ${waitingSince(sql, "w")} < ${now - WEEK_MS}) AS "waitingLong"
      FROM kin_records w WHERE w.org_id = ${orgId} AND w.register_id = 'work'
        AND w.state IN ${sql.in(OPEN)} AND w.project_id IS NOT NULL
      GROUP BY w.project_id) n ON n.project_id = p.record_id
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
            : ref(row.partyId, row.partyKey, row.partyTitle),
        owner: owned(row.ownerKind, row.ownerId),
        state: row.state,
        targetAt: row.dueAt === null ? null : iso(row.dueAt),
        targetAllDay: row.dueAllDay === 1,
        open: row.open ?? 0,
        late,
        health: healthOf({ state: row.state, targetAt: row.dueAt, late, waitingOverAWeek, now }),
        sensitive: row.sensitive === 1,
        sensitiveInherited: row.partySensitive === 1,
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
    readonly active?: boolean | undefined;
    readonly text?: string | undefined;
    readonly cursor?: string | undefined;
    readonly limit?: number | undefined;
  },
) {
  const sql = yield* SqlClient.SqlClient;
  const offset = yield* pageOf(input.cursor);
  const limit = Math.min(input.limit ?? 50, KIN_RECORDS_PAGE_CAP);
  const where = [
    input.active === false ? sql`c.state != 'open'` : sql`c.state = 'open'`,
    ...(input.kind === undefined ? [] : [sql`c.category = ${input.kind}`]),
    ...(input.text === undefined || input.text.trim() === ""
      ? []
      : [sql`instr(lower(c.title), ${input.text.trim().toLowerCase()}) > 0`]),
  ];
  const [count] = yield* sql<{ total: number }>`SELECT COUNT(*) AS total FROM kin_records c
    WHERE ${sql.and([sql`c.org_id = ${orgId}`, sql`c.register_id = 'clients'`, ...where])}`;
  const rows = yield* partyRowsWhere(orgId, now, where, "name", limit, offset);
  const total = count?.total ?? 0;
  const next = offset + rows.length;
  return { rows, total, nextCursor: next < total ? `o:${next}` : null };
});

/** Projects: open by default, soonest target first, a page at a time. */
export const projects = Effect.fn("KinCrm.projects")(function* (
  orgId: KinOrgId,
  now: number,
  input: {
    readonly partyId?: string | undefined;
    readonly state?: KinProjectState | undefined;
    readonly text?: string | undefined;
    readonly cursor?: string | undefined;
    readonly limit?: number | undefined;
  },
) {
  const sql = yield* SqlClient.SqlClient;
  const offset = yield* pageOf(input.cursor);
  const limit = Math.min(input.limit ?? 50, KIN_RECORDS_PAGE_CAP);
  const where = [
    sql`p.state = ${input.state ?? "open"}`,
    ...(input.partyId === undefined ? [] : [sql`p.party_id = ${input.partyId}`]),
    ...(input.text === undefined || input.text.trim() === ""
      ? []
      : [sql`instr(lower(p.title), ${input.text.trim().toLowerCase()}) > 0`]),
  ];
  const [count] = yield* sql<{ total: number }>`SELECT COUNT(*) AS total FROM kin_records p
    WHERE ${sql.and([sql`p.org_id = ${orgId}`, sql`p.register_id = 'projects'`, ...where])}`;
  const rows = yield* projectRowsWhere(orgId, now, where, "target", limit, offset);
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
  );
  const active = yield* projectRowsWhere(
    orgId,
    now,
    [sql`p.state = 'open'`],
    "attention",
    SUMMARY_CAP,
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
    notes: row.notes,
    active: row.state === "open",
    sensitive: row.sensitive === 1 || row.inheritedSensitive === 1,
    sensitiveFields: [...sensitiveFields("contacts")],
    rev: row.rev,
    updatedAt: iso(row.updatedAt),
  };
};

export const partyDetail = Effect.fn("KinCrm.partyDetail")(function* (row: RecordRow, now: number) {
  const sql = yield* SqlClient.SqlClient;
  const orgId = row.orgId as KinOrgId;
  const [counted] = yield* partyRowsWhere(
    orgId,
    now,
    [sql`c.record_id = ${row.recordId}`],
    "name",
    1,
  );
  const fields = parseFields(row.fieldsJson);
  return {
    ...counted!,
    notes: row.notes,
    terms: fieldText(fields, "terms"),
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
) {
  const sql = yield* SqlClient.SqlClient;
  const orgId = row.orgId as KinOrgId;
  const [counted] = yield* projectRowsWhere(
    orgId,
    now,
    [sql`p.record_id = ${row.recordId}`],
    "target",
    1,
  );
  const fields = parseFields(row.fieldsJson);
  return {
    ...counted!.row,
    notes: row.notes,
    repos: [...fieldList(fields, "repos")],
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
    ...(input.beforeSeq === undefined ? [] : [sql`c.seq < ${input.beforeSeq}`]),
    ...(input.sinceAt === undefined ? [] : [sql`c.at >= ${input.sinceAt}`]),
  ]);
  const from = sql`FROM kin_records r JOIN kin_record_changes c
    ON c.org_id = r.org_id AND c.record_id = r.record_id`;
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
    ${from} WHERE ${filter} ORDER BY c.seq DESC LIMIT ${input.limit}`;
  const items = rows.map((row): KinWorkHistoryItem => ({
    seq: row.seq,
    at: iso(row.at),
    by: actorOf(row.actorKind, row.actorId),
    via: row.via,
    kind: row.kind,
    fields: parseChanges(row.fieldsJson).filter((change) => change.field.trim() !== ""),
    record: { ...ref(row.recordId, row.key, row.title), list: listOf(row.registerId) },
  }));
  const total =
    input.sinceAt === undefined
      ? undefined
      : ((yield* sql<{ total: number }>`SELECT COUNT(*) AS total ${from} WHERE ${filter}`)[0]
          ?.total ?? 0);
  return { items, total };
});

export const partyPage = Effect.fn("KinCrm.partyPage")(function* (
  row: RecordRow,
  now: number,
  seq: number,
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
    ]);
  const contacts = yield* sql<RecordRow>`${selectRecords(sql)}
    WHERE r.org_id = ${orgId} AND r.register_id = 'contacts' AND r.party_id = ${row.recordId}
    ORDER BY r.state != 'open', lower(r.title), r.key LIMIT ${KIN_RECORDS_PAGE_CAP}`;
  const projectRows = yield* projectRowsWhere(
    orgId,
    now,
    [sql`p.party_id = ${row.recordId}`],
    "target",
    KIN_RECORDS_PAGE_CAP,
  );
  return {
    party: yield* partyDetail(row, now),
    contacts: contacts.map(toContact),
    projects: projectRows.map((project) => project.row),
    weOwe: yield* capped(orgId, now, open("ours"), sql`r.due_at IS NULL, r.due_at, r.key`),
    theyOwe: yield* capped(
      orgId,
      now,
      open("theirs"),
      sql`(r.due_at IS NOT NULL AND r.due_at < ${now}) DESC, r.due_at IS NULL, r.due_at, r.key`,
    ),
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
) {
  const sql = yield* SqlClient.SqlClient;
  const orgId = row.orgId as KinOrgId;
  const inProject = sql`r.org_id = ${orgId} AND r.register_id = 'work'
    AND r.project_id = ${row.recordId}`;
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
  const week = yield* history(row, { sinceAt: now - WEEK_MS, limit: 20 });
  return {
    project: yield* projectDetail(row, now),
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
    seq,
    asOf: iso(now),
  } satisfies KinProjectPage;
});
