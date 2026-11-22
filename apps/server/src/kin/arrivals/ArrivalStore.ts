import type { KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous id hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";

import { liveConnections, sendAsOf } from "../connections/ConnectionRows.ts";
import { mailProviderOf } from "../connections/mailProviders.ts";
import { DAY_MS, HOUR_MS, MINUTE_MS } from "../durations.ts";
import type { ArrivalClass, ArrivalContact, ArrivalRows } from "./classify.ts";

/**
 * A watched mailbox gets one row per message. The ledger keeps sender address, class, reason
 * and provider ids, never a subject or body, for 30 days.
 */
const KEEP_MS = 30 * DAY_MS;
/** A message that keeps failing to read is retried later each time, then daily; never dropped. */
const PARKED_RETRY_MS = [MINUTE_MS, 5 * MINUTE_MS, 30 * MINUTE_MS, 2 * HOUR_MS, DAY_MS];
const PARKED_PER_READ = 20;

const hash = (...parts: ReadonlyArray<string>) =>
  NodeCrypto.createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);
export const arrivalIdOf = (orgId: KinOrgId, connectionId: string, messageId: string) =>
  `arr_${hash(orgId, connectionId, messageId)}`;
/** The same message in any mailbox of the org: its Message-ID with the sender it claims. */
export const mailKeyOf = (orgId: KinOrgId, from: string, internetId: string | null) =>
  internetId === null || internetId.trim() === ""
    ? null
    : hash(orgId, from.toLowerCase(), internetId.trim());

/** Kin's rows that classify decides on, read in the feed's transaction. */
export const rowsFor = Effect.fn("KinArrivalStore.rows")(function* (
  orgId: KinOrgId,
  connectionId: string,
  own: ReadonlyArray<string>,
) {
  const sql = yield* SqlClient.SqlClient;
  const addresses = new Set(own.map((address) => address.toLowerCase()));
  for (const other of yield* liveConnections(orgId)) {
    if (mailProviderOf(other) === undefined) continue;
    if (other.accountLabel !== null) addresses.add(other.accountLabel.toLowerCase());
    for (const entry of sendAsOf(other)) addresses.add(entry.address.toLowerCase());
  }
  const sent = yield* sql<{ threadId: string | null; agentId: string }>`SELECT
      COALESCE(json_extract(result_json, '$.threadId'), json_extract(payload_json, '$.threadId'))
        AS "threadId", agent_id AS "agentId"
    FROM kin_connection_asks
    WHERE org_id = ${orgId} AND connection_id = ${connectionId} AND state = 'sent'
    ORDER BY done_at, ask_id`;
  const contacts = yield* sql<ArrivalContact & { email: string; main: number }>`SELECT
      lower(e.value) AS email, e.key = 'email' AS main, r.key, r.title,
      c.record_id AS "clientId", c.key AS "clientKey", c.title AS "clientTitle"
    FROM kin_records r
      JOIN (SELECT r2.record_id, 'email' AS key, json_extract(r2.fields_json, '$.email') AS value
          FROM kin_records r2 WHERE r2.org_id = ${orgId} AND r2.register_id = 'contacts'
        UNION ALL SELECT r2.record_id, 'emails', j.value
          FROM kin_records r2, json_each(r2.fields_json, '$.emails') j
          WHERE r2.org_id = ${orgId} AND r2.register_id = 'contacts') e
        ON e.record_id = r.record_id
      LEFT JOIN kin_records c ON c.org_id = r.org_id AND c.record_id = r.party_id
        AND c.register_id = 'clients'
    WHERE r.org_id = ${orgId} AND r.register_id = 'contacts' AND r.state = 'open'
      AND e.value IS NOT NULL
    ORDER BY main, r.key`;
  const money = yield* sql<{ key: string; list: string; number: unknown; shown: number }>`SELECT
      r.key, r.register_id AS list, json_extract(r.fields_json, '$.number') AS number,
      (SELECT COUNT(*) FROM kin_records o WHERE o.org_id = r.org_id
        AND json_extract(o.fields_json, '$.number') = trim(json_extract(r.fields_json, '$.number')))
        AS shown
    FROM kin_records r WHERE r.org_id = ${orgId} AND r.register_id IN ('invoices', 'quotes')
      AND r.state IN ('open', 'waiting')
    ORDER BY r.key`;
  const billers = yield* sql<{ from: string }>`SELECT DISTINCT a.from_address AS "from"
    FROM kin_arrivals a, json_each(a.refs_json, '$.records') r
    WHERE a.org_id = ${orgId} AND a.outcome = 'filed' AND a.from_address IS NOT NULL
      AND json_extract(r.value, '$.list') = 'expenses'
    ORDER BY a.from_address`;
  return {
    own: addresses,
    sentThreads: new Map(
      sent.flatMap((row) => (row.threadId === null ? [] : [[row.threadId, row.agentId] as const])),
    ),
    // A contact's main address wins; another one only where no main one has it (as the watch).
    contacts: new Map(contacts.map((row) => [row.email, row])),
    money: money.map((row) => ({
      key: row.key,
      list: row.list,
      number: typeof row.number === "string" ? row.number : null,
      unique: row.shown === 1,
    })),
    billers: new Set(billers.map((row) => row.from.toLowerCase())),
  } satisfies ArrivalRows;
});

