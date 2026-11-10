import {
  KinOrgId,
  KinTaskCardState,
  type KinWidget,
  type OrchestratorMcpThreadDetail,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
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

export const taskCardState = (
  state: KinTaskCardState,
  shell: OrchestrationV2ThreadShell,
  updatedAt: string,
): KinTaskCardState => ({
  ...state,
  status: statusFor(shell),
  pullRequests: pullRequestsFor(shell),
  lastError:
    shell.archivedAt !== null || shell.deletedAt !== null
      ? "Thread no longer available"
      : (shell.lastError ?? null),
  updatedAt,
});

/**
 * A pull request link from another server, kept only as `https://github.com/<repo>/pull/<n>` for
 * the worker project's own repository (`repositoryKey`, `github.com/<owner>/<repo>`).
 */
const trustedPullRequest = (
  link: { readonly url: string; readonly number: number },
  repositoryKey: string | null,
) => {
  if (repositoryKey === null || !Number.isSafeInteger(link.number) || link.number <= 0)
    return undefined;
  const match =
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([0-9]+)$/.exec(link.url);
  if (match === null || Number(match[3]) !== link.number) return undefined;
  if (`github.com/${match[1]}/${match[2]}`.toLowerCase() !== repositoryKey.toLowerCase())
    return undefined;
  return { url: link.url, number: link.number };
};

/** A card's live fields from a thread in a linked environment, as `t3_thread_read` shows it. */
export const remoteTaskCardState = (
  thread: OrchestratorMcpThreadDetail,
  repositoryKey: string | null,
): Pick<KinTaskCardState, "status" | "pullRequests" | "lastError"> => {
  const status: KinTaskCardState["status"] = thread.archived
    ? "cancelled"
    : thread.pendingRequestCount > 0
      ? "needs_decision"
      : thread.status === "completed"
        ? "done"
        : thread.status === "failed"
          ? "failed"
          : thread.status === "cancelled" ||
              thread.status === "interrupted" ||
              thread.status === "rolled_back"
            ? "cancelled"
            : thread.status === "idle" || thread.status === "waiting"
              ? "waiting"
              : "working";
  const links = (thread.pullRequests ?? []).filter((link) => link.source !== "stack-dismissed");
  const shown =
    links.length > 0 || thread.linkedPullRequest === null ? links : [thread.linkedPullRequest];
  return {
    status,
    pullRequests: shown.flatMap((link) => {
      const trusted = trustedPullRequest(link, repositoryKey);
      return trusted === undefined ? [] : [trusted];
    }),
    lastError: thread.archived ? "Thread no longer available" : null,
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
