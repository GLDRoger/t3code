import { keyRequestSql } from "../chat/keySent.ts";
import {
  KinChatError,
  KinRecordId,
  type KinClientTouch,
  type KinOrgId,
  type KinTouchKind,
} from "@t3tools/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous id hash, as `paymentIdFor`.
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";

import { type playbookThreshold, playbookThresholds } from "./playbooks.ts";
import { iso, issuedNumber, keptEntry } from "./recordRows.ts";
import { crmSeenBy, KIN_OWNER_LEVEL, type KinViewer } from "./teamView.ts";
import { DAY_MS, HOUR_MS } from "../durations.ts";

/**
 * Contact with a client: what someone logged, and what Kin already holds (an invoice or quote
 * issued, a payment received, a meeting entry that has passed), read together on every read.
 * A chat that mentions a client is not contact. Last contact is the newest of these.
 */

type Sql = SqlClient.SqlClient;
type TouchSql = {
  readonly partyId: string;
  readonly id: string;
  readonly at: number;
  readonly kind: KinClientTouch["kind"];
  readonly note: string;
  readonly who: string | null;
  readonly logged: number;
  readonly byKind: "person" | "agent" | null;
  readonly byName: string | null;
  readonly recordId: string | null;
  readonly key: string | null;
  readonly title: string | null;
  readonly number: unknown;
  /** When Kin learned of it: a contact logged for yesterday today is new to the dream today. */
  readonly recorded: number;
};

// `paid_on` is a day; noon UTC keeps it on that day in every zone a day count cares about.
const paidAt = (sql: Sql) =>
  sql`CAST((julianday(p.paid_on) - 2440587.5) * 86400000 AS INTEGER) + 43200000`;

const touchColumns = (sql: Sql) =>
  sql`"partyId", id, at, kind, note, who, logged, "byKind", "byName", "recordId", key, title,
    "number", recorded`;

/** One logged contact as a row of the union; removed ones only when `removed` is asked. */
const loggedRows = (sql: Sql) => sql`SELECT t.party_id AS "partyId", t.touch_id AS id, t.at,
      t.kind, t.note, COALESCE(wp.display_name, lp.display_name)
        || CASE WHEN ${sql.literal(keyRequestSql("t.origin_key"))} THEN ' (coding agent)' ELSE '' END
        AS who, 1 AS logged,
      t.logged_by_kind AS "byKind", COALESCE(lp.handle, t.logged_by_id) AS "byName",
      NULL AS "recordId", NULL AS key, NULL AS title, NULL AS "number", t.created_at AS recorded
    FROM kin_client_touches t
    LEFT JOIN kin_people wp ON wp.org_id = t.org_id AND wp.person_id = t.person_id
    LEFT JOIN kin_people lp ON t.logged_by_kind = 'person' AND lp.org_id = t.org_id
      AND lp.person_id = t.logged_by_id`;

/**
 * Every contact with these clients, or all of them, up to `now`, one row each, unordered. What
 * Kin read from an entry counts only where `viewer` sees that entry in Clients (`crmSeenBy`).
 */
