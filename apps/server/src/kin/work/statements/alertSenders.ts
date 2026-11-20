import { KinChatError, type KinOrgId, type KinPersonId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A mailbox's bank alert senders as Settings shows them, and the owner level's Stop and Count
 * again. Stopping reads no more of that sender's mail and keeps what was stored, out of every
 * figure until it counts again. Only a Yes on Kin's card starts a sender; Settings never does.
 */

const NOT_COUNTED_SHOWN = 10;

export const alertSenders = Effect.fn("KinBankAlerts.senders")(function* (
  orgId: KinOrgId,
  connectionId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const senders = yield* sql<{
    address: string;
    account: string;
    state: "counted" | "stopped";
    counted: number;
  }>`SELECT s.address, s.account, s.state,
      (SELECT COUNT(*) FROM kin_bank_alerts a WHERE a.org_id = s.org_id
        AND a.connection_id = s.connection_id AND a.address = s.address
        AND a.account = s.account AND a.state = 'counted') AS counted
    FROM kin_bank_alert_senders s
    WHERE s.org_id = ${orgId} AND s.connection_id = ${connectionId}
      AND s.state IN ('counted', 'stopped')
    ORDER BY s.address, s.account`;
  if (senders.length === 0) return undefined;
  const notCounted = yield* sql<{
    address: string;
    receivedAt: number;
    subject: string;
    reason: string;
  }>`SELECT address, received_at AS "receivedAt", subject, COALESCE(reason, 'unreadable') AS reason
    FROM kin_bank_alerts
    WHERE org_id = ${orgId} AND connection_id = ${connectionId}
      AND state IN ('unread', 'unchecked')
    ORDER BY received_at DESC, alert_id LIMIT ${NOT_COUNTED_SHOWN}`;
  return { senders, notCounted };
});

/** Stop counting a sender, or count it again. Only a sender someone said Yes to. */
export const setAlertSender = Effect.fn("KinBankAlerts.setSender")(function* (input: {
  readonly orgId: KinOrgId;
  readonly connectionId: string;
  readonly address: string;
  readonly account: string;
  readonly counting: boolean;
  readonly personId: KinPersonId;
  readonly now: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const changed = yield* sql<{ address: string }>`UPDATE kin_bank_alert_senders
    SET state = ${input.counting ? "counted" : "stopped"}, decided_at = ${input.now},
      decided_by = ${input.personId}
    WHERE org_id = ${input.orgId} AND connection_id = ${input.connectionId}
      AND address = ${input.address.toLowerCase()} AND account = ${input.account}
      AND state IN ('counted', 'stopped')
    RETURNING address`;
  if (changed.length === 0)
    return yield* new KinChatError({
      reason: "not_found",
      message: "Kin isn't counting alerts from that sender on this mailbox.",
    });
});
