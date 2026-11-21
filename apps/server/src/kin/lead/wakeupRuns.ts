import type { MessageId, OrchestrationV2TurnItem, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";

type Threads = Pick<ThreadManagement.ThreadManagementService["Service"], "getThreadRecords">;

/**
 * A wake-up's root run and every run after it, without the rest of the lead thread's history.
 * Its steers, rescue and continuations all start after the root, and ordinals are unique per
 * thread, so the newest (latest - root + 1) runs hold them all.
 */
export const runsFrom = Effect.fn("KinWakeupRuns.runsFrom")(function* (
  threads: Threads,
  threadId: ThreadId,
  rootRunId: RunId,
) {
  const [root] = (yield* threads.getThreadRecords(threadId, ["runs"], { runIds: [rootRunId] }))
    .runs;
  if (root === undefined) return [];
  const [latest] = (yield* threads.getThreadRecords(threadId, ["runs"], { latestRunLimit: 1 }))
    .runs;
  const { runs } = yield* threads.getThreadRecords(threadId, ["runs"], {
    latestRunLimit: Math.max(1, (latest?.ordinal ?? root.ordinal) - root.ordinal + 1),
  });
  return runs.filter((run) => run.ordinal >= root.ordinal);
});

/** `runsFrom`, their turn items, and the messages whose text those items left out. */
export const turnRecords = Effect.fn("KinWakeupRuns.turnRecords")(function* (
  threads: Threads,
  threadId: ThreadId,
  rootRunId: RunId,
  items: {
    readonly turnItemTypes?: ReadonlyArray<OrchestrationV2TurnItem["type"]>;
    readonly turnItemStatuses?: ReadonlyArray<OrchestrationV2TurnItem["status"]>;
  } = {},
) {
  const runs = yield* runsFrom(threads, threadId, rootRunId);
  const { turnItems } = yield* threads.getThreadRecords(threadId, ["turnItems"], {
    ...items,
    turnItemRunIds: runs.map((run) => run.id),
  });
  const omitted = turnItems.flatMap((item) =>
    item.type === "assistant_message" && item.textOmitted === true ? [item.messageId] : [],
  );
  const { messages } =
    omitted.length === 0
      ? { messages: [] }
      : yield* threads.getThreadRecords(threadId, ["messages"], { messageIds: omitted });
  return { runs, turnItems, messages };
});

/** What `noticeState` reads of a finished-task notice: its message and the runs from its run on. */
export const noticeRecords = Effect.fn("KinWakeupRuns.noticeRecords")(function* (
  threads: Threads,
  threadId: ThreadId,
  messageId: MessageId,
) {
  const { messages } = yield* threads.getThreadRecords(threadId, ["messages"], {
    messageIds: [messageId],
  });
  const runId = messages[0]?.runId ?? null;
  return { messages, runs: runId === null ? [] : yield* runsFrom(threads, threadId, runId) };
});