const touchUnion = (
  sql: Sql,
  orgId: KinOrgId,
  partyIds: ReadonlyArray<string> | "all" | { readonly within: Statement.Fragment },
  now: number,
  viewer: KinViewer,
) => {
  const seen = crmSeenBy(sql, viewer);
  const of = (column: Statement.Fragment) =>
    partyIds === "all"
      ? sql`${column} IS NOT NULL`
      : "within" in partyIds
        ? sql`${column} IN (${partyIds.within})`
        : sql`${column} IN ${sql.in(partyIds)}`;
  // An invoice or quote with no date was sent when it was issued; later edits are not contact.
  const issued = sql`COALESCE(r.date_at, (SELECT n.issued_at FROM kin_issued_numbers n
      WHERE n.org_id = r.org_id AND n.record_id = r.record_id), r.created_at)`;
  return sql`SELECT ${touchColumns(sql)} FROM (
    ${loggedRows(sql)}
    WHERE t.org_id = ${orgId} AND t.removed_at IS NULL AND ${of(sql`t.party_id`)}
    UNION ALL
    SELECT r.party_id, 'record:' || r.key, ${issued},
      CASE r.register_id WHEN 'invoices' THEN 'invoice' WHEN 'quotes' THEN 'quote'
        ELSE 'meeting' END,
      r.title, NULL, 0, NULL, NULL, r.record_id, r.key, r.title,
      json_extract(r.fields_json, '$.number'), ${issued}
    FROM kin_records r
    WHERE r.org_id = ${orgId} AND ${of(sql`r.party_id`)} AND (
      (r.register_id IN ('invoices', 'quotes') AND r.state IN ('waiting', 'done')
        AND ${keptEntry(sql)})
      OR (r.category = 'meeting' AND r.state != 'dropped' AND r.date_at IS NOT NULL))
      AND ${seen}
    UNION ALL
    SELECT r.party_id, 'payment:' || p.payment_id, ${paidAt(sql)}, 'payment', r.title, NULL, 0,
      NULL, NULL, r.record_id, r.key, r.title, json_extract(r.fields_json, '$.number'),
      p.created_at
    FROM kin_record_payments p
    JOIN kin_records r ON r.org_id = p.org_id AND r.record_id = p.record_id
    WHERE p.org_id = ${orgId} AND p.voided_at IS NULL AND p.withheld = 0
      AND ${keptEntry(sql)} AND ${of(sql`r.party_id`)} AND ${seen}
  ) WHERE at <= ${now}`;
};

const toTouch = (row: TouchSql): KinClientTouch => ({
  id: row.id,
  at: iso(row.at),
  kind: row.kind,
  note: row.note,
  who: (row.who ?? null) as KinClientTouch["who"],
  logged: row.logged === 1,
  record:
    row.recordId === null || row.key === null || row.title === null
      ? null
      : {
          recordId: KinRecordId.make(row.recordId),
          key: row.key,
          title: row.title as NonNullable<KinClientTouch["record"]>["title"],
        },
  ...issuedNumber(row.number),
});

/** A client's contacts, newest first. */
export const touchesOf = Effect.fn("KinTouches.of")(function* (
  orgId: KinOrgId,
  partyId: string,
  now: number,
  limit: number,
  viewer: KinViewer = KIN_OWNER_LEVEL,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<TouchSql>`${touchUnion(sql, orgId, [partyId], now, viewer)}
    ORDER BY at DESC, id LIMIT ${limit}`;
  return rows.map(toTouch);
});

/** Each client's last contact and its kind; clients with none are absent. */
const newestContacts = Effect.fn("KinTouches.newest")(function* (
  orgId: KinOrgId,
  partyIds: ReadonlyArray<string>,
  now: number,
  viewer: KinViewer,
  sections = { invoices: true, money: true },
) {
  if (partyIds.length === 0) return new Map<string, { at: number; kind: TouchSql["kind"] }>();
  const sql = yield* SqlClient.SqlClient;
  // SQLite takes the bare `kind` from the row MAX(at) picks.
  const rows = yield* sql<{ partyId: string; at: number; kind: TouchSql["kind"] }>`SELECT
      "partyId", MAX(at) AS at, kind
    FROM (${touchUnion(sql, orgId, partyIds, now, viewer)})
    WHERE (${sections.invoices} OR kind NOT IN ('invoice', 'quote'))
      AND (${sections.money} OR kind != 'payment')
    GROUP BY "partyId" ORDER BY "partyId"`;
  return new Map(rows.map((row) => [row.partyId, { at: row.at, kind: row.kind }]));
});

/** Each client's last contact as rows `("partyId", at)`, for the clients a subquery names. */
export const lastContactRows = (
  sql: Sql,
  orgId: KinOrgId,
  within: Statement.Fragment,
  now: number,
  viewer: KinViewer,
) => sql`SELECT "partyId", MAX(at) AS at
  FROM (${touchUnion(sql, orgId, { within }, now, viewer)}) GROUP BY "partyId"`;

