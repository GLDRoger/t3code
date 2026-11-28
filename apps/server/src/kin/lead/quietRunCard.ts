import {
  KinChatError,
  KinPersonId,
  KinWakeupId,
  type KinAgentId,
  type KinOrgId,
  type KinWidgetId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import type * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import { ownerLevel } from "../people/KinAccess.ts";
import { classifySegment, isToolItem } from "../reply/classify.ts";
import { isClaudeThinkingItem } from "../reply/claudeThinkingItem.ts";
import type { Lane } from "../reply/replyLane.ts";
import type { ActionTap } from "../widgets/cardActions.ts";
import { sealPlans, type QuietPlan } from "../widgets/cardPlans.ts";
import { KinStop } from "./KinStop.ts";
import { turnRecords } from "./wakeupRuns.ts";

type Wakeup = {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly wakeupId: KinWakeupId;
};

const alreadyFinished = {
  title: "Already finished",
  text: "It finished before this, so nothing was stopped.",
};
const stopped = {
  title: "Stopped",
  text: "Nothing it hadn't finished was sent. Ask again to start fresh.",
};

// The first ask is at 15 quiet minutes, the second at an hour, and there is no third.
export const quietShown = (plan: QuietPlan) =>
  plan.kind === "quiet_keep"
    ? {
        label: "Keep going",
        line:
          plan.ask === 1
            ? "It keeps working; Kin asks again if it stays quiet for an hour"
            : "It keeps working; Kin doesn't ask again",
      }
    : { label: "Stop", line: "It stops; what it had done so far stays" };

const clientId = (wakeupId: KinWakeupId, ask: 1 | 2) => `kin-quiet-run:${wakeupId}:${ask}`;
const truncate = (text: string, max: number) => {
  const chars = Array.from(text);
  return chars.length <= max
    ? text
    : `${chars
        .slice(0, max - 1)
        .join("")
        .trimEnd()}…`;
};

const openCards = Effect.fn("KinQuietRun.openCards")(function* (
  wake: Wakeup,
  asks: ReadonlyArray<1 | 2>,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ widgetId: KinWidgetId; leadName: string }>`
    SELECT w.widget_id AS "widgetId", l.name AS "leadName" FROM kin_widgets w
    JOIN kin_messages m ON m.org_id = w.org_id AND m.chat_id = w.chat_id AND m.message_id = w.message_id
    JOIN kin_leads l ON l.org_id = m.org_id AND l.agent_id = m.author_agent_id
    JOIN kin_card_plans p ON p.org_id = w.org_id AND p.widget_id = w.widget_id AND p.option_id = 'option-1'
    WHERE w.org_id = ${wake.orgId} AND l.agent_id = ${wake.agentId} AND w.closed_at IS NULL
      AND w.type = 'choice' AND json_extract(p.plan_json, '$.kind') = 'quiet_keep'
      AND m.client_message_id IN ${sql.in(asks.map((ask) => `send:${clientId(wake.wakeupId, ask)}`))}
    ORDER BY m.client_message_id`;
});

export const closeQuietRunCards = Effect.fn("KinQuietRun.closeCards")(function* (
  wake: Wakeup,
  status: string | undefined,
) {
  const chat = yield* KinChatService;
  for (const { widgetId, leadName } of yield* openCards(wake, [1, 2]))
    yield* chat.closeReplaced({
      orgId: wake.orgId,
      widgetId,
      outcome:
        status === "interrupted"
          ? stopped
          : status === "done" || status === "completed"
            ? { title: "Finished", text: `${leadName} finished.` }
            : { title: "Ended", text: `${leadName} stopped working on it.` },
    });
});

