import type { KinAgentId, KinChatId, KinEvent, KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { WORKING_PHASES, type KinChatHub } from "../chat/KinChatHub.ts";
import { isOrgPaused } from "./orgState.ts";

/** The chats a batch of events answers: owner messages and widget taps. */
export const chatIdsOf = (events: ReadonlyArray<KinEvent>): ReadonlyArray<KinChatId> => [
  ...new Set(
    events.flatMap((event) =>
      event._tag === "chat.message" || event._tag === "widget.action" ? [event.chatId] : [],
    ),
  ),
];

/** Why a chat's queued event has not started, or undefined when none is queued. */
const waitingPhase = Effect.fn("KinChatActivity.waitingPhase")(function* (
  orgId: KinOrgId,
  agentId: KinAgentId,
  chatId: KinChatId,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ deferred: number; notBefore: number | null }>`
    SELECT budget_deferred AS deferred, not_before AS "notBefore" FROM kin_events
    WHERE org_id = ${orgId} AND agent_id = ${agentId} AND state = 'queued'
      AND json_extract(json, '$.chatId') = ${chatId}
    ORDER BY budget_deferred DESC, not_before DESC LIMIT 1`;
  if (row === undefined) return undefined;
  if (yield* isOrgPaused(orgId)) return { phase: "paused" as const };
  return row.deferred === 1
    ? { phase: "budget" as const, resumesAt: row.notBefore ?? undefined }
    : { phase: "queued" as const };
});

/**
 * A wake-up ended: show its failure until the next wake-up or owner message, else what still
 * waits, else nothing. A late-reply notice stays.
 */
export const settle = Effect.fn("KinChatActivity.settle")(function* (
  hub: KinChatHub["Service"],
  input: {
    readonly orgId: KinOrgId;
    readonly agentId: KinAgentId;
    readonly chatIds: ReadonlyArray<KinChatId>;
    readonly failed: boolean;
  },
) {
  for (const chatId of input.chatIds) {
    const held = yield* hub.activity(input.orgId, chatId);
    if (held?.phase === "reply_late" && held.agentId === input.agentId) continue;
    const next = input.failed
      ? { phase: "failed" as const }
      : ((yield* waitingPhase(input.orgId, input.agentId, chatId)) ?? { phase: "idle" as const });
    yield* hub.setActivity({
      orgId: input.orgId,
      agentId: input.agentId,
      chatIds: [chatId],
      ...next,
    });
  }
});

/** A new owner message: say why it waits, unless a wake-up is already working on the chat. */
export const enqueued = Effect.fn("KinChatActivity.enqueued")(function* (
  hub: KinChatHub["Service"],
  input: { readonly orgId: KinOrgId; readonly agentId: KinAgentId; readonly chatId: KinChatId },
) {
  const held = yield* hub.activity(input.orgId, input.chatId);
  if (held !== null && held.agentId === input.agentId && WORKING_PHASES.has(held.phase)) return;
  const waiting = yield* waitingPhase(input.orgId, input.agentId, input.chatId);
  if (waiting !== undefined)
    yield* hub.setActivity({ ...input, chatIds: [input.chatId], ...waiting });
});
