import { KinChatError, type KinOrgId, type KinPersonId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { LOOKBACK_MS } from "./bankAlerts.ts";

/**
 * A mailbox's bank alert senders as Settings shows them, and the owner level's Stop, Count again
 * and Ask me again. Stopping reads no more of that sender's mail and keeps what was stored, out of
 * every figure until it counts again. Only a Yes on Kin's card starts a sender; Settings never
 * does: Ask me again only takes back a No, so the next alert from it asks afresh.
 */

const NOT_COUNTED_SHOWN = 10;

export const alertSenders = Effect.fn("KinBankAlerts.senders")(function* (
  orgId: KinOrgId,
  connectionId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const senders = yield* sql<{
    senderId: string;
    address: string;
    account: string;
    currency: string;
    state: "counted" | "stopped" | "declined";
    counted: number;
  }>`SELECT s.sender_id AS "senderId", s.address, s.account, s.currency, s.state,
      (SELECT COUNT(*) FROM kin_bank_alerts a WHERE a.org_id = s.org_id
        AND a.sender_id = s.sender_id AND a.state = 'counted') AS counted
    FROM kin_bank_alert_senders s
    WHERE s.org_id = ${orgId} AND s.connection_id = ${connectionId}
      AND s.state IN ('counted', 'stopped', 'declined')
    ORDER BY s.address, s.account, s.currency`;
  if (senders.length === 0) return undefined;
  const notCounted = yield* sql<{
    address: string;
    receivedAt: number;
    subject: string;
    reason: string;
  }>`SELECT address, received_at AS "receivedAt", subject, reason
    FROM kin_bank_alerts
    WHERE org_id = ${orgId} AND connection_id = ${connectionId} AND state = 'not_counted'
    ORDER BY received_at DESC, alert_id LIMIT ${NOT_COUNTED_SHOWN}`;
  return { senders, notCounted };
});

/**
 * Stop counting a sender, count it again, or take back a No (`askAgain`). Returns the approvals
 * stopped, whose waiting cards the caller closes.
 */
export const setAlertSender = Effect.fn("KinBankAlerts.setSender")(function* (input: {
  readonly orgId: KinOrgId;
  readonly connectionId: string;
  readonly address: string;
  readonly account: string;
  readonly currency: string | undefined;
  readonly to: "counted" | "stopped" | "ask_again";
  readonly personId: KinPersonId;
  readonly now: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const which = sql`org_id = ${input.orgId} AND connection_id = ${input.connectionId}
    AND address = ${input.address.toLowerCase()} AND account = ${input.account}
    AND (${input.currency ?? null} IS NULL OR currency = ${input.currency ?? null})`;
  const changed =
    input.to === "ask_again"
      ? yield* sql<{ senderId: string }>`DELETE FROM kin_bank_alert_senders
          WHERE ${which} AND state = 'declined' RETURNING sender_id AS "senderId"`
      : yield* sql<{ senderId: string }>`UPDATE kin_bank_alert_senders
          SET state = ${input.to}, decided_at = ${input.now}, decided_by = ${input.personId},
            cursor_at = ${input.to === "counted" ? sql`MAX(cursor_at, ${input.now - LOOKBACK_MS})` : sql`cursor_at`}
          WHERE ${which} AND state IN ('counted', 'stopped')
          RETURNING sender_id AS "senderId"`;
  if (changed.length === 0)
    return yield* new KinChatError({
      reason: "not_found",
      message:
        input.to === "ask_again"
          ? "Kin has no No to take back for that sender on this mailbox."
          : "Kin isn't counting alerts from that sender on this mailbox.",
    });
  return input.to === "stopped" ? changed.map((one) => one.senderId) : [];
});