export const postQuietRunCard = Effect.fn("KinQuietRun.postCard")(function* (
  wake: Wakeup & { readonly lane: Lane; readonly ask: 1 | 2 },
  threads: ThreadManagement.ThreadManagementService["Service"],
  run: { readonly threadId: ThreadId; readonly runId: RunId },
) {
  const sql = yield* SqlClient.SqlClient;
  const chat = yield* KinChatService;
  const { orgId, agentId, wakeupId, lane, ask } = wake;
  const records = yield* turnRecords(threads, run.threadId, run.runId);
  const items = records.turnItems.filter((item) => item.runId === run.runId);
  const lastTool = items.reduce(
    (latest, item) => (isToolItem(item) ? Math.max(latest, item.ordinal) : latest),
    -1,
  );
  const note = items
    .filter((item) => item.type === "assistant_message")
    .filter((item) => item.ordinal < lastTool && !isClaudeThinkingItem(item))
    .map((item) =>
      item.textOmitted
        ? (records.messages.find((one) => one.id === item.messageId)?.text ?? "")
        : item.text,
    )
    .findLast((text) => classifySegment(text, "tool") === "note");
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const [lead] = yield* sql<{ ownerPersonId: KinPersonId; audience: string | null }>`
      SELECT a.owner_person_id AS "ownerPersonId", w.audience FROM kin_wakeups w
      JOIN kin_agents a ON a.org_id = w.org_id AND a.agent_id = w.agent_id
      WHERE w.org_id = ${orgId} AND w.wakeup_id = ${wakeupId} AND w.agent_id = ${agentId}
        AND w.status = 'running' AND w.aborted_at IS NULL AND w.thread_id = ${run.threadId}
        AND a.retired_at IS NULL ORDER BY w.wakeup_id`;
      if (lead === undefined) return;
      const events = yield* sql<{
        personId: string;
        tag: string;
        chatId: string;
        body: string;
        question: string | null;
      }>`
      SELECT m.author_person_id AS "personId", e.tag, m.chat_id AS "chatId",
        m.body, json_extract(c.state_json, '$.question') AS question
      FROM kin_events e JOIN kin_messages m ON m.org_id = e.org_id
        AND m.chat_id = json_extract(e.json, '$.chatId') AND m.message_id = json_extract(e.json, '$.messageId')
        AND m.author_person_id = json_extract(e.json, '$.provenance.personId')
      LEFT JOIN kin_widgets c ON c.org_id = m.org_id AND c.chat_id = m.chat_id
        AND c.widget_id = m.widget_id AND c.type = 'choice'
      WHERE e.org_id = ${orgId} AND e.agent_id = ${agentId} AND e.wakeup_id = ${wakeupId}
        AND e.state = 'claimed' AND e.tag IN ('chat.message', 'widget.action')
      ORDER BY e.priority, e.received_at, e.event_id`;
      const here = events.filter((event) => event.chatId === lane.chatId);
      const text =
        here.find((event) => event.tag === "chat.message")?.body ??
        here.find((event) => event.tag === "widget.action" && event.question !== null)?.question ??
        "";
      const what = truncate((text.split(/[\r\n]/u, 1)[0] ?? "").replace(/\s+/gu, " ").trim(), 60);
      if (ask === 2)
        for (const { widgetId } of yield* openCards(wake, [1]))
          yield* chat.closeReplaced({
            orgId,
            widgetId,
            outcome: { title: "No answer", text: "It kept going." },
          });
      const askers = [...new Set(events.map((event) => event.personId))];
      const plans = (["quiet_keep", "quiet_stop"] as const).map((kind) => ({
        kind,
        wakeupId,
        agentId,
        askers,
        ask,
      }));
      const actions = plans.map(quietShown);
      const card = yield* chat.ask(
        {
          _tag: "agent",
          hostPosted: true,
          orgId,
          agentId,
          ownerPersonId: lead.ownerPersonId,
          threadId: run.threadId,
        },
        {
          chatId: lane.chatId,
          clientMessageId: clientId(wakeupId, ask),
          question: `Still working on ${what === "" ? "this" : `“${what}”`}: no sign of progress for ${ask === 1 ? "15 minutes" : "an hour"}. Keep going or stop?`,
          // Only the audience used to build the run's prompt is safe for its progress notes.
          ...(lead.audience === "shared" && note !== undefined
            ? { detail: `Last note: “${note.trim()}”` }
            : {}),
          options: actions.map(({ label }) => ({ label })),
          actions,
          untilAnswered: true,
          forChat: true,
        },
      );
      yield* sealPlans({
        orgId,
        chatId: lane.chatId,
        widgetId: card.widgetId,
        plans: plans.map((plan, i) => ({ optionId: `option-${i + 1}`, plan })),
        now: yield* Clock.currentTimeMillis,
      });
    }),
  );
});

export const runQuiet = Effect.fn("KinQuietRun.run")(function* (tap: ActionTap, plan: QuietPlan) {
  const { orgId, personId } = tap;
  if (!plan.askers.includes(personId) && !(yield* ownerLevel(orgId, personId)))
    return yield* new KinChatError({
      reason: "not_allowed",
      message: "Only the person it was asked of can answer this question.",
    });
  const sql = yield* SqlClient.SqlClient;
  const [lead] = yield* sql<{ name: string }>`
    SELECT l.name FROM kin_wakeups w JOIN kin_leads l ON l.org_id = w.org_id AND l.agent_id = w.agent_id
    WHERE w.org_id = ${orgId} AND w.wakeup_id = ${plan.wakeupId} AND w.agent_id = ${plan.agentId}
      AND w.status = 'running' AND w.aborted_at IS NULL ORDER BY w.wakeup_id`;
  if (lead === undefined) return alreadyFinished;
  if (plan.kind === "quiet_keep")
    return { title: "Kept going", text: `${lead.name} keeps working on it.` };
  const stop = yield* Effect.serviceOption(KinStop);
  if (Option.isNone(stop))
    return yield* new KinChatError({ reason: "unavailable", message: "Kin is unavailable." });
  yield* sql.afterCommit(stop.value.stopAsked(orgId, KinWakeupId.make(plan.wakeupId), personId));
  return stopped;
});
