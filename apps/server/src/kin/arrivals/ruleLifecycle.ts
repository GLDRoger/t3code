import type { KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export const heldRuleReason = {
  left: "the rule's setter left the team",
  mailbox: "the rule's company mailbox is disconnected",
  agent: "the rule's lead or direct chat is unavailable",
  person: "the rule is paused",
  removed: "the rule was removed",
  demoted: "the rule's setter is no longer an owner or co-owner",
  changed: "the rule's wording changed",
  cap: "monthly limit reached",
};

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
  reason: string,
  at: number,
) {
  if (ruleIds.length === 0) return;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE kin_arrivals SET rule_state = ${state}, reason = ${reason},
    state = 'settled', settled_at = ${at} WHERE ${pendingRuleMail(sql, orgId, ruleIds)}`;
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
  yield* holdRuleMail(
    orgId,
    paused.map((rule) => rule.ruleId),
    "held_paused",
    heldRuleReason[cause.kind],
    now,
  );
  return paused;
});
