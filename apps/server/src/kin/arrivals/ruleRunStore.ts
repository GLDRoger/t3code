import type { KinMailRuleHoldReason, KinOrgId, KinWakeupId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { readOwnerZone } from "../work/recordRows.ts";
import { monthlyMailRuleLimit } from "./ruleLimit.ts";

export const linkRuleWake = Effect.fn("KinMailRules.linkWake")(function* (
  orgId: KinOrgId,
  eventIds: ReadonlyArray<string>,
  wakeupId: KinWakeupId,
) {
  if (eventIds.length === 0) return;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE kin_mail_rule_runs SET wakeup_id = ${wakeupId}
    WHERE org_id = ${orgId} AND event_id IN ${sql.in(eventIds)} AND settled_at IS NULL`;
});

// An automatic wake counts against its month when queued; one held before it started gives it back.
export const refundRuleWakes = Effect.fn("KinMailRules.refundWakes")(function* (
  orgId: KinOrgId,
  eventIds: ReadonlyArray<string>,
) {
  if (eventIds.length === 0) return;
  const sql = yield* SqlClient.SqlClient;
  const wakes = yield* sql<{ ruleId: string; queuedAt: number }>`SELECT r.rule_id AS "ruleId",
      e.received_at AS "queuedAt" FROM kin_mail_rule_runs r
    JOIN kin_events e ON e.org_id = r.org_id AND e.event_id = r.event_id
    WHERE r.org_id = ${orgId} AND r.event_id IN ${sql.in(eventIds)} AND r.state = 'woke'
      AND r.manual = 0 AND r.settled_at IS NULL`;
  if (wakes.length === 0) return;
  const zone = yield* readOwnerZone(orgId);
  for (const wake of wakes) {
    const { month } = monthlyMailRuleLimit(
      { month: null, fired: 0, monthlyCap: 1 },
      wake.queuedAt,
      zone,
    );
    yield* sql`UPDATE kin_mail_rules SET fired = fired - 1
      WHERE org_id = ${orgId} AND rule_id = ${wake.ruleId} AND month = ${month} AND fired > 0`;
  }
});

export const holdRuleWake = Effect.fn("KinMailRules.holdWake")(function* (
  orgId: KinOrgId,
  eventId: string,
  wakeupId: KinWakeupId,
  reason: KinMailRuleHoldReason,
) {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  yield* refundRuleWakes(orgId, [eventId]);
  yield* sql`UPDATE kin_mail_rule_runs SET outcome = 'held', hold_reason = ${reason},
    wakeup_id = ${wakeupId}, settled_at = ${now}
    WHERE org_id = ${orgId} AND event_id = ${eventId} AND settled_at IS NULL`;
  yield* sql`UPDATE kin_arrivals SET rule_hold_reason = ${reason}, rule_state = 'held_paused',
    rule_held_at = ${now} WHERE org_id = ${orgId} AND event_id = ${eventId}
      AND rule_state IN ('woke', 'batched')`;
});

export const settleRuleWakes = Effect.fn("KinMailRules.settleWakes")(function* (
  orgId: KinOrgId,
  eventIds: ReadonlyArray<string>,
) {
  if (eventIds.length === 0) return;
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  const settled = yield* sql<{ id: string }>`WITH ended AS (
      SELECT e.event_id, e.wakeup_id, e.replied_at, e.org_id, e.agent_id,
        json_extract(e.json, '$.chatId') AS chat_id
      FROM kin_events e WHERE e.org_id = ${orgId} AND e.event_id IN ${sql.in(eventIds)}
        AND EXISTS (SELECT 1 FROM kin_mail_rule_runs r WHERE r.org_id = e.org_id
          AND r.event_id = e.event_id AND r.settled_at IS NULL)
    ), evidence AS (
      SELECT e.*, COALESCE((
        SELECT MAX(CASE WHEN m.widget_id IS NULL THEN 1 ELSE 2 END)
        FROM kin_messages m WHERE m.org_id = e.org_id AND m.author_kind = 'agent'
          AND m.author_agent_id = e.agent_id AND m.chat_id = e.chat_id AND m.status = 'posted'
          AND (m.source_wakeup_id = e.wakeup_id OR
            (m.source_wakeup_id IS NULL AND m.author_thread_id = w.thread_id
              AND m.created_at > strftime('%Y-%m-%dT%H:%M:%fZ', w.started_at / 1000.0, 'unixepoch')))
      ), 0) AS message, EXISTS (
        SELECT 1 FROM kin_connection_asks a WHERE a.org_id = e.org_id
          AND a.wakeup_id = e.wakeup_id AND a.widget_id IS NOT NULL
      ) AS confirm
      FROM ended e LEFT JOIN kin_wakeups w ON w.org_id = e.org_id AND w.wakeup_id = e.wakeup_id
    ), outcomes AS (
      SELECT event_id, wakeup_id, CASE
        WHEN confirm OR message = 2 THEN 'raised_card'
        WHEN replied_at IS NOT NULL OR message = 1 THEN 'posted_message'
        ELSE 'nothing'
      END AS outcome FROM evidence
    ) UPDATE kin_mail_rule_runs AS r SET wakeup_id = COALESCE(outcomes.wakeup_id, r.wakeup_id),
      settled_at = ${now}, outcome = outcomes.outcome FROM outcomes
    WHERE r.org_id = ${orgId} AND r.event_id = outcomes.event_id AND r.settled_at IS NULL
    RETURNING event_id AS id`;
  if (settled.length === 0) return;
  yield* sql`UPDATE kin_arrivals SET rule_playbook_route = NULL, state = 'settled',
      settled_at = ${now}
    WHERE org_id = ${orgId} AND event_id IN ${sql.in([...new Set(settled.map(({ id }) => id))])}
      AND rule_state IN ('woke', 'batched')`;
});
