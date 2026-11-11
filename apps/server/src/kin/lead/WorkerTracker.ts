import {
  CommandId,
  EnvironmentId,
  KinAgentId,
  KinAuthor,
  KinChatId,
  KinOrgId,
  type KinPersonId,
  KinTaskCardState,
  KinWorkerId,
  type OrchestratorMcpFailure,
  type OrchestrationV2RunStatus,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2Subagent,
  ModelSelection,
  ProjectId,
  ThreadId,
  type WorkerReport,
} from "@t3tools/contracts";
import { hashedEventId } from "./eventIds.ts";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import { isSqlError } from "effect/sql/SqlError";
import * as Stream from "effect/Stream";
import { FORWARDED_WAIT_CHUNK_MS } from "../../peer/PeerForwarding.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationEventStore } from "../../persistence/OrchestrationEventStore.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { KinChatHub } from "../chat/KinChatHub.ts";
import { KinChatRepository } from "../chat/KinChatRepository.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import { freezeMovedCard, workerChat } from "./ChatSharing.ts";
import * as Writer from "../memory/MemoryWriter.ts";
import { remoteTaskCardState } from "../widgets/taskCard.ts";
import { KinEventQueue } from "./KinEventQueue.ts";
import { KinLeadRegistry } from "./KinLeadRegistry.ts";
import * as KinLevels from "./KinLevels.ts";
import { isOrgPaused, STOP_REASON } from "./orgState.ts";
import { parseReport } from "./workerBrief.ts";
import * as WorkerEnvironment from "./workerEnvironment.ts";
import * as Publish from "./workerPublish.ts";
import { localThreadId, workThreadPrefix } from "./workThread.ts";

