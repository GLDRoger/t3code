import {
  KinOrgId,
  KinTaskCardState,
  type KinTaskFailure,
  type KinWidget,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";

export const taskCardEquivalent = Schema.toEquivalence(KinTaskCardState);
export const decodeTaskCard = Schema.decodeUnknownSync(KinTaskCardState);
export const decodeTaskCardEffect = Schema.decodeUnknownEffect(KinTaskCardState);

const statusFor = (shell: OrchestrationV2ThreadShell): KinTaskCardState["status"] => {
  if (shell.archivedAt !== null || shell.deletedAt !== null) return "cancelled";
  if (shell.pendingRuntimeRequest !== null && shell.pendingRuntimeRequest.blocking !== false)
    return "needs_decision";
  if (shell.blockedOnThreadWait === true) return "blocked";
  if (shell.activityRunStatus != null)
    return shell.activityRunStatus === "waiting" ? "waiting" : "working";
  switch (shell.status) {
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
    case "rolled_back":
      return "cancelled";
    case "completed":
      return "done";
    case "waiting":
    case "idle":
      return "waiting";
    default:
      return "working";
  }
};

// Match the thread's own PR chip: visible links, else the PR detected from its branch.
const pullRequestsFor = (shell: OrchestrationV2ThreadShell) => {
  const links = visibleThreadPullRequests(shell.pullRequests ?? []);
  const shown =
    links.length > 0 || shell.branchPullRequest == null ? links : [shell.branchPullRequest];
  return shown.map(({ url, number }) => ({ url, number }));
};

/** What stopped a failed task, from its provider's failure: null when it is none of these. */
const failureOf = (
  shell: OrchestrationV2ThreadShell,
  model: string | null,
): KinTaskFailure | null => {
  const code = shell.lastErrorCode ?? null;
  if (shell.lastErrorClass === "usage_limit") return "usage_limit";
  if (
    shell.lastErrorClass === "permission_error" ||
    code === "authentication_failed" ||
    code === "api_error_401"
  )
    return "signed_out";
  if (shell.lastErrorClass === "transport_error") return "unreachable";
  // A request the provider turned away that names the task's model: it doesn't serve that model.
  if (
    (code === "api_error_400" || code === "api_error_404") &&
    model !== null &&
    (shell.lastError ?? "").includes(model)
  )
    return "model_not_offered";
  return null;
};

export const taskCardState = (
  state: KinTaskCardState,
  shell: OrchestrationV2ThreadShell,
  updatedAt: string,
): KinTaskCardState => {
  const status = statusFor(shell);
  return {
    ...Struct.omit(state, ["failure"]),
    status,
    pullRequests: pullRequestsFor(shell),
    lastError:
      shell.archivedAt !== null || shell.deletedAt !== null
        ? "Thread no longer available"
        : (shell.lastError ?? null),
    ...(status === "failed" ? { failure: failureOf(shell, state.model) } : {}),
    updatedAt,
  };
};

export class TaskCardIndex extends Context.Service<
  TaskCardIndex,
  {
    readonly has: (threadId: ThreadId) => boolean;
    readonly threadIds: () => ReadonlyArray<ThreadId>;
    readonly cards: (threadId: ThreadId) => ReadonlyArray<KinWidget>;
    readonly untrack: (threadId: ThreadId, widgetId: string) => Effect.Effect<void>;
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
      has: (threadId) => threads.has(threadId),
      threadIds: () => [...threads.keys()],
      cards: (threadId) => [...(threads.get(threadId)?.values() ?? [])],
      untrack: Effect.fn("TaskCardIndex.untrack")(function* (threadId, widgetId) {
        const cards = threads.get(threadId);
        cards?.delete(widgetId);
        if (cards?.size === 0) threads.delete(threadId);
        yield* PubSub.publish(changes, undefined);
      }),
      changes,
      track: Effect.fn("TaskCardIndex.track")(function* (widget) {
        if (widget.type !== "task" || widget.orgId !== KinOrgId.make("kin-default")) return;
        const state = yield* decodeTaskCardEffect(widget.state).pipe(Effect.option);
        if (Option.isNone(state)) {
          yield* Effect.logWarning("Skipping invalid Kin task card state; render a placeholder.");
          return;
        }
        const task = state.value;
        if (task.threadId === null || task.remoteEnvironmentId !== null) return;
        let cards = threads.get(task.threadId);
        if (widget.closedAt !== null) {
          cards?.delete(widget.widgetId);
          if (cards?.size === 0) threads.delete(task.threadId);
        } else {
          if (cards === undefined) {
            cards = new Map();
            threads.set(task.threadId, cards);
          }
          cards.set(widget.widgetId, widget);
        }
        yield* PubSub.publish(changes, undefined);
      }),
    });
  }),
);