/** Each client's last contact, epoch ms; clients with none are absent. */
export const lastContacts = Effect.fn("KinTouches.last")(function* (
  orgId: KinOrgId,
  partyIds: ReadonlyArray<string>,
  now: number,
  viewer: KinViewer = KIN_OWNER_LEVEL,
) {
  const newest = yield* newestContacts(orgId, partyIds, now, viewer);
  return new Map([...newest].map(([partyId, one]) => [partyId, one.at]));
});

export const daysSince = (at: number, now: number) => Math.max(0, Math.floor((now - at) / DAY_MS));
/** When we last finished a project for this client, epoch ms, as a scalar subquery; null if never. */
export const lastProjectDone = (
  sql: Sql,
  org: Statement.Fragment,
  party: Statement.Fragment,
  now: number,
) => sql`(SELECT MAX(dp.closed_at) FROM kin_records dp WHERE dp.org_id = ${org}
    AND dp.register_id = 'projects' AND dp.party_id = ${party} AND dp.state = 'done'
    AND dp.closed_at <= ${now})`;

/** `daysSince(at, now) >= days` in SQL, for days of 1 or more. */
export const quietFor = (sql: Sql, at: Statement.Fragment, now: number, days: Statement.Fragment) =>
  sql`${now} - ${at} >= ${DAY_MS} * ${days}`;

/** "No logged contact for 12 days", or null while contact is recent. */
export const quietLine = (lastAt: number | null, createdAt: number, now: number) => {
  const days = daysSince(lastAt ?? createdAt, now);
  if (days < 7) return null;
  return lastAt === null
    ? `No contact logged since they were added ${days} days ago`
    : `No logged contact for ${days} days`;
};

export const logTouch = Effect.fn("KinTouches.log")(function* (
  orgId: KinOrgId,
  input: {
    readonly partyId: string;
    readonly kind: KinTouchKind;
    readonly at: number;
    readonly note: string;
    readonly personId: string | null;
    readonly by: { readonly kind: "person" | "agent"; readonly id: string };
    readonly originKey: string;
    readonly now: number;
  },
) {
  const sql = yield* SqlClient.SqlClient;
  if (!Number.isSafeInteger(input.at) || input.at < 0 || input.at > input.now + DAY_MS)
    return yield* new KinChatError({
      reason: "invalid_state",
      message: "Contact is logged when it happened, not ahead of time.",
    });
  const touchId = `tch_${NodeCrypto.createHash("sha256").update(`${orgId.length}:${orgId}${input.originKey}`).digest("hex").slice(0, 20)}`;
  yield* sql`INSERT INTO kin_client_touches (org_id, touch_id, party_id, at, kind, person_id,
      note, logged_by_kind, logged_by_id, origin_key, created_at)
    VALUES (${orgId}, ${touchId}, ${input.partyId}, ${input.at}, ${input.kind},
      ${input.personId}, ${input.note.trim()}, ${input.by.kind}, ${input.by.id},
      ${input.originKey}, ${input.now})
    ON CONFLICT (org_id, origin_key) DO NOTHING`;
  const [stored] = yield* sql<{ touchId: string; partyId: string }>`SELECT touch_id AS "touchId",
      party_id AS "partyId" FROM kin_client_touches
    WHERE org_id = ${orgId} AND origin_key = ${input.originKey} ORDER BY touch_id`;
  if (stored === undefined || stored.partyId !== input.partyId)
    return yield* new KinChatError({
      reason: "not_allowed",
      message: "That retry names a different client.",
    });
  // Read apart from the visible union: a retry after the owner removed it answers, and stays removed.
  const [row] = yield* sql<TouchSql>`${loggedRows(sql)}
    WHERE t.org_id = ${orgId} AND t.touch_id = ${stored.touchId}`;
  return toTouch(row!);
});

