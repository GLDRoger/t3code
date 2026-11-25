import {
  type KinAgentId,
  KinChatId,
  type KinOrgId,
  type KinWakeupId,
  type MessageId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../../serverActivation.ts";
import { SHARED_THREAD_PREFIX } from "./Audience.ts";
import { hashedEventId } from "./eventIds.ts";
import { KinEventQueue } from "./KinEventQueue.ts";
import { ownerLevelSql } from "../people/KinAccess.ts";

/**
 * The run T3 started for a finished-task notice, or its restart or usage-limit continuation,
 * while it is still queued or running: the run a `task.finished` wake-up takes over.
 */
const liveWakeRun = (
  runs: ReadonlyArray<OrchestrationV2Run>,
  messageId: MessageId,
): OrchestrationV2Run | undefined => {
  const chain = new Set<string>();
  for (const run of runs.toSorted((a, b) => a.ordinal - b.ordinal))
    if (
      run.userMessageId === messageId ||
      (run.restartContinuationOfRunId !== undefined && chain.has(run.restartContinuationOfRunId)) ||
      (run.usageLimitContinuationOfRunId !== undefined &&
        chain.has(run.usageLimitContinuationOfRunId))
    )
      chain.add(run.id);
  return runs
    .filter(
      (run) =>
        chain.has(run.id) &&
        ((run.status === "queued" && run.queueHeld !== true) || ThreadManagement.isActiveRun(run)),
    )
    .toSorted((a, b) => b.ordinal - a.ordinal)[0];
};

/**
 * Where a finished-task notice stands for the wake-up that claims it: T3's run for it is `live`
 * (take it over); T3 steered it into a run already going, which `saw` it; or no run answered it
 * and it is `missed` (a fresh turn tells the agent).
 */
export const noticeState = (
  records: {
    readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
    readonly runs: ReadonlyArray<OrchestrationV2Run>;
  },
  messageId: MessageId,
):
  | { readonly _tag: "live"; readonly run: OrchestrationV2Run }
  | { readonly _tag: "seen" | "missed" } => {
  const run = liveWakeRun(records.runs, messageId);
  if (run !== undefined) return { _tag: "live", run };
  const into = records.messages.find((message) => message.id === messageId)?.runId;
  const steered =
    into !== null &&
    into !== undefined &&
    records.runs.find((candidate) => candidate.id === into)?.userMessageId !== messageId;
  return { _tag: steered ? "seen" : "missed" };
};

/**
 * The agent and chat a task delegated from `threadId` answers in: the chat it was asked from
 * while only owner-level people ever were in it, else the agent's direct chat with its owner.
 */
export const taskChat = Effect.fn("KinTaskWake.taskChat")(function* (threadId: ThreadId) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ orgId: KinOrgId; agentId: KinAgentId; chatId: string }>`
    SELECT t.org_id AS "orgId", t.agent_id AS "agentId",
      CASE WHEN t.chat_id IS NULL OR EXISTS (SELECT 1 FROM kin_chat_members m
          WHERE m.org_id = t.org_id AND m.chat_id = t.chat_id AND m.principal_kind = 'person'
            AND NOT ${sql.literal(ownerLevelSql("m.org_id", "m.person_id"))})
        THEN l.owner_chat_id ELSE t.chat_id END AS "chatId"
    FROM kin_agent_threads t
    JOIN kin_leads l ON l.org_id = t.org_id AND l.agent_id = t.agent_id
    WHERE t.thread_id = ${threadId}
    ORDER BY t.org_id, t.agent_id LIMIT 1`;
  return row === undefined ? undefined : { ...row, chatId: KinChatId.make(row.chatId) };
});

/**
 * T3 tells a thread when tasks it delegated end (`ProviderContinuationService`). On a lead's own
 * thread that notice becomes a `task.finished` event, so a Kin wake-up owns the run that answers
 * it and its one reply lands in the chat the work was asked from. Keyed on T3's message, so a
 * replay or a rescan enqueues the same event.
 */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const queue = yield* KinEventQueue;

  const enqueue = Effect.fn("KinTaskWake.enqueue")(function* (
    message: OrchestrationV2ConversationMessage,
  ) {
    const completion = message.delegatedCompletion;
    if (completion === undefined || message.threadId.startsWith(SHARED_THREAD_PREFIX)) return;
    const lead = yield* taskChat(message.threadId);
    if (lead === undefined) return;
    const eventId = hashedEventId("task", message.id);
    // The turn whose run handed the work out: its result answers whoever asked there.
    const asked = yield* sql<{ wakeupId: KinWakeupId }>`SELECT wakeup_id AS "wakeupId"
      FROM kin_wakeups WHERE org_id = ${lead.orgId} AND agent_id = ${lead.agentId}
        AND run_id = ${completion.parentRunId}
      ORDER BY started_at, wakeup_id`;
    yield* queue
      .enqueue({
        _tag: "task.finished",
        orgId: lead.orgId,
        eventId,
        agentId: lead.agentId,
        receivedAt: message.createdAt,
        dedupeKey: message.id,
        provenance: { _tag: "system" },
        threadId: message.threadId,
        messageId: message.id,
        taskIds: completion.taskIds,
        chatId: lead.chatId,
        ...(asked.length === 0 ? {} : { askedIn: asked.map((row) => row.wakeupId) }),
      })
      .pipe(
        Effect.catchTags({
          KinEventQueueConflict: (error) =>
            error.eventId === eventId ? Effect.void : Effect.fail(error),
          KinEventQueueRetiredAgent: () => Effect.void,
          KinEventQueueUnknownAgent: () => Effect.void,
        }),
      );
  });

  // A notice T3 sent while this server was down, or re-sent when it started, still waits.
  const scan = Effect.gen(function* () {
    const live = yield* sql<{ threadId: string }>`
      SELECT DISTINCT thread_id AS "threadId" FROM kin_agent_threads
      WHERE ended_at IS NULL AND substr(thread_id, 1, 4) = 'kin:' ORDER BY thread_id`;
    for (const { threadId } of live) {
      const records = yield* threads.getThreadRecords(ThreadId.make(threadId), [
        "messages",
        "runs",
      ]);
      for (const message of records.messages)
        if (
          message.delegatedCompletion !== undefined &&
          noticeState(records, message.id)._tag === "live"
        )
          yield* enqueue(message);
    }
  });

  return { enqueue, scan };
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const wake = yield* make;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const watch = threads.streamDomainEvents.pipe(
      Stream.runForEach((event) =>
        event.type === "message.updated" && event.payload.delegatedCompletion !== undefined
          ? wake.enqueue(event.payload).pipe(Effect.ignoreCause({ log: true }))
          : Effect.void,
      ),
    );
    yield* Effect.all([watch, wake.scan.pipe(Effect.ignoreCause({ log: true }))], {
      concurrency: "unbounded",
      discard: true,
    }).pipe(forkParked);
  }),
);
