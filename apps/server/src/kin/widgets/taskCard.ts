import {
  KinOrgId,
  KinTaskCardState,
  type KinWidget,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";

export const taskCardEquivalent = Schema.toEquivalence(KinTaskCardState);
export const decodeTaskCard = Schema.decodeUnknownSync(KinTaskCardState);

export const taskCardState = (
  state: KinTaskCardState,
  shell: OrchestrationV2ThreadShell,
  updatedAt: string,
): KinTaskCardState => ({
  ...state,
  status:
    shell.archivedAt !== null || shell.deletedAt !== null
      ? "cancelled"
      : shell.pendingRuntimeRequest !== null
        ? "needs_decision"
        : shell.blockedOnThreadWait === true
          ? "blocked"
          : shell.activityRunStatus != null
            ? shell.activityRunStatus === "waiting"
              ? "waiting"
              : "working"
            : shell.status === "failed"
              ? "failed"
              : shell.status === "cancelled" ||
                  shell.status === "interrupted" ||
                  shell.status === "rolled_back"
                ? "cancelled"
                : shell.status === "completed"
                  ? "done"
                  : shell.status === "waiting"
                    ? "waiting"
                    : shell.status === "idle"
                      ? "waiting"
                      : "working",
  pullRequests: (shell.pullRequests ?? []).map(({ url, number }) => ({ url, number })),
  lastError:
    shell.archivedAt !== null || shell.deletedAt !== null
      ? "Thread no longer available"
      : (shell.lastError ?? null),
  updatedAt,
});

export class TaskCardIndex extends Context.Service<
  TaskCardIndex,
  {
    readonly threads: Map<ThreadId, Map<string, KinWidget>>;
    readonly changes: PubSub.PubSub<void>;
    readonly track: (widget: KinWidget) => Effect.Effect<void>;
  }
>()("t3/kin/widgets/taskCard/TaskCardIndex") {}

export const layer = Layer.effect(
  TaskCardIndex,
  Effect.gen(function* () {
    const threads = new Map<ThreadId, Map<string, KinWidget>>();
    const changes = yield* PubSub.sliding<void>(1);
    yield* Effect.addFinalizer(() => PubSub.shutdown(changes));
    return TaskCardIndex.of({
      threads,
      changes,
      track: Effect.fn("TaskCardIndex.track")(function* (widget) {
        if (widget.type !== "task" || widget.orgId !== KinOrgId.make("kin-default")) return;
        const state = decodeTaskCard(widget.state);
        if (state.threadId === null || state.remoteEnvironmentId !== null) return;
        let cards = threads.get(state.threadId);
        if (widget.closedAt !== null) {
          cards?.delete(widget.widgetId);
          if (cards?.size === 0) threads.delete(state.threadId);
        } else {
          if (cards === undefined) {
            cards = new Map();
            threads.set(state.threadId, cards);
          }
          cards.set(widget.widgetId, widget);
        }
        yield* PubSub.publish(changes, undefined);
      }),
    });
  }),
);