/** Who logged a contact still showing, and on which client; undefined for any other id. */
export const loggedBy = Effect.fn("KinTouches.loggedBy")(function* (
  orgId: KinOrgId,
  touchId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ partyId: string; byKind: string; byId: string }>`SELECT
      party_id AS "partyId", logged_by_kind AS "byKind", logged_by_id AS "byId"
    FROM kin_client_touches
    WHERE org_id = ${orgId} AND touch_id = ${touchId} AND removed_at IS NULL`;
  return row;
});

/** Only a logged one goes; what Kin knows from its records stays as long as they do. */
export const removeTouch = Effect.fn("KinTouches.remove")(function* (
  orgId: KinOrgId,
  touchId: string,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ touchId: string }>`UPDATE kin_client_touches SET removed_at = ${now}
    WHERE org_id = ${orgId} AND touch_id = ${touchId} AND removed_at IS NULL
    RETURNING touch_id AS "touchId"`;
  return rows.length > 0;
});

type ClientLimitKey = "client_checkin_days" | "client_cold_after_days" | "reply_owed_hours";

export type ClientSense = {
  readonly sense: "client_quiet" | "client_cold" | "client_waiting_on_us";
  readonly partyId: string;
  readonly key: string;
  readonly name: string;
  readonly sensitive: boolean;
  /** Last contact, epoch ms, and what it was, or null when there has been none. */
  readonly lastAt: number | null;
  readonly lastKind: KinClientTouch["kind"] | null;
  readonly days: number;
  /** What `days` counts from: the last contact, the last project we finished, or their adding. */
  readonly from: "contact" | "project" | "added";
  /** When it became true, epoch ms. */
  readonly since: number;
  /** What makes this one episode: a new contact starts another. */
  readonly episode: string;
  /** Hours the oldest thing we owe them is past due, and when it fell due. */
  readonly late?: number;
  readonly dueAt?: number;
  /** The playbook value it crossed, and where that value came from. */
  readonly limit: Effect.Success<ReturnType<typeof playbookThreshold>>;
};

/**
 * Each open client or prospect with its project and owed-work facts. Grouped once per register,
 * not per client: a correlated subquery per client walks every open work row on the register index.
 */
export const clientRows = Effect.fn("KinTouches.clientRows")(function* (
  orgId: KinOrgId,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    partyId: string;
    key: string;
    title: string;
    sensitive: number;
    prospect: number;
    createdAt: number;
    openProjects: number;
    lastProjectAt: number | null;
    dueAt: number | null;
  }>`SELECT c.record_id AS "partyId", c.key, c.title, c.sensitive, c.created_at AS "createdAt",
      COALESCE(c.category, 'client') = 'prospect' AS prospect,
      p.last_at AS "lastProjectAt", COALESCE(p.open, 0) AS "openProjects", w.due_at AS "dueAt"
    FROM kin_records c
    LEFT JOIN (SELECT party_id,
        -- lastProjectDone, grouped once per register; project health reads the same rule.
        MAX(CASE WHEN state = 'done' AND closed_at <= ${now} THEN closed_at END) AS last_at,
        SUM(state = 'open') AS open
      FROM kin_records WHERE org_id = ${orgId} AND register_id = 'projects'
        AND state IN ('done', 'open')
      GROUP BY party_id) p ON p.party_id = c.record_id
    LEFT JOIN (SELECT party_id, MIN(due_at) AS due_at FROM kin_records
      WHERE org_id = ${orgId} AND register_id = 'work' AND side = 'ours'
        AND category = 'obligation' AND state IN ('open', 'doing', 'waiting') AND due_at < ${now}
      GROUP BY party_id) w ON w.party_id = c.record_id
    WHERE c.org_id = ${orgId} AND c.register_id = 'clients' AND c.state = 'open'
      AND COALESCE(c.category, 'client') IN ('client', 'prospect')
    ORDER BY c.key`;
});

/**
 * The client senses on each client's playbook values: cold (`client_cold_after_days`, no open
 * project), quiet (`client_checkin_days`, during one), waiting on us (`reply_owed_hours` past an
 * obligation's due). Days count from the last contact or finished project, else its adding. A
 * prospect is no client yet: never cold or quiet, though what we owe it still waits on us.
 */
