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

import { iso } from "./recordRows.ts";

/**
 * Contact with a client: what someone logged, and what Kin already holds (an invoice or quote
 * issued, a payment received, a meeting entry that has passed), read together on every read.
 * A chat that mentions a client is not contact. Last contact is the newest of these.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** No logged contact and no open project for this long: gone cold. */
const COLD_DAYS = 45;
/** During an open project, this long without contact is quiet. */
const QUIET_DAYS = 10;

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
};

// `paid_on` is a day; noon UTC keeps it on that day in every zone a day count cares about.
const paidAt = (sql: Sql) =>
  sql`CAST((julianday(p.paid_on) - 2440587.5) * 86400000 AS INTEGER) + 43200000`;

/** Every contact with these clients, or all of them, up to `now`, one row each, unordered. */
const touchUnion = (
  sql: Sql,
  orgId: KinOrgId,
  partyIds: ReadonlyArray<string> | "all",
  now: number,
) => {
  const of = (column: Statement.Fragment) =>
    partyIds === "all" ? sql`${column} IS NOT NULL` : sql`${column} IN ${sql.in(partyIds)}`;
  return sql`SELECT * FROM (
    SELECT t.party_id AS "partyId", t.touch_id AS id, t.at, t.kind, t.note,
      COALESCE(wp.display_name, lp.display_name) AS who, 1 AS logged,
      t.logged_by_kind AS "byKind", COALESCE(lp.handle, t.logged_by_id) AS "byName",
      NULL AS "recordId", NULL AS key, NULL AS title
    FROM kin_client_touches t
    LEFT JOIN kin_people wp ON wp.org_id = t.org_id AND wp.person_id = t.person_id
    LEFT JOIN kin_people lp ON t.logged_by_kind = 'person' AND lp.org_id = t.org_id
      AND lp.person_id = t.logged_by_id
    WHERE t.org_id = ${orgId} AND t.removed_at IS NULL AND ${of(sql`t.party_id`)}
    UNION ALL
    SELECT r.party_id, 'record:' || r.key, COALESCE(r.date_at, r.updated_at),
      CASE r.register_id WHEN 'invoices' THEN 'invoice' WHEN 'quotes' THEN 'quote'
        ELSE 'meeting' END,
      r.title, NULL, 0, NULL, NULL, r.record_id, r.key, r.title
    FROM kin_records r
    WHERE r.org_id = ${orgId} AND ${of(sql`r.party_id`)} AND (
      (r.register_id IN ('invoices', 'quotes') AND r.state IN ('waiting', 'done'))
      OR (r.category = 'meeting' AND r.state != 'dropped' AND r.date_at IS NOT NULL))
    UNION ALL
    SELECT r.party_id, 'payment:' || p.payment_id, ${paidAt(sql)}, 'payment', r.title, NULL, 0,
      NULL, NULL, r.record_id, r.key, r.title
    FROM kin_record_payments p
    JOIN kin_records r ON r.org_id = p.org_id AND r.record_id = p.record_id
    WHERE p.org_id = ${orgId} AND p.voided_at IS NULL AND p.withheld = 0
      AND ${of(sql`r.party_id`)}
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
});

/** A client's contacts, newest first. */
export const touchesOf = Effect.fn("KinTouches.of")(function* (
  orgId: KinOrgId,
  partyId: string,
  now: number,
  limit: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<TouchSql>`${touchUnion(sql, orgId, [partyId], now)}
    ORDER BY at DESC, id LIMIT ${limit}`;
  return rows.map(toTouch);
});

/** Each client's last contact, epoch ms; clients with none are absent. */
export const lastContacts = Effect.fn("KinTouches.last")(function* (
  orgId: KinOrgId,
  partyIds: ReadonlyArray<string>,
  now: number,
) {
  if (partyIds.length === 0) return new Map<string, number>();
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ partyId: string; at: number }>`SELECT "partyId", MAX(at) AS at
    FROM (${touchUnion(sql, orgId, partyIds, now)}) GROUP BY "partyId" ORDER BY "partyId"`;
  return new Map(rows.map((row) => [row.partyId, row.at]));
});

export const daysSince = (at: number, now: number) => Math.max(0, Math.floor((now - at) / DAY_MS));

/** "No logged contact for 12 days", or null while contact is recent. */
export const quietLine = (lastAt: number | null, createdAt: number, now: number) => {
  const days = daysSince(lastAt ?? createdAt, now);
  return days < 7 ? null : `No logged contact for ${days} days`;
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
  const [row] =
    yield* sql<TouchSql>`SELECT * FROM (${touchUnion(sql, orgId, [input.partyId], input.now + DAY_MS)})
    WHERE id = ${stored.touchId}`;
  return toTouch(row!);
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

export type ClientSense = {
  readonly sense: "client_quiet" | "client_cold" | "client_waiting_on_us";
  readonly partyId: string;
  readonly key: string;
  readonly name: string;
  /** Last contact, epoch ms, or null when there has been none. */
  readonly lastAt: number | null;
  readonly days: number;
  /** What makes this one episode: a new contact starts another. */
  readonly episode: string;
  readonly late?: number;
};

/**
 * The client senses, for the pulse: cold after `COLD_DAYS` without contact and no open project,
 * quiet after `QUIET_DAYS` during one, waiting on us while something we owe them is late. Days
 * count from the client's creation when there has never been contact.
 */
export const clientSenses = Effect.fn("KinTouches.senses")(function* (
  orgId: KinOrgId,
  now: number,
  thresholds: { readonly coldDays: number; readonly quietDays: number } = {
    coldDays: COLD_DAYS,
    quietDays: QUIET_DAYS,
  },
) {
  const sql = yield* SqlClient.SqlClient;
  const clients = yield* sql<{
    partyId: string;
    key: string;
    title: string;
    createdAt: number;
    openProjects: number;
    late: number;
  }>`SELECT c.record_id AS "partyId", c.key, c.title, c.created_at AS "createdAt",
      (SELECT COUNT(*) FROM kin_records p WHERE p.org_id = c.org_id
        AND p.register_id = 'projects' AND p.party_id = c.record_id AND p.state = 'open')
        AS "openProjects",
      (SELECT COUNT(*) FROM kin_records w WHERE w.org_id = c.org_id AND w.register_id = 'work'
        AND w.party_id = c.record_id AND w.side = 'ours'
        AND w.state IN ('open', 'doing', 'waiting') AND w.due_at < ${now}) AS late
    FROM kin_records c
    WHERE c.org_id = ${orgId} AND c.register_id = 'clients' AND c.state = 'open'
      AND COALESCE(c.category, 'client') = 'client'
    ORDER BY c.key`;
  const last = yield* lastContacts(
    orgId,
    clients.map((client) => client.partyId),
    now,
  );
  return clients.flatMap((client): ReadonlyArray<ClientSense> => {
    const lastAt = last.get(client.partyId) ?? null;
    const days = daysSince(lastAt ?? client.createdAt, now);
    const base = {
      partyId: client.partyId,
      key: client.key,
      name: client.title,
      lastAt,
      days,
      episode: `${client.key}:${lastAt ?? "never"}`,
    };
    const senses: Array<ClientSense> = [];
    if (client.openProjects > 0 && days >= thresholds.quietDays)
      senses.push({ ...base, sense: "client_quiet" });
    if (client.openProjects === 0 && days >= thresholds.coldDays)
      senses.push({ ...base, sense: "client_cold" });
    if (client.late > 0)
      senses.push({
        ...base,
        sense: "client_waiting_on_us",
        late: client.late,
        episode: `${client.key}:late`,
      });
    return senses;
  });
});

/**
 * Every contact that happened in `(from, until]`, with its client, for the dream. Who logged it
 * by hand says who stated it; what Kin read from its own records is Kin's.
 */
export const touchesBetween = Effect.fn("KinTouches.between")(function* (
  orgId: KinOrgId,
  from: number,
  until: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<TouchSql & { clientKey: string; clientName: string }>`
    SELECT u.*, c.key AS "clientKey", c.title AS "clientName"
    FROM (${touchUnion(sql, orgId, "all", until)}) u
    JOIN kin_records c ON c.org_id = ${orgId} AND c.record_id = u."partyId"
    WHERE u.at > ${from} ORDER BY u.at, u.id`;
  return rows.map((row) => ({
    ...toTouch(row),
    client: { key: row.clientKey, name: row.clientName },
    by: row.byKind === null ? null : { kind: row.byKind, name: row.byName ?? "someone" },
  }));
});
