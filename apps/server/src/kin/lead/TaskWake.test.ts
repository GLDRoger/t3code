import { assert, it } from "@effect/vitest";
import {
  KinAgentId,
  type KinEvent,
  KinOrgId,
  MessageId,
  NodeId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import { ownerOnlyWakeup } from "./Audience.testkit.ts";
import { KinEventQueue } from "./KinEventQueue.ts";
import * as TaskWake from "./TaskWake.ts";

const orgId = KinOrgId.make("org");
const agentId = KinAgentId.make("tech");
const leadThread = ThreadId.make("kin:tech");
const notice = MessageId.make("delegated-completion:1");

const run = (
  id: string,
  ordinal: number,
  userMessageId: string,
  status: OrchestrationV2Run["status"],
  extra: Partial<OrchestrationV2Run> = {},
) =>
  ({
    id: RunId.make(id),
    ordinal,
    userMessageId: MessageId.make(userMessageId),
    status,
    ...extra,
  }) as OrchestrationV2Run;
const message = (
  id: string,
  runId: string | null,
  threadId: ThreadId = leadThread,
): OrchestrationV2ConversationMessage =>
  ({
    id: MessageId.make(id),
    threadId,
    runId: runId === null ? null : RunId.make(runId),
    role: "user",
    createdAt: DateTime.makeUnsafe(0),
    delegatedCompletion: {
      parentRunId: RunId.make("delegating"),
      generation: 1,
      taskIds: [NodeId.make("task-1")],
    },
  }) as unknown as OrchestrationV2ConversationMessage;

it.each([
  ["T3's run for it is queued", [run("wake", 2, notice, "queued")], "live:wake"],
  [
    "a held queue never starts by itself",
    [run("wake", 2, notice, "queued", { queueHeld: true })],
    "missed",
  ],
  ["it already ran with no wake-up", [run("wake", 2, notice, "completed")], "missed"],
  [
    "a restart cut it off and T3 continued it",
    [
      run("wake", 2, notice, "interrupted"),
      run("again", 3, "restart:1", "running", { restartContinuationOfRunId: RunId.make("wake") }),
    ],
    "live:again",
  ],
])("a finished-task notice: %s", (_, runs, expected) => {
  const state = TaskWake.noticeState({ messages: [message(notice, runs[0]!.id)], runs }, notice);
  assert.strictEqual(state._tag === "live" ? `live:${state.run.id}` : state._tag, expected);
});

it("a notice T3 steered into a turn already going was seen there", () => {
  const runs = [run("turn", 1, "kin-wakeup:w1", "running")];
  assert.strictEqual(
    TaskWake.noticeState({ messages: [message(notice, "turn")], runs }, notice)._tag,
    "seen",
  );
});

it.effect("a lead thread's notice becomes one task.finished event for its chat; others none", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* ownerOnlyWakeup({ orgId, agentId, wakeupId: "w0" });
    // The turn whose run handed the task out, so its result answers whoever asked there.
    yield* sql`UPDATE kin_wakeups SET run_id = 'delegating' WHERE wakeup_id = 'w0'`;
    yield* sql`INSERT INTO kin_agent_threads (thread_id, org_id, agent_id, started_at)
        VALUES (${leadThread}, ${orgId}, ${agentId}, '2026-11-08T00:00:00.000Z')`;
    const enqueued: Array<KinEvent> = [];
    const records = {
      messages: [message(notice, "wake")],
      runs: [run("wake", 2, notice, "running")],
    };
    const wake = yield* TaskWake.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(KinEventQueue)({
            enqueue: (event) =>
              Effect.sync(() => {
                const duplicate = enqueued.some((seen) => seen.eventId === event.eventId);
                if (!duplicate) enqueued.push(event);
                return { event, duplicate };
              }),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadRecords: () => Effect.succeed(records as never),
          }),
        ),
      ),
    );
    yield* wake.enqueue(message(notice, "wake"));
    // T3 updates the message as its run moves; a restart rescans.
    yield* wake.enqueue(message(notice, "wake"));
    yield* wake.scan;
    yield* wake.enqueue(message("shared-notice", null, ThreadId.make("kin-shared:tech")));
    yield* wake.enqueue(message("ordinary-notice", null, ThreadId.make("thread-1")));
    assert.deepStrictEqual(
      enqueued.map((event): ReadonlyArray<unknown> | string =>
        event._tag === "task.finished"
          ? [
              event.threadId,
              event.messageId,
              event.taskIds,
              event.chatId,
              event.provenance._tag,
              event.askedIn,
            ]
          : event._tag,
      ),
      [[leadThread, notice, ["task-1"], "org:owner-chat", "system", ["w0"]]],
    );
  }).pipe(Effect.provide(KinPersistence.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);