export const clientSenses = Effect.fn("KinTouches.senses")(function* (
  orgId: KinOrgId,
  now: number,
  sections?: { readonly invoices: boolean; readonly money: boolean },
) {
  const clients = yield* clientRows(orgId, now);
  const lookup = yield* playbookThresholds(orgId);
  const last = yield* newestContacts(
    orgId,
    clients.map((client) => client.partyId),
    now,
    KIN_OWNER_LEVEL,
    sections,
  );
  const senses: Array<ClientSense> = [];
  for (const client of clients) {
    const newest = last.get(client.partyId);
    const lastAt = newest?.at ?? null;
    // Work we finished for them is contact too: silence counts from whichever came last, and
    // from when the client was added only with neither (one added with its history isn't new).
    const from =
      lastAt === null && client.lastProjectAt === null
        ? client.createdAt
        : Math.max(lastAt ?? 0, client.lastProjectAt ?? 0);
    const days = daysSince(from, now);
    const base = {
      partyId: client.partyId,
      key: client.key,
      name: client.title,
      sensitive: client.sensitive === 1,
      lastAt,
      lastKind: newest?.kind ?? null,
      days,
      from:
        lastAt === null && client.lastProjectAt === null
          ? ("added" as const)
          : (client.lastProjectAt ?? 0) > (lastAt ?? 0)
            ? ("project" as const)
            : ("contact" as const),
      episode: `${client.key}:${lastAt ?? "never"}`,
    };
    const limit = (key: ClientLimitKey) => lookup(key, client.partyId);
    const quiet =
      client.openProjects > 0 && client.prospect === 0 ? limit("client_checkin_days") : undefined;
    if (quiet !== undefined && days >= quiet.value)
      senses.push({
        ...base,
        sense: "client_quiet",
        since: from + quiet.value * DAY_MS,
        limit: quiet,
      });
    const cold =
      client.openProjects === 0 && client.prospect === 0
        ? limit("client_cold_after_days")
        : undefined;
    if (cold !== undefined && days >= cold.value)
      senses.push({
        ...base,
        sense: "client_cold",
        since: from + cold.value * DAY_MS,
        limit: cold,
      });
    if (client.dueAt === null) continue;
    const owed = limit("reply_owed_hours");
    const since = client.dueAt + owed.value * HOUR_MS;
    if (now >= since)
      senses.push({
        ...base,
        sense: "client_waiting_on_us",
        since,
        late: Math.floor((now - client.dueAt) / HOUR_MS),
        dueAt: client.dueAt,
        episode: `${client.key}:late:${client.dueAt}`,
        limit: owed,
      });
  }
  return senses;
});

/**
 * Every contact that happened, or that Kin learned of, in `(from, until]`, with its client, for
 * the dream. Who logged it by hand says who stated it; what Kin read from its records is Kin's.
 */
export const touchesBetween = Effect.fn("KinTouches.between")(function* (
  orgId: KinOrgId,
  from: number,
  until: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<TouchSql & { clientKey: string; clientName: string }>`
    SELECT u."partyId", u.id, u.at, u.kind, u.note, u.who, u.logged, u."byKind", u."byName",
      u."recordId", u.key, u.title, c.key AS "clientKey", c.title AS "clientName"
    FROM (${touchUnion(sql, orgId, "all", until, KIN_OWNER_LEVEL)}) u
    JOIN kin_records c ON c.org_id = ${orgId} AND c.record_id = u."partyId"
    WHERE (u.at > ${from} OR u.recorded > ${from}) AND u.recorded <= ${until}
    ORDER BY u.at, u.id`;
  return rows.map((row) => ({
    ...toTouch(row),
    client: { key: row.clientKey, name: row.clientName },
    by: row.byKind === null ? null : { kind: row.byKind, name: row.byName ?? "someone" },
  }));
});
