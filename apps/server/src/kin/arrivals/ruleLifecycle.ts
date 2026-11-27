import type { KinMailRuleHoldReason, KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export const pendingRuleMail = (
  sql: SqlClient.SqlClient,
  orgId: KinOrgId,
  ruleIds: ReadonlyArray<string>,
) => sql`org_id = ${orgId} AND rule_id IN ${sql.in(ruleIds)}
  AND rule_state = 'batched' AND event_id IS NULL`;

export const holdRuleMail = Effect.fn("KinMailRules.holdMail")(function* (
  orgId: KinOrgId,
  ruleIds: ReadonlyArray<string>,
  state: "held_cap" | "held_paused",
  reason: KinMailRuleHoldReason,
  at: number,
) {
  if (ruleIds.length === 0) return;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE kin_arrivals SET rule_state = ${state}, rule_hold_reason = ${reason},
    rule_held_at = ${at} WHERE ${pendingRuleMail(sql, orgId, ruleIds)}`;
});

export const stopQueuedRuleMail = Effect.fn("KinMailRules.stopQueuedMail")(function* (
  orgId: KinOrgId,
  ruleIds: ReadonlyArray<string>,
  reason: KinMailRuleHoldReason,
  at: number,
) {
  if (ruleIds.length === 0) return;
  const sql = yield* SqlClient.SqlClient;
  const events = yield* sql<{
    eventId: string;
  }>`UPDATE kin_events SET state = CASE WHEN state = 'expired' THEN state ELSE 'done' END
    WHERE org_id = ${orgId} AND state IN ('queued', 'expired') AND event_id IN (
      SELECT event_id FROM kin_mail_rule_runs WHERE org_id = ${orgId}
        AND rule_id IN ${sql.in(ruleIds)} AND settled_at IS NULL
    ) RETURNING event_id AS "eventId"`;
  if (events.length === 0) return;
  const ids = events.map(({ eventId }) => eventId);
  yield* sql`UPDATE kin_mail_rule_runs SET outcome = 'held', hold_reason = ${reason},
    settled_at = ${at} WHERE org_id = ${orgId} AND event_id IN ${sql.in(ids)} AND settled_at IS NULL`;
  yield* sql`UPDATE kin_arrivals SET rule_state = 'held_paused', rule_hold_reason = ${reason},
    rule_held_at = ${at} WHERE org_id = ${orgId} AND event_id IN ${sql.in(ids)}`;
});

export const pauseMailRulesFor = Effect.fn("KinMailRules.pauseFor")(function* (
  orgId: KinOrgId,
  cause: { readonly kind: "left" | "mailbox" | "agent"; readonly id: string },
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const column =
    cause.kind === "left" ? "said_by" : cause.kind === "mailbox" ? "connection_id" : "agent_id";
  const paused = yield* sql<{ connectionId: string; ruleId: string }>`UPDATE kin_mail_rules
    SET state = 'paused', paused_why = ${cause.kind}, updated_at = ${now}
    WHERE org_id = ${orgId} AND ${sql(column)} = ${cause.id} AND state = 'on'
    RETURNING connection_id AS "connectionId", rule_id AS "ruleId"`;
  const reason = (
    {
      left: "setter_left",
      mailbox: "mailbox_unavailable",
      agent: "destination_unavailable",
    } as const
  )[cause.kind];
  const ruleIds = paused.map((rule) => rule.ruleId);
  yield* holdRuleMail(orgId, ruleIds, "held_paused", reason, now);
  yield* stopQueuedRuleMail(orgId, ruleIds, reason, now);
  return paused;
});