/** Which of these provider ids this mailbox already has a row for, in any state. */
export const known = Effect.fn("KinArrivalStore.known")(function* (
  orgId: KinOrgId,
  connectionId: string,
  messageIds: ReadonlyArray<string>,
) {
  const sql = yield* SqlClient.SqlClient;
  if (messageIds.length === 0) return new Set<string>();
  const rows = yield* sql<{ messageId: string }>`SELECT message_id AS "messageId" FROM kin_arrivals
    WHERE org_id = ${orgId} AND connection_id = ${connectionId}
      AND message_id IN ${sql.in(messageIds)}
    ORDER BY message_id`;
  return new Set(rows.map((row) => row.messageId));
});

export type Parked = {
  readonly arrivalId: string;
  readonly messageId: string;
  readonly noticedAt: number;
  readonly tries: number;
};
export const parkedDue = Effect.fn("KinArrivalStore.parkedDue")(function* (
  orgId: KinOrgId,
  connectionId: string,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<Parked>`SELECT arrival_id AS "arrivalId", message_id AS "messageId",
      noticed_at AS "noticedAt", tries FROM kin_arrivals
    WHERE org_id = ${orgId} AND connection_id = ${connectionId} AND state = 'parked'
      AND retry_at <= ${now}
    ORDER BY retry_at, arrival_id LIMIT ${PARKED_PER_READ}`;
});