export const endedStatuses = new Set<OrchestrationV2RunStatus>([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);
const stoppedStatuses = new Set<OrchestrationV2RunStatus>(["interrupted", "cancelled"]);

/** Retry policy for the tracker's start and a follower that lost its link; tests swap it. */
export const WorkerTrackerRetry = Context.Reference<Schedule.Schedule<unknown, unknown>>(
  "t3/kin/lead/WorkerTracker/WorkerTrackerRetry",
  {
    defaultValue: () =>
      Schedule.min([Schedule.exponential("1 second"), Schedule.spaced("30 seconds")]),
  },
);
/** The least time between two passes of a follower; tests swap it. */
export const WorkerTrackerSpacing = Context.Reference<Duration.Duration>(
  "t3/kin/lead/WorkerTracker/WorkerTrackerSpacing",
  { defaultValue: () => Duration.seconds(1) },
);
/** The thread id a row holds until its launch there returns the real one. */
export const unboundThreadId = (workerId: KinWorkerId) => ThreadId.make(`kin-worker-${workerId}`);
const isBound = (worker: { readonly workerId: KinWorkerId; readonly threadId: ThreadId }) =>
  worker.threadId !== unboundThreadId(worker.workerId);
/** A worker on this server (`LocalWorkers`): no environment, and the thread Kin named for it. */
const isLocal = (worker: {
  readonly workerId: KinWorkerId;
  readonly threadId: ThreadId;
  readonly environmentId: EnvironmentId | null;
}) => worker.environmentId === null && worker.threadId === localThreadId(worker.workerId);
/** The longest one wait on a local worker's thread blocks a follower. */
const LOCAL_WAIT_MS = 600_000;
const MAX_REPLY_CHARS = 200_000;
const cardStateEquivalent = Schema.toEquivalence(
  KinTaskCardState.mapFields((fields) => ({
    status: fields.status,
    pullRequests: fields.pullRequests,
    lastError: fields.lastError,
  })),
);
/** The PR Kin opened comes first; the server there may list others, which taskCard.ts filters. */
const withPublished = (
  state: ReturnType<typeof remoteTaskCardState>,
  worker: { readonly pullRequestUrl: string | null; readonly pullRequestNumber: number | null },
) =>
  worker.pullRequestUrl === null || worker.pullRequestNumber === null
    ? state
    : {
        ...state,
        pullRequests: [
          { url: worker.pullRequestUrl, number: worker.pullRequestNumber },
          ...state.pullRequests.filter((pull) => pull.url !== worker.pullRequestUrl),
        ],
      };
/** Kin's PR replaces any the worker claims; a refusal becomes an open question for the lead. */
const withPublication = (
  report: WorkerReport,
  published: { readonly url: string } | { readonly refused: string } | undefined,
): WorkerReport =>
  published === undefined
    ? report
    : "url" in published
      ? {
          ...report,
          evidence: [
            { kind: "pr", ref: published.url, note: "Kin opened this from the worker's branch" },
            ...report.evidence.filter((item) => item.kind !== "pr"),
          ],
        }
      : { ...report, openQuestions: [...report.openQuestions, published.refused] };
const WorkerRow = Schema.Struct({
  orgId: KinOrgId,
  workerId: KinWorkerId,
  agentId: KinAgentId,
  threadId: ThreadId,
  chatId: Schema.NullOr(KinChatId),
  environmentId: Schema.NullOr(EnvironmentId),
  status: Schema.String,
  startedAt: Schema.Number,
  repositoryKey: Schema.NullOr(Schema.String),
  projectId: Schema.NullOr(ProjectId),
  remoteProjectId: Schema.NullOr(ProjectId),
  title: Schema.NullOr(Schema.String),
  model: Schema.String,
  kind: Schema.String,
  pullRequestUrl: Schema.NullOr(Schema.String),
  pullRequestNumber: Schema.NullOr(Schema.Number),
});
type WorkerRow = typeof WorkerRow.Type & {
  /** Set once its chat was shared after private work began: `chatId` is then the owner chat. */
  readonly moved: { readonly from: string | null; readonly leadName: string } | undefined;
};
const decodeWorker = Schema.decodeUnknownEffect(WorkerRow);
const decodeAuthor = Schema.decodeUnknownEffect(KinAuthor);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeSelection = Schema.decodeUnknownEffect(Schema.fromJsonString(ModelSelection));
/** The launch's request id there: a retry with it returns the thread the first one started. */
export const launchRequestId = (workerId: KinWorkerId) => `kin-worker:${workerId}`;

type StrayError =
  | Effect.Error<
      ReturnType<ThreadManagement.ThreadManagementService["Service"]["stopDelegatedTasks"]>
    >
  | Effect.Error<ReturnType<Writer.MemoryWriter["Service"]["appendJournal"]>>;

export class WorkerTracker extends Context.Service<
  WorkerTracker,
  {
    /** The stray-delegation guard for one stored `subagent.updated` event. */
    readonly process: (stored: OrchestrationV2StoredEvent) => Effect.Effect<void, StrayError>;
    /**
     * Follows a worker's thread in its environment until the latest run there settles, then
     * reports it. One follower per worker: asked again while it runs, it looks once more before
     * it ends. Returns that follower.
     */
    readonly track: (orgId: KinOrgId, workerId: KinWorkerId) => Effect.Effect<Fiber.Fiber<void>>;
    readonly start: Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/kin/lead/WorkerTracker") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const orchestrator = yield* OrchestratorV2;
  const events = yield* OrchestrationEventStore;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const queue = yield* KinEventQueue;
  const chat = yield* KinChatService;
  const registry = yield* KinLeadRegistry;
  const env = yield* WorkerEnvironment.KinWorkerEnvironment;
  const writer = yield* Effect.serviceOption(Writer.MemoryWriter);
  const publisher = yield* Effect.serviceOption(Publish.KinWorkerPublish);
  const repo = yield* KinChatRepository;
  const hub = yield* KinChatHub;
  const environment = yield* Effect.serviceOption(ServerEnvironment);
  const projects = yield* ProjectService.ProjectService;
  // Followers live as long as this service, so shutting down stops them.
  const followers = yield* Scope.Scope;
  const bootedAt = yield* Clock.currentTimeMillis;

  const workerRow = Effect.fn("WorkerTracker.workerRow")(function* (
    orgId: KinOrgId,
    workerId: KinWorkerId,
  ) {
    const [raw] = yield* sql`SELECT org_id AS "orgId", worker_id AS "workerId",
      agent_id AS "agentId", thread_id AS "threadId", chat_id AS "chatId",
      environment_id AS "environmentId", status, started_at AS "startedAt",
      repository_key AS "repositoryKey", project_id AS "projectId",
      remote_project_id AS "remoteProjectId", title,
      model_json AS model, kind, pull_request_url AS "pullRequestUrl",
      pull_request_number AS "pullRequestNumber"
      FROM kin_workers WHERE org_id = ${orgId} AND worker_id = ${workerId} ORDER BY worker_id`;
    if (raw === undefined) return undefined;
    const worker = yield* decodeWorker(raw);
    // Private work whose chat was shared since answers in its lead's owner chat (`workerChat`).
    const route = yield* workerChat({ orgId, workerId }).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
    return route?.moved === undefined
      ? { ...worker, moved: undefined }
      : {
          ...worker,
          chatId: route.chatId === null ? null : KinChatId.make(route.chatId),
          moved: route.moved,
        };
  });

  const author = Effect.fn("WorkerTracker.author")(function* (worker: WorkerRow) {
    const [row] = yield* sql<{ memberId: string; ownerPersonId: string }>`
      SELECT m.member_id AS "memberId", a.owner_person_id AS "ownerPersonId"
      FROM kin_agents a JOIN kin_chat_members m ON m.org_id = a.org_id AND m.agent_id = a.agent_id
      WHERE a.org_id = ${worker.orgId} AND a.agent_id = ${worker.agentId}
        AND m.chat_id = ${worker.chatId} AND m.left_at IS NULL ORDER BY m.member_id LIMIT 1`;
    return row === undefined
      ? ({ _tag: "system" } as const)
      : yield* decodeAuthor({
          _tag: "agent",
          agentId: worker.agentId,
          memberId: row.memberId,
          ownerPersonId: row.ownerPersonId,
          threadId: worker.threadId,
        });
  });
  /**
   * Where the report answers and who it is for, from the worker's stored row and the wake-up
   * that started it: its chat unless that is the owner chat, and where the work was first
   * asked, naming the teammate who asked, as `deferralOrigin` does for a reminder.
   */
  const askedFor = Effect.fn("WorkerTracker.askedFor")(function* (worker: WorkerRow) {
    // Moved private work answers the owner alone, in their chat, as if asked there.
    if (worker.moved !== undefined) return {};
    const [row] = yield* sql<{
      wakeupId: string;
      ownerChatId: KinChatId;
      ownerPersonId: string;
      askedBy: KinPersonId | null;
    }>`SELECT k.wakeup_id AS "wakeupId", l.owner_chat_id AS "ownerChatId",
        a.owner_person_id AS "ownerPersonId",
        CASE WHEN json_extract(k.provenance_json, '$._tag') = 'human'
          THEN json_extract(k.provenance_json, '$.personId') END AS "askedBy"
      FROM kin_workers k JOIN kin_leads l ON l.org_id = k.org_id AND l.agent_id = k.agent_id
      JOIN kin_agents a ON a.org_id = k.org_id AND a.agent_id = k.agent_id
      WHERE k.org_id = ${worker.orgId} AND k.worker_id = ${worker.workerId} ORDER BY k.worker_id`;
    if (row === undefined) return {};
    const started = { orgId: worker.orgId, agentId: worker.agentId, wakeupId: row.wakeupId };
    const origins = yield* KinLevels.origins(started);
    const personId =
      (yield* KinLevels.askers(started))[0] ??
      origins.find((origin) => origin.personId !== undefined)?.personId ??
      (row.askedBy !== null && row.askedBy !== row.ownerPersonId ? row.askedBy : undefined);
    const chatId =
      worker.chatId !== null && worker.chatId !== row.ownerChatId ? worker.chatId : undefined;
    const first = origins[0];
    const origin =
      first !== undefined
        ? { ...first, ...(personId === undefined ? {} : { personId }) }
        : personId === undefined
          ? undefined
          : { agentId: worker.agentId, chatId: worker.chatId ?? row.ownerChatId, personId };
    return {
      ...(chatId === undefined ? {} : { chatId }),
      ...(origin === undefined ? {} : { origin }),
    };
  });
  /** Keyed on the answer run, so a replay enqueues the same event; `key` names it. */
  const enqueueReport = Effect.fn("WorkerTracker.enqueueReport")(function* (
    worker: WorkerRow,
    key: string,
    endedAt: number,
    report: WorkerReport,
  ) {
    const eventId = hashedEventId(key.slice(0, key.indexOf(":")), key);
    yield* queue
      .enqueue({
        _tag: "worker.report",
        orgId: worker.orgId,
        eventId,
        agentId: worker.agentId,
        receivedAt: DateTime.makeUnsafe(endedAt),
        dedupeKey: key,
        provenance: yield* author(worker),
        workerId: worker.workerId,
        report,
        ...(yield* askedFor(worker).pipe(Effect.provideService(SqlClient.SqlClient, sql))),
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
  const blocked = (worker: WorkerRow, environmentId: EnvironmentId, summary: string) =>
    ({
      result: "blocked",
      summary,
      evidence: [
        { kind: "link", ref: formatThreadLink({ environmentId, threadId: worker.threadId }) },
      ],
      openQuestions: [],
      memorySuggestions: [],
      misleadingMemory: [],
      parsed: false,
    }) satisfies WorkerReport;
  /**
   * A moved worker's card: frozen where it was, and one in the owner chat it answers in now,
   * made the first time something there needs it.
   */
  const movedCard = Effect.fn("WorkerTracker.movedCard")(function* (
    worker: WorkerRow,
    chatId: KinChatId,
  ) {
    const moved = worker.moved;
    if (moved === undefined) return;
    if (moved.from !== null)
      yield* sql
        .withTransaction(
          freezeMovedCard({
            orgId: worker.orgId,
            chatId: moved.from,
            threadId: worker.threadId,
            leadName: moved.leadName,
          }),
        )
        .pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.provideService(KinChatRepository, repo),
          Effect.provideService(KinChatHub, hub),
        );
    if (Option.isNone(environment) || worker.environmentId === null || !isBound(worker)) return;
    yield* chat
      .createTaskCard({
        orgId: worker.orgId,
        chatId,
        authorAgentId: worker.agentId,
        threadId: worker.threadId,
        title: worker.title ?? "Worker",
        model: (yield* decodeSelection(worker.model)).model,
        remote: { environmentId: worker.environmentId, status: "working" },
      })
      .pipe(
        Effect.provideService(ServerEnvironment, environment.value),
        Effect.provideService(OrchestratorV2, orchestrator),
      );
  });
  /**
   * Cards are best effort: a worker's outcome never waits on its card. Routed from the row as
   * stored now, in the card write's transaction: a join during a remote call may have moved it.
   */
  const card = <A, E>(worker: WorkerRow, effect: (chatId: KinChatId) => Effect.Effect<A, E>) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const current = yield* workerRow(worker.orgId, worker.workerId);
          if (current === undefined || current.chatId === null) return;
          yield* movedCard(current, current.chatId);
          yield* effect(current.chatId);
        }),
      )
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Kin worker task card unavailable", { cause }),
        ),
      );
  /** Records the outcome unless a follow-up started newer work meanwhile; false when it did. */
  const record = Effect.fn("WorkerTracker.record")(function* (
    worker: WorkerRow,
    input: {
      readonly key: string;
      readonly status: OrchestrationV2RunStatus;
      readonly endedAt: number;
      readonly report: WorkerReport;
    },
  ) {
    const reportJson = yield* encodeJson(input.report);
    // The row and the lead's report commit together, so a crash between them loses neither.
    const recorded = yield* sql.withTransaction(
      Effect.gen(function* () {
        const updated = yield* sql`UPDATE kin_workers SET status = ${input.status},
          report_json = ${reportJson}, ended_at = ${input.endedAt}
          WHERE org_id = ${worker.orgId} AND worker_id = ${worker.workerId}
            AND started_at = ${worker.startedAt} RETURNING worker_id`;
        if (updated.length === 0) return false;
        // Routed from the row as stored now, never the one read before the wait there.
        const current = yield* workerRow(worker.orgId, worker.workerId);
        if (current === undefined) return false;
        yield* enqueueReport(current, input.key, input.endedAt, input.report);
        return true;
      }),
    );
    if (!recorded) return false;
    if (stoppedStatuses.has(input.status))
      yield* card(worker, (chatId) =>
        chat.setTaskCardClosed({
          orgId: worker.orgId,
          chatId,
          threadId: worker.threadId,
          closed: true,
        }),
      );
    return true;
  });

  /**
   * Kin pushes a finished build worker's branch and opens its draft PR, then remembers the PR
   * for the card. A refusal is a sentence for the lead, never words from the worker there.
   */
  const publish = Effect.fn("WorkerTracker.publish")(function* (
    worker: WorkerRow,
    worktreePath: string | null,
    local?: { readonly projectRoot: string },
  ) {
    const branch = Publish.publishBranch(worker.workerId);
    const refused = (reason: string) => ({ refused: `Kin didn't publish ${branch}: ${reason}.` });
    if (Option.isNone(publisher))
      return refused(
        local === undefined
          ? "this host has no Kin GitHub App, so the commits stay in the worker environment"
          : "this host has no Kin GitHub App, so the changes stay in the worker's worktree",
      );
    if (worker.repositoryKey === null || worktreePath === null)
      return refused("the worker has no repository or worktree to publish from");
    // Unreadable counts as paused: a publish never outruns the owner's pause.
    const paused = isOrgPaused(worker.orgId).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.orElseSucceed(() => true),
    );
    if (yield* paused)
      return refused("Kin is paused; ask the worker for a follow-up after the owner resumes");
    const pull = yield* publisher.value
      .publish({
        workerId: worker.workerId,
        repositoryKey: worker.repositoryKey,
        worktreePath,
        ...(local === undefined ? {} : { local }),
        title: worker.title ?? "Kin worker",
        paused,
      })
      .pipe(Effect.result);
    if (pull._tag === "Failure") {
      yield* Effect.logWarning("Kin didn't publish a worker's branch", {
        workerId: worker.workerId,
        reason: pull.failure.reason,
      });
      return refused(pull.failure.reason);
    }
    yield* sql`UPDATE kin_workers SET pull_request_url = ${pull.success.url},
        pull_request_number = ${pull.success.number}
      WHERE org_id = ${worker.orgId} AND worker_id = ${worker.workerId}`;
    return { url: pull.success.url, number: pull.success.number };
  });

  /**
   * A launch whose reply never came: asks there again with the same request id and no message,
   * which returns the thread the launch started, or an idle one when it never arrived. Either
   * way the row gets a thread to follow, stop and report. False until then.
   */
  const reconcile = Effect.fn("WorkerTracker.reconcile")(function* (
    worker: WorkerRow,
    environmentId: EnvironmentId,
  ) {
    if (worker.status !== "queued" || worker.remoteProjectId === null) return true;
    // Paused: the worker server is down, and asking would only fail.
    if (yield* isOrgPaused(worker.orgId).pipe(Effect.provideService(SqlClient.SqlClient, sql)))
      return false;
    const found = yield* env
      .call(environmentId, WorkerEnvironment.tools.launch, {
        projectId: worker.remoteProjectId,
        title: worker.title ?? "Worker",
        modelSelection: yield* decodeSelection(worker.model),
        runtimeMode: "full-access",
        interactionMode: "default",
        clientRequestId: launchRequestId(worker.workerId),
      })
      .pipe(
        Effect.map((launched) => launched.threadId),
        Effect.catchIf(
          (error) => error.code === "invalid_request",
          () => Effect.undefined,
        ),
      );
    if (found === undefined)
      return yield* record(worker, {
        key: `worker-abandoned:${worker.workerId}:${worker.startedAt}`,
        status: "failed",
        endedAt: yield* Clock.currentTimeMillis,
        report: blocked(worker, environmentId, "The worker environment never started this worker."),
      });
    yield* sql`UPDATE kin_workers SET thread_id = ${found}
      WHERE org_id = ${worker.orgId} AND worker_id = ${worker.workerId}
        AND thread_id = ${unboundThreadId(worker.workerId)}`;
    return false;
  });

  /** One wait on the worker's thread there; true once its latest run is reported. */
  const followOnce = Effect.fn("WorkerTracker.followOnce")(function* (
    orgId: KinOrgId,
    workerId: KinWorkerId,
    shown: { card?: ReturnType<typeof remoteTaskCardState> },
  ) {
    const worker = yield* workerRow(orgId, workerId);
    if (worker === undefined) return true;
    if (endedStatuses.has(worker.status as OrchestrationV2RunStatus)) return true;
    if (isLocal(worker)) return yield* followLocalOnce(worker);
    if (worker.environmentId === null) return true;
    const environmentId = worker.environmentId;
    if (!isBound(worker)) return yield* reconcile(worker, environmentId);
    // The worker's own tasks there wake it for its answer, which the report waits for.
    const waited = yield* env.call(environmentId, WorkerEnvironment.tools.wait, {
      threadId: worker.threadId,
      timeoutMs: FORWARDED_WAIT_CHUNK_MS,
      untilDelegatedWorkSettled: true,
    });
    const read = yield* env.call(environmentId, WorkerEnvironment.tools.read, {
      threadId: worker.threadId,
      limit: 1,
      runLimit: 5,
    });
    // The worker server is stopped while Kin is paused; one that still runs a turn is stopped again.
    if (
      read.thread.activeRunId !== null &&
      (yield* isOrgPaused(orgId).pipe(Effect.provideService(SqlClient.SqlClient, sql)))
    ) {
      yield* WorkerEnvironment.stopThere(env, {
        environmentId,
        threadId: worker.threadId,
        key: `kin-stop-follow:${worker.workerId}:${read.thread.activeRunId}`,
        reason: STOP_REASON,
      }).pipe(Effect.ignore);
      yield* env.stopServer.pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Kin could not stop the worker server during a pause", { cause }),
        ),
      );
      return false;
    }
    const state = withPublished(remoteTaskCardState(read.thread, worker.repositoryKey), worker);
    if (shown.card === undefined || !cardStateEquivalent(shown.card, state))
      yield* card(worker, (chatId) =>
        chat
          .setTaskCardState({ orgId, chatId, threadId: worker.threadId, state })
          .pipe(Effect.tap(() => Effect.sync(() => void (shown.card = state)))),
      );
    if (waited.timedOut) return false;
    if (waited.runId === null) {
      const now = yield* Clock.currentTimeMillis;
      return yield* record(worker, {
        key: `worker-abandoned:${worker.workerId}:${worker.startedAt}`,
        status: "failed",
        endedAt: now,
        report: blocked(worker, environmentId, "The worker's thread never started a run."),
      });
    }
    // A follow-up, restart or usage-limit continuation carries the work on; its end reports.
    if (waited.status === "idle" || !endedStatuses.has(waited.status)) return false;
    if (read.thread.activeRunId !== null || read.thread.latestRunId !== waited.runId) return false;
    const answer = waited.resultRun ?? { runId: waited.runId, status: waited.status };
    const status = endedStatuses.has(answer.status) ? answer.status : "failed";
    const reply =
      status === "completed"
        ? yield* WorkerEnvironment.lastReply(env, environmentId, worker.threadId, answer.runId)
        : undefined;
    const completedAt = read.recentRuns.find((run) => run.runId === answer.runId)?.completedAt;
    const report =
      (reply === undefined ? undefined : parseReport(reply)) ??
      blocked(worker, environmentId, `Worker ended ${status} without a report.`);
    const published =
      status === "completed" && worker.kind === "build"
        ? yield* publish(worker, read.thread.worktreePath)
        : undefined;
    if (published !== undefined && "url" in published)
      yield* card(worker, (chatId) =>
        chat.setTaskCardState({
          orgId,
          chatId,
          threadId: worker.threadId,
          state: withPublished(state, {
            pullRequestUrl: published.url,
            pullRequestNumber: published.number,
          }),
        }),
      );
    return yield* record(worker, {
      key: `worker-report:${answer.runId}`,
      status,
      endedAt:
        completedAt == null
          ? yield* Clock.currentTimeMillis
          : DateTime.toEpochMillis(DateTime.makeUnsafe(completedAt)),
      report: withPublication(report, published),
    });
  });

  /**
   * One wait on a worker's thread on this server; true once its latest run is reported. Kin, not
   * the worker, commits and publishes, and only after the run ended completed.
   */
  const followLocalOnce = Effect.fn("WorkerTracker.followLocalOnce")(function* (worker: WorkerRow) {
    const here = Option.isSome(environment)
      ? yield* environment.value.getEnvironmentId
      : EnvironmentId.make("local");
    const abandoned = Effect.fn("WorkerTracker.localAbandoned")(function* (summary: string) {
      return yield* record(worker, {
        key: `worker-abandoned:${worker.workerId}:${worker.startedAt}`,
        status: "failed",
        endedAt: yield* Clock.currentTimeMillis,
        report: blocked(worker, here, summary),
      });
    });
    const shell = yield* orchestrator.getThreadShell(worker.threadId);
    if (shell === null) return yield* abandoned("The worker's thread never started.");
    // The project the row was started in, never one the thread was moved to since.
    if (worker.projectId === null || shell.projectId !== worker.projectId)
      return yield* abandoned("The worker's thread is no longer in its project.");
    const waited = yield* threads.waitForThread({
      projectId: worker.projectId,
      threadId: worker.threadId,
      timeoutMs: LOCAL_WAIT_MS,
    });
    if (waited.timedOut) return false;
    if (waited.run === null) return yield* abandoned("The worker's thread never started a run.");
    if (!endedStatuses.has(waited.run.status)) return false;
    const projection = yield* threads.getThreadProjection(worker.threadId);
    // Someone wrote in the thread since: that newer run's end reports instead.
    if (projection.runs.at(-1)?.id !== waited.run.id) return false;
    const run = waited.run;
    const reply = projection.messages
      .findLast((message) => message.role === "assistant" && message.runId === run.id)
      ?.text.slice(-MAX_REPLY_CHARS);
    const report =
      (reply === undefined ? undefined : parseReport(reply)) ??
      blocked(worker, here, `Worker ended ${run.status} without a report.`);
    const project =
      run.status === "completed" && worker.kind === "build"
        ? Option.getOrUndefined(yield* projects.getById(worker.projectId))
        : undefined;
    const published =
      run.status !== "completed" || worker.kind !== "build"
        ? undefined
        : project === undefined
          ? {
              refused: `Kin didn't publish ${Publish.publishBranch(worker.workerId)}: the worker's project is gone.`,
            }
          : yield* publish(worker, projection.thread.worktreePath, {
              projectRoot: project.workspaceRoot,
            });
    if (published !== undefined && "url" in published) yield* linkPullRequest(worker, published);
    return yield* record(worker, {
      key: `worker-report:${run.id}`,
      status: run.status,
      endedAt:
        run.completedAt === null
          ? yield* Clock.currentTimeMillis
          : DateTime.toEpochMillis(run.completedAt),
      report: withPublication(report, published),
    });
  });

  /** The thread's own PR link, which its task card and thread view show (`TaskCardUpdater`). */
  const linkPullRequest = Effect.fn("WorkerTracker.linkPullRequest")(
    function* (worker: WorkerRow, pull: { readonly url: string; readonly number: number }) {
      const repository = worker.repositoryKey?.replace(/^github\.com\//i, "");
      if (repository === undefined) return;
      yield* threads.dispatch({
        type: "thread.pull-request.link",
        commandId: CommandId.make(`kin-work-pr:${worker.workerId}:${pull.number}`),
        threadId: worker.threadId,
        host: "github.com",
        repository,
        number: pull.number,
        url: pull.url,
        source: "created",
      });
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Kin couldn't link a worker's PR to its thread", { cause }),
    ),
  );

  /** A revoked or expired link, or a thread gone there: the worker can't report, so it fails. */
  const abandon = Effect.fn("WorkerTracker.abandon")(function* (
    orgId: KinOrgId,
    workerId: KinWorkerId,
    error: OrchestratorMcpFailure,
  ) {
    yield* Effect.logWarning("Kin worker unreachable in its environment", {
      workerId,
      code: error.code,
    });
    const worker = yield* workerRow(orgId, workerId);
    if (worker === undefined || worker.environmentId === null) return;
    yield* record(worker, {
      key: `worker-abandoned:${worker.workerId}:${worker.startedAt}`,
      status: "failed",
      endedAt: yield* Clock.currentTimeMillis,
      report: blocked(
        worker,
        worker.environmentId,
        `Kin can no longer reach this worker. ${WorkerEnvironment.describeFailure(error).known}`,
      ),
    });
    yield* card(worker, (chatId) =>
      chat.setTaskCardClosed({ orgId, chatId, threadId: worker.threadId, closed: true }),
    );
  });

  const giveUpIfFinal = Effect.fn("WorkerTracker.giveUpIfFinal")(function* (
    orgId: KinOrgId,
    workerId: KinWorkerId,
    error: OrchestratorMcpFailure,
  ) {
    if (!WorkerEnvironment.isFinal(error)) return yield* error;
    yield* abandon(orgId, workerId, error);
  });

  const follow = Effect.fn("WorkerTracker.follow")(function* (
    orgId: KinOrgId,
    workerId: KinWorkerId,
  ) {
    const retry = yield* WorkerTrackerRetry;
    const spacing = yield* WorkerTrackerSpacing;
    const shown: { card?: ReturnType<typeof remoteTaskCardState> } = {};
    // Spaced, so a server that answers every wait at once can't spin Kin.
    yield* followOnce(orgId, workerId, shown).pipe(
      Effect.repeat({ schedule: Schedule.spaced(spacing), while: (done) => !done }),
      Effect.catchTags({
        OrchestratorMcpFailure: (error) => giveUpIfFinal(orgId, workerId, error),
      }),
      Effect.mapError((error) =>
        isSqlError(error) ? toPersistenceSqlError("WorkerTracker.follow")(error) : error,
      ),
      Effect.tapError((cause) => Effect.logWarning("Kin worker follower retrying", { cause })),
      Effect.retry(retry),
      Effect.ignoreCause({ log: true }),
    );
  });

  const following = new Map<KinWorkerId, { again: boolean; fiber?: Fiber.Fiber<void> }>();
  const track: WorkerTracker["Service"]["track"] = Effect.fnUntraced(function* (orgId, workerId) {
    const running = following.get(workerId);
    if (running?.fiber !== undefined) {
      running.again = true;
      return running.fiber;
    }
    const state: { again: boolean; fiber?: Fiber.Fiber<void> } = { again: false };
    following.set(workerId, state);
    const fiber = yield* follow(orgId, workerId).pipe(
      // Checked and released in one step, so a request between them is never lost.
      Effect.repeat({
        while: () => {
          if (state.again) {
            state.again = false;
            return true;
          }
          following.delete(workerId);
          return false;
        },
      }),
      Effect.ensuring(
        Effect.sync(() => {
          if (following.get(workerId) === state) following.delete(workerId);
        }),
      ),
      Effect.asVoid,
      Effect.forkIn(followers),
    );
    state.fiber = fiber;
    return fiber;
  });

  const strays = new Set<string>();
  const strayDelegation = Effect.fn("WorkerTracker.strayDelegation")(function* (
    subagent: OrchestrationV2Subagent,
  ) {
    if (subagent.origin !== "app_owned" || strays.has(subagent.id)) return;
    const lead = registry.lookup(subagent.threadId);
    if (lead === undefined) return;
    strays.add(subagent.id);
    yield* threads.stopDelegatedTasks({
      threadId: subagent.threadId,
      commandId: CommandId.make(`kin-stray:${subagent.id}`),
      reason: "Kin leads start workers only through kin_delegate.",
    });
    if (Option.isSome(writer))
      yield* writer.value.appendJournal(lead.orgId, lead.wakeupId, [
        "Did: Kin stopped a delegate_task the lead started; workers start only through kin_delegate.",
      ]);
  });
  const process: WorkerTracker["Service"]["process"] = (stored) =>
    stored.event.type === "subagent.updated" ? strayDelegation(stored.event.payload) : Effect.void;

  // Rows from before K032 name no environment, so there is nothing there to look for.
  const failUnplaced = sql`UPDATE kin_workers SET status = 'failed', ended_at = ${bootedAt}
    WHERE org_id IN (SELECT org_id FROM kin_leads GROUP BY org_id)
      AND status = 'queued' AND thread_id = 'kin-worker-' || worker_id AND environment_id IS NULL`;
  // Unconfirmed launches included: their followers find what the launch started there.
  const openWorkers = sql<{ orgId: string; workerId: string }>`
    SELECT org_id AS "orgId", worker_id AS "workerId" FROM kin_workers
    WHERE org_id IN (SELECT org_id FROM kin_leads GROUP BY org_id)
      AND (environment_id IS NOT NULL OR thread_id = ${workThreadPrefix} || worker_id)
      AND status NOT IN ${sql.in([...endedStatuses])}
    ORDER BY org_id, worker_id`;

  const start = Effect.gen(function* () {
    const retry = yield* WorkerTrackerRetry;
    const latest = yield* events.latestAgentSequence().pipe(Effect.retry(retry));
    let after = latest;
    yield* Effect.suspend(() =>
      orchestrator
        .streamStoredEventsFrom({ eventType: "subagent.updated", afterSequence: after })
        .pipe(
          Stream.runForEach((stored) =>
            process(stored).pipe(
              Effect.retry({ schedule: retry, times: 7 }),
              Effect.ignoreCause({ log: true }),
              Effect.andThen(
                Effect.sync(() => {
                  after = Math.max(after, stored.sequence);
                }),
              ),
            ),
          ),
        ),
    ).pipe(
      Effect.tapCause((cause) =>
        Effect.logWarning("Kin stray-delegation guard stream failed; resuming", { cause }),
      ),
      Effect.retry(retry),
      Effect.forkScoped,
    );
    yield* failUnplaced.pipe(Effect.retry(retry));
    for (const row of yield* openWorkers.pipe(Effect.retry(retry)))
      yield* track(KinOrgId.make(row.orgId), KinWorkerId.make(row.workerId));
  }).pipe(
    Effect.catchCause((cause) => Effect.logError("Kin worker tracker unavailable", { cause })),
  );

  return WorkerTracker.of({ process, track, start });
});

export const layer = Layer.effect(WorkerTracker, make);
