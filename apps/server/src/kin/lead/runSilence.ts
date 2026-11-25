import type { OrchestrationV2DomainEvent, ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";

/** A run that shows no activity for this long is stuck and ended. It measures silence, never work. */
export const RUN_SILENCE_MS = 900_000;

const PROVIDER_EVENTS: ReadonlySet<OrchestrationV2DomainEvent["type"]> = new Set([
  "turn-item.updated",
  "message.updated",
  "provider-turn.updated",
  "provider-thread.updated",
  "runtime-request.updated",
  "subagent.updated",
  "node.updated",
  "plan.updated",
]);

/**
 * When the provider last showed it was working, if `event` is its doing: text, a tool call or
 * result, a status or a request. A person's or Kin's own message into the thread is not.
 */
export const activityAt = (event: OrchestrationV2DomainEvent) =>
  !PROVIDER_EVENTS.has(event.type) ||
  (event.type === "turn-item.updated" && event.payload.type === "user_message") ||
  (event.type === "message.updated" && event.payload.role === "user")
    ? undefined
    : DateTime.toEpochMillis(event.occurredAt);

/**
 * Waits for the run to end for as long as it keeps showing activity. It reports `timedOut` only
 * once `RUN_SILENCE_MS` has passed since `lastActivity()`. `eachWindow` runs as each window of
 * waiting starts, so what the run holds while it may run lasts that window too.
 */
export const waitWhileActive = Effect.fn("KinRunSilence.waitWhileActive")(function* <E, R>(
  threads: ThreadManagementService.ThreadManagementService["Service"],
  input: { readonly projectId: ProjectId; readonly threadId: ThreadId; readonly runId: RunId },
  lastActivity: () => number,
  eachWindow: Effect.Effect<void, E, R>,
) {
  while (true) {
    yield* eachWindow;
    const result = yield* threads.waitForThread({
      ...input,
      timeoutMs: Math.max(0, lastActivity() + RUN_SILENCE_MS - (yield* Clock.currentTimeMillis)),
    });
    if (!result.timedOut || (yield* Clock.currentTimeMillis) >= lastActivity() + RUN_SILENCE_MS)
      return result;
  }
});

export const QUIET_ASKS_MS = [900_000, 3_600_000] as const;

export const waitAsking = Effect.fn("KinRunSilence.waitAsking")(function* <
  E,
  R,
  QuietError,
  QuietServices,
>(
  threads: ThreadManagementService.ThreadManagementService["Service"],
  input: { readonly projectId: ProjectId; readonly threadId: ThreadId; readonly runId: RunId },
  lastActivity: () => number,
  eachWindow: (quietSince: number | null) => Effect.Effect<void, E, R>,
  onQuiet: (ask: 1 | 2, since: number) => Effect.Effect<void, QuietError, QuietServices>,
  alreadyAsked = 0,
) {
  let asked = alreadyAsked;
  while (true) {
    const threshold = QUIET_ASKS_MS[asked];
    const since = lastActivity();
    const quietAt = since + (threshold ?? QUIET_ASKS_MS[0]);
    const stillQuiet = threshold === undefined && (yield* Clock.currentTimeMillis) >= quietAt;
    yield* eachWindow(stillQuiet ? since : null);
    const result = yield* threads.waitForThread({
      ...input,
      timeoutMs: stillQuiet
        ? RUN_SILENCE_MS
        : Math.min(RUN_SILENCE_MS, Math.max(0, quietAt - (yield* Clock.currentTimeMillis))),
    });
    if (!result.timedOut) return result;
    const latest = lastActivity();
    if (threshold !== undefined && (yield* Clock.currentTimeMillis) - latest >= threshold) {
      yield* onQuiet(asked === 0 ? 1 : 2, latest);
      asked++;
    }
  }
});