/** A message named that wouldn't read: kept, and read again later. */
export const park = Effect.fn("KinArrivalStore.park")(function* (
  orgId: KinOrgId,
  connectionId: string,
  change: { readonly messageId: string; readonly threadId: string | null },
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_arrivals (org_id, arrival_id, connection_id, message_id, thread_id,
      noticed_at, state, tries, retry_at)
    VALUES (${orgId}, ${arrivalIdOf(orgId, connectionId, change.messageId)}, ${connectionId},
      ${change.messageId}, ${change.threadId}, ${now}, 'parked', 1, ${now + PARKED_RETRY_MS[0]!})
    ON CONFLICT DO NOTHING`;
});
export const parkedAgain = Effect.fn("KinArrivalStore.parkedAgain")(function* (
  orgId: KinOrgId,
  parked: Parked,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const wait = PARKED_RETRY_MS[Math.min(parked.tries, PARKED_RETRY_MS.length - 1)]!;
  yield* sql`UPDATE kin_arrivals SET tries = tries + 1, retry_at = ${now + wait}
    WHERE org_id = ${orgId} AND arrival_id = ${parked.arrivalId} AND state = 'parked'`;
});

export type Arrived = {
  readonly arrivalId: string;
  readonly connectionId: string;
  readonly messageId: string;
  readonly threadId: string;
  readonly mailKey: string | null;
  readonly fromAddress: string | null;
  readonly receivedAt: number;
  readonly class: ArrivalClass;
  readonly reason: string;
  readonly needsLook: boolean;
};

/** Only the first insert or transition out of parked claims a message. */
export const claim = Effect.fn("KinArrivalStore.claim")(function* (
  orgId: KinOrgId,
  arrived: Arrived,
  now: number,
  parked: boolean,
) {
  const sql = yield* SqlClient.SqlClient;
  const state = arrived.needsLook ? "new" : "settled";
  const outcome = arrived.needsLook ? null : "nothing";
  const settledAt = arrived.needsLook ? null : now;
  const reason = arrived.reason.slice(0, 200);
  const made = parked
    ? yield* sql`UPDATE kin_arrivals SET thread_id = ${arrived.threadId},
          mail_key = ${arrived.mailKey}, from_address = ${arrived.fromAddress},
          received_at = ${arrived.receivedAt}, class = ${arrived.class},
          state = ${state},
          outcome = ${outcome}, reason = ${reason}, settled_at = ${settledAt}, retry_at = NULL
        WHERE org_id = ${orgId} AND arrival_id = ${arrived.arrivalId} AND state = 'parked'
        RETURNING arrival_id`
    : yield* sql`INSERT INTO kin_arrivals (org_id, arrival_id, connection_id, message_id,
          thread_id, mail_key, from_address, received_at, noticed_at, class, state, outcome,
          reason, settled_at)
        VALUES (${orgId}, ${arrived.arrivalId}, ${arrived.connectionId}, ${arrived.messageId},
          ${arrived.threadId}, ${arrived.mailKey}, ${arrived.fromAddress}, ${arrived.receivedAt},
          ${now}, ${arrived.class}, ${state}, ${outcome}, ${reason}, ${settledAt})
        ON CONFLICT DO NOTHING RETURNING arrival_id`;
  return made.length > 0;
});

/** Close a parked arrival that no longer needs a read. */
export const settleNothing = Effect.fn("KinArrivalStore.settleNothing")(function* (
  orgId: KinOrgId,
  arrivalId: string,
  reason: string,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE kin_arrivals SET state = 'settled', outcome = 'nothing',
      reason = ${reason.slice(0, 200)}, agent_id = NULL, event_id = NULL, settled_at = ${now},
      retry_at = NULL
    WHERE org_id = ${orgId} AND arrival_id = ${arrivalId} AND state = 'parked'`;
});

export const recordedElsewhere = Effect.fn("KinArrivalStore.recordedElsewhere")(function* (
  orgId: KinOrgId,
  mailKey: string | null,
  arrivalId: string,
) {
  if (mailKey === null) return false;
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ found: number }>`SELECT EXISTS (
    SELECT 1 FROM kin_arrivals
    WHERE org_id = ${orgId} AND mail_key = ${mailKey} AND arrival_id != ${arrivalId}
  ) AS found`;
  return row?.found === 1;
});

/** A stretch the feed couldn't see, as one row, so it isn't passed off as quiet. */
export const gap = Effect.fn("KinArrivalStore.gap")(function* (
  orgId: KinOrgId,
  connectionId: string,
  window: { readonly from: number; readonly to: number },
  reason: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_arrivals (org_id, arrival_id, connection_id, message_id, noticed_at,
      received_at, class, state, outcome, reason, settled_at)
    VALUES (${orgId}, ${`gap_${hash(orgId, connectionId, String(window.from))}`}, ${connectionId},
      ${`gap:${window.from}`}, ${window.to}, ${window.from}, 'gap', 'settled', 'nothing',
      ${reason.slice(0, 200)}, ${window.to})
    ON CONFLICT DO NOTHING`;
});

/** What is past its 30 days goes; a parked message waits for its read however long. */
export const prune = Effect.fn("KinArrivalStore.prune")(function* (now: number) {
  const sql = yield* SqlClient.SqlClient;
  // Retention scans every org, bounded by the batch.
  yield* sql`DELETE FROM kin_arrivals WHERE rowid IN (SELECT rowid FROM kin_arrivals
      WHERE noticed_at < ${now - KEEP_MS} AND state != 'parked' ORDER BY noticed_at LIMIT 5000)`;
});
