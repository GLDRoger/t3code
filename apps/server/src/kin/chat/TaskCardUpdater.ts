import { KinOrgId, type ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import * as TaskCard from "../widgets/taskCard.ts";
import { KinChatHub } from "./KinChatHub.ts";
import { KinChatRepository } from "./KinChatRepository.ts";

const start = Effect.gen(function* () {
  const orchestrator = yield* OrchestratorV2;
  const repo = yield* KinChatRepository;
  const hub = yield* KinChatHub;
  const index = yield* TaskCard.TaskCardIndex;
  const sql = yield* SqlClient.SqlClient;
  const scope = yield* Effect.scope;
  const workers = new Map<ThreadId, { queue: Queue.Queue<void>; fiber: Fiber.Fiber<void> }>();
  const refresh = Effect.fn("KinTaskCardUpdater.refresh")(function* (threadId: ThreadId) {
    if (!index.has(threadId)) return;
    const shell = yield* orchestrator.getThreadShell(threadId);
    for (const card of index.cards(threadId)) {
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const current = yield* repo.getWidget(card);
            if (Option.isNone(current) || current.value.closedAt !== null) {
              yield* sql.afterCommit(index.untrack(threadId, card.widgetId));
              return;
            }
            const widget = current.value;
            const decoded = yield* TaskCard.decodeTaskCardEffect(widget.state).pipe(Effect.option);
            if (Option.isNone(decoded)) {
              yield* Effect.logWarning(
                "Skipping invalid Kin task card state; render a placeholder.",
              );
              yield* sql.afterCommit(index.untrack(threadId, card.widgetId));
              return;
            }
            const state = decoded.value;
            const updatedAt = DateTime.formatIso(yield* DateTime.now);
            const next =
              shell === null
                ? {
                    ...state,
                    status: "cancelled" as const,
                    lastError: "Thread no longer available",
                    updatedAt,
                  }
                : TaskCard.taskCardState(state, shell, updatedAt);
            if (TaskCard.taskCardEquivalent({ ...next, updatedAt: state.updatedAt }, state)) return;
            const updated = yield* repo.updateWidget({
              ...widget,
              expectedRevision: widget.revision,
              state: next,
              updatedAt,
            });
            yield* hub.publish({ type: "widget.updated", orgId: widget.orgId, widget: updated });
          }),
        )
        .pipe(Effect.catchCause(() => Effect.logWarning("Kin task card refresh failed.")));
    }
  });
  const safeRefresh = Effect.fn("KinTaskCardUpdater.refreshSafely")((threadId: ThreadId) =>
    refresh(threadId).pipe(
      Effect.catchCause(() =>
        Effect.logWarning("Kin task thread unavailable; keeping last card state."),
      ),
    ),
  );
  const reconcile = Effect.fn("KinTaskCardUpdater.reconcile")(function* (threadId: ThreadId) {
    const worker = workers.get(threadId);
    if (!index.has(threadId)) {
      if (worker !== undefined) {
        workers.delete(threadId);
        yield* Fiber.interrupt(worker.fiber);
        yield* Queue.shutdown(worker.queue);
      }
      return;
    }
    if (worker === undefined) {
      const queue = yield* Queue.sliding<void>(1);
      const fiber = yield* Stream.fromQueue(queue).pipe(
        Stream.rechunk(1),
        Stream.throttle({ cost: () => 1, units: 1, duration: "1 second", strategy: "shape" }),
        Stream.runForEach(() => safeRefresh(threadId)),
        Effect.forkIn(scope),
      );
      workers.set(threadId, { queue, fiber });
    }
    yield* Queue.offer(workers.get(threadId)!.queue, undefined);
  });
  const changes = yield* PubSub.subscribe(index.changes);
  yield* Effect.gen(function* () {
    for (const widget of yield* repo.openTaskCards({ orgId: KinOrgId.make("kin-default") })) {
      yield* index.track(widget);
    }
    yield* PubSub.publish(index.changes, undefined);
  }).pipe(
    Effect.catchCause(() => Effect.logWarning("Kin task card startup recheck failed.")),
    Effect.forkIn(scope),
  );
  // Every server event crosses this path; reject unlinked threads without tracing or SQL.
  const onEvent = Effect.fnUntraced(function* (threadId: ThreadId) {
    const worker = workers.get(threadId);
    if (worker !== undefined) yield* Queue.offer(worker.queue, undefined);
  });
  yield* Stream.unwrap(
    Effect.gen(function* () {
      for (const worker of workers.values()) yield* Queue.offer(worker.queue, undefined);
      return orchestrator.streamDomainEvents;
    }),
  ).pipe(
    Stream.runForEach((event) => onEvent(event.threadId)),
    Effect.tapCause(() => Effect.logWarning("Kin task card event stream failed; reconnecting.")),
    Effect.retry(Schedule.min([Schedule.exponential("1 second"), Schedule.spaced("30 seconds")])),
    Effect.forkIn(scope),
  );
  yield* Stream.fromEffectRepeat(PubSub.take(changes)).pipe(
    Stream.runForEach(() =>
      Effect.forEach(new Set([...workers.keys(), ...index.threadIds()]), reconcile, {
        discard: true,
      }),
    ),
    Effect.forkIn(scope),
  );
});

export const layer = Layer.effectDiscard(start);
