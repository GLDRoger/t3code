import {
  CommandId,
  KIN_WORKER_PUBLISH_CARD,
  KinWorkerPublishCard,
  EnvironmentId,
  KinAgentId,
  KinAuthor,
  KinChatError,
  KinChatId,
  KinMessageId,
  KinOrgId,
  type KinPersonId,
  KinTaskCardState,
  KinWorkerId,
  OrchestratorMcpFailure,
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
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import { isSqlError } from "effect/sql/SqlError";
import * as Stream from "effect/Stream";
import { ServerConfig } from "../../config.ts";
import { FORWARDED_WAIT_CHUNK_MS } from "../../peer/PeerForwarding.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationEventStore } from "../../persistence/OrchestrationEventStore.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { KinChatHub } from "../chat/KinChatHub.ts";
import { KinChatRepository, type WriteAudience } from "../chat/KinChatRepository.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import { freezeMovedCard, workerChat } from "./ChatSharing.ts";
import * as Writer from "../memory/MemoryWriter.ts";
import { remoteTaskCardState } from "../widgets/taskCard.ts";
import * as PublishCard from "../widgets/workerPublishCard.ts";
import { KinEventQueue } from "./KinEventQueue.ts";
import { KinLeadRegistry } from "./KinLeadRegistry.ts";
import * as KinLevels from "./KinLevels.ts";
import { isOrgPaused, STOP_REASON } from "./orgState.ts";
import { OWNER_DECLINED, parseReport, WAITING_FOR_OWNER } from "./workerBrief.ts";
import * as WorkerEnvironment from "./workerEnvironment.ts";
import * as Publish from "./workerPublish.ts";
import { releaseHosts, takeBlocked } from "./workNetwork.ts";
import { localThreadId, workThreadPrefix } from "./workThread.ts";
import { KinRecords, type Withdrawal } from "../work/KinRecords.ts";
import * as Attempts from "../work/workerAttempts.ts";
import { workerEnded } from "../work/workerEntries.ts";

export const endedStatuses = new Set<OrchestrationV2RunStatus>([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);
const stoppedStatuses = new Set<OrchestrationV2RunStatus>(["interrupted", "cancelled"]);
export { WITHDRAWN_REASON } from "../work/workerAttempts.ts";
/** What a lead hears when its launch lost to a stop: the row ends stopped and nothing ran. */
export const STOPPED_BEFORE_START =
  "This work was stopped before it started, so nothing started. Don't start it again unless the owner asks.";

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
/** A local worker's whole run, its commands included; past it, Kin stops it unpublished. */
export const LOCAL_TASK_LIMIT_MS = 3_600_000;
const TASK_LIMIT_REASON = "The worker ran past its one-hour limit.";
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
/** What a publish came to, as the follower reports it. */
type Publication =
  | { readonly url: string; readonly number: number }
  | { readonly refused: string }
  /** Held for the owner's tap on Kin's card; nothing reached GitHub. */
  | { readonly held: "owner"; readonly sha: string }
  | { readonly held: "declined" };
/** Kin's PR replaces any the worker claims; a refusal becomes an open question for the lead. */
const withPublication = (report: WorkerReport, published: Publication | undefined): WorkerReport =>
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
      : "held" in published
        ? {
            // No PR exists, whatever the worker claims.
            ...report,
            evidence: report.evidence.filter((item) => item.kind !== "pr"),
            openQuestions: [
              ...report.openQuestions,
              published.held === "owner" ? WAITING_FOR_OWNER : OWNER_DECLINED,
            ],
          }
        : { ...report, openQuestions: [...report.openQuestions, published.refused] };
/** Kin's record of refused hosts replaces any the worker claims; the lead asks the owner. */
const withBlockedHosts = (report: WorkerReport, hosts: ReadonlyArray<string>): WorkerReport => {
  const { blockedHosts: _claimed, ...rest } = report;
  return hosts.length === 0
    ? rest
    : {
        ...rest,
        blockedHosts: [...hosts],
        openQuestions: [
          ...rest.openQuestions,
          `Its commands were refused network access to ${hosts.join(", ")}. Ask the owner whether workers may reach ${hosts.length === 1 ? "it" : "them"}; the owner adds hosts in Kin's settings.`,
        ],
      };
};
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
  readonly audience: WriteAudience;
};
const decodeWorker = Schema.decodeUnknownEffect(WorkerRow);
const isChatError = Schema.is(KinChatError);
const isMcpFailure = Schema.is(OrchestratorMcpFailure);
const STOP_FAILED = "The worker could not be stopped. Retry or tell the owner.";
const PAUSED_REFUSAL = "Kin is paused; ask the worker for a follow-up after the owner resumes";
const STOPPED_REFUSAL = "the worker was stopped first";
const HELD_REFUSAL = "the owner publishes this from Kin's card";
const stopFailedNotice = (key: string) =>
  `Kin couldn't stop the work on ${key} after you closed it or took it back, so it may still be running. Open its thread to stop it there.`;
const leadStopFailedNotice = (title: string) =>
  `Kin couldn't stop "${title}" when its agent asked, so it may still be running. Open its thread to stop it there.`;
/** What a stop found already on GitHub, from what Kin recorded or checked there; never deleted. */
const publishedBeforeStopNotice = (
  what: string,
  branch: string,
  left: { readonly url: string } | { readonly pushedTo: string },
) =>
  "url" in left
    ? `Kin stopped the work on ${what}, but it had already published it as ${left.url} from ${branch}. Kin left both as they are; close the pull request on GitHub if you don't want it.`
    : `Kin stopped the work on ${what}, but it had already pushed ${branch} to ${left.pushedTo} on GitHub. Kin opened no pull request and left the branch as it is; delete it on GitHub if you don't want it.`;
const uncheckedNotice = (what: string, branch: string, repo: string) =>
  `Kin stopped the work on ${what} while it was publishing, so it may have pushed ${branch} to ${repo} or opened a pull request from it. Kin couldn't reach GitHub to check; it keeps checking and tells you what it finds.`;
const checkedNothingNotice = (what: string, branch: string) =>
  `Kin checked GitHub: the work on ${what} pushed nothing to ${branch} and opened no pull request.`;
const divergedNotice = (title: string, branch: string, repo: string) =>
  `Kin didn't push "${title}": ${branch} on ${repo} has commits the worker's branch doesn't, and Kin never force-pushes. Kin left the branch on GitHub as it is.`;
const repoName = (worker: { readonly repositoryKey: string | null }) =>
  worker.repositoryKey?.replace(/^github\.com\//i, "") ?? "GitHub";
const attemptOf = (worker: {
  readonly orgId: KinOrgId;
  readonly workerId: KinWorkerId;
  readonly startedAt: number;
}): Attempts.Attempt => ({
  orgId: worker.orgId,
  workerId: worker.workerId,
  startedAt: worker.startedAt,
});
const isRefused = Schema.is(Publish.KinWorkerPublishRefused);
const decodeAuthor = Schema.decodeUnknownEffect(KinAuthor);
const decodePublishCard = Schema.decodeUnknownOption(KinWorkerPublishCard);
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
    /**
     * Stops one of this lead's workers: the stop is stored on the attempt first, so nothing of it
     * publishes after this, in this process or the next; then its run is interrupted. One
     * already ended is a quiet success.
     */
    readonly stop: (input: {
      readonly orgId: KinOrgId;
      readonly agentId: KinAgentId;
      readonly workerId: KinWorkerId;
      readonly reason: string;
      /** The stop's command id there and here, so a retry is the same stop. */
      readonly key: string;
      /** The attempt to stop; a newer one is left alone. Without it, the current attempt. */
      readonly startedAt?: number;
    }) => Effect.Effect<{ readonly stopped: boolean }, KinChatError | OrchestratorMcpFailure>;
    /**
     * Runs a worker's launch unless a stored stop of that attempt came first; then nothing
     * launches, the row ends stopped, and this is `None`. A stop stored during the launch reaches
     * the thread it made as soon as it returns. `launch` binds the row to the thread first.
     */
    readonly launch: <A, E>(
      attempt: {
        readonly orgId: KinOrgId;
        readonly workerId: KinWorkerId;
        readonly startedAt: number;
      },
      launch: Effect.Effect<A, E>,
    ) => Effect.Effect<Option.Option<A>, E | KinChatError | OrchestratorMcpFailure>;
    readonly start: Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/kin/lead/WorkerTracker") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const orchestrator = yield* OrchestratorV2;
  const events = yield* OrchestrationEventStore;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const queue = yield* KinEventQueue;
  const records = yield* KinRecords;
  const chat = yield* KinChatService;
  const registry = yield* KinLeadRegistry;
  const env = yield* WorkerEnvironment.KinWorkerEnvironment;
  const writer = yield* Effect.serviceOption(Writer.MemoryWriter);
  const publisher = yield* Effect.serviceOption(Publish.KinWorkerPublish);
  const repo = yield* KinChatRepository;
  const hub = yield* KinChatHub;
  const environment = yield* Effect.serviceOption(ServerEnvironment);
  const projects = yield* ProjectService.ProjectService;
  const { stateDir } = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  // Followers live as long as this service, so shutting down stops them.
  const followers = yield* Scope.Scope;
  const bootedAt = yield* Clock.currentTimeMillis;
  const inSql = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provideService(SqlClient.SqlClient, sql));
  /** The attempt's stop as stored, which is the whole truth about it in any process. */
  const stopOf = Effect.fn("WorkerTracker.stopOf")(function* (worker: Attempts.Attempt) {
    const row = yield* inSql(Attempts.attemptOf(attemptOf(worker)));
    return Attempts.isStopped(row) ? row : undefined;
  });
  const stopRequested = (worker: Attempts.Attempt) =>
    stopOf(worker).pipe(Effect.map((stop) => stop !== undefined));

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
    const audience = route?.audience ?? "owner";
    return route?.moved === undefined
      ? { ...worker, moved: undefined, audience }
      : {
          audience,
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
        audience: worker.audience,
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
  const card = <A, E>(
    worker: WorkerRow,
    effect: (chatId: KinChatId, audience: WriteAudience) => Effect.Effect<A, E>,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const current = yield* workerRow(worker.orgId, worker.workerId);
          if (current === undefined || current.chatId === null) return;
          yield* movedCard(current, current.chatId);
          yield* effect(current.chatId, current.audience);
        }),
      )
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Kin worker task card unavailable", { cause }),
        ),
      );
  /**
   * Records the outcome unless a follow-up started newer work meanwhile; false when it did. A
   * completed run of a stopped attempt is recorded stopped, decided in the same transaction as the
   * stop's own row, and then the owner hears what had already reached GitHub.
   */
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
        const status =
          input.status === "completed" && (yield* stopRequested(worker))
            ? ("interrupted" as const)
            : input.status;
        const updated = yield* sql`UPDATE kin_workers SET status = ${status},
          report_json = ${reportJson}, ended_at = ${input.endedAt}
          WHERE org_id = ${worker.orgId} AND worker_id = ${worker.workerId}
            AND started_at = ${worker.startedAt} RETURNING worker_id`;
        if (updated.length === 0) return undefined;
        // Routed from the row as stored now, never the one read before the wait there.
        const current = yield* workerRow(worker.orgId, worker.workerId);
        if (current === undefined) return undefined;
        yield* enqueueReport(current, input.key, input.endedAt, input.report);
        // Its Work entry moves with it; a failure there never loses the report.
        yield* workerEnded({
          orgId: current.orgId,
          workerId: current.workerId,
          kind: current.kind,
          status,
          pullRequest:
            current.pullRequestUrl === null || current.pullRequestNumber === null
              ? null
              : { url: current.pullRequestUrl, number: current.pullRequestNumber },
        }).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.provideService(KinRecords, records),
          Effect.catchCause((cause) =>
            Effect.logWarning("Kin couldn't move a worker's Work entry", { cause }),
          ),
        );
        return status;
      }),
    );
    // Whether or not this run's row was still the attempt's, a stopped attempt owes the owner this.
    if (yield* stopRequested(worker)) yield* settleSoon(attemptOf(worker));
    if (recorded === undefined) return false;
    yield* endPublishCard(attemptOf(worker));
    yield* releaseHosts(stateDir, worker.workerId).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
    );
    if (stoppedStatuses.has(recorded))
      yield* card(worker, (chatId, audience) =>
        chat.setTaskCardClosed({
          orgId: worker.orgId,
          chatId,
          audience,
          threadId: worker.threadId,
          closed: true,
        }),
      );
    return true;
  });

  /** An ended attempt's publish card says how it ended, from its row. Best effort. */
  const endPublishCard = (key: Attempts.Attempt) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const row = yield* inSql(Attempts.attemptOf(key));
          if (row?.readyCardId == null) return;
          const status =
            row.pullRequestUrl !== null
              ? "published"
              : row.stoppedAt !== null
                ? "stopped"
                : row.declinedAt !== null
                  ? "declined"
                  : "failed";
          yield* PublishCard.settlePublishCard(
            key.orgId,
            row.readyCardId,
            status,
            row.pullRequestUrl ?? undefined,
          ).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.provideService(KinChatRepository, repo),
            Effect.provideService(KinChatHub, hub),
          );
        }),
      )
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Kin couldn't settle a worker's publish card", { cause }),
        ),
      );

  /**
   * Settles a write an earlier publish began and never heard back from, against GitHub: what it
   * finds is recorded as this attempt's. A commit stays on this machine, so it only clears.
   */
  const reconcileWrite = Effect.fn("WorkerTracker.reconcileWrite")(function* (
    key: Attempts.Attempt,
    repositoryKey: string | null,
  ) {
    const row = yield* inSql(Attempts.attemptOf(key));
    if (row === undefined || row.intent === null) return;
    const found =
      row.intent === "commit"
        ? { branchSha: null, pullRequest: null }
        : Option.isNone(publisher) || repositoryKey === null
          ? yield* new Publish.KinWorkerPublishRefused({
              reason: "this host has no Kin GitHub App to check GitHub with",
            })
          : yield* publisher.value.inspect({ workerId: key.workerId, repositoryKey });
    yield* inSql(sql.withTransaction(Attempts.recordFound(key, found)));
  });

  /**
   * Kin pushes a finished build worker's branch and opens its draft PR. Each write is admitted in
   * one transaction against the attempt's stop and recorded as it lands, so a stop, a crash or a
   * lost answer leaves a row that says what reached GitHub. A refusal is a sentence for the lead,
   * never words from the worker there.
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
    if (yield* paused) return refused(PAUSED_REFUSAL);
    const key = attemptOf(worker);
    const title = worker.title ?? "Kin worker";
    const fail = (reason: string) => new Publish.KinWorkerPublishRefused({ reason });
    const held = (as: "owner" | "declined") =>
      new Publish.KinWorkerPublishRefused({ reason: HELD_REFUSAL, held: as });
    // The hold commits with its card; only then does the publish stop, refused.
    const begin = (intent: Publish.PublishIntent) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            if (yield* paused) return yield* fail(PAUSED_REFUSAL);
            const admission = yield* inSql(Attempts.beginWrite(key, intent, title));
            if (admission._tag === "held")
              // Its own savepoint: a card Kin can't write leaves the hold, never a publish.
              yield* sql
                .withTransaction(
                  PublishCard.writePublishCard({
                    attempt: key,
                    row: admission.row,
                    reasons: admission.reasons,
                    previousCardId: admission.previousCardId,
                    repository: repoName(worker),
                    branch,
                  }).pipe(
                    Effect.provideService(SqlClient.SqlClient, sql),
                    Effect.provideService(KinChatRepository, repo),
                    Effect.provideService(KinChatHub, hub),
                  ),
                )
                .pipe(
                  Effect.catchCause((cause) =>
                    Effect.logError("Kin couldn't show the owner a publish card", { cause }),
                  ),
                );
            return admission._tag;
          }),
        )
        .pipe(
          Effect.mapError((error) =>
            isRefused(error) ? error : fail("Kin couldn't record what it was about to write"),
          ),
          Effect.flatMap((admitted) =>
            admitted === "admitted"
              ? Effect.void
              : Effect.fail(
                  admitted === "refused"
                    ? fail(STOPPED_REFUSAL)
                    : held(admitted === "held" ? "owner" : "declined"),
                ),
          ),
        );
    const review = (facts: Publish.PublishReview) =>
      inSql(
        sql.withTransaction(
          Attempts.recordReview(key, {
            sha: facts.sha,
            visibility: facts.visibility,
            filesJson: JSON.stringify({ files: facts.files, moreFiles: facts.moreFiles }),
          }),
        ),
      ).pipe(Effect.mapError(() => fail("Kin couldn't record what it was about to publish")));
    const done = (outcome: Publish.PublishOutcome) =>
      inSql(sql.withTransaction(Attempts.recordOutcome(key, outcome))).pipe(
        Effect.mapError(() => fail("Kin couldn't record what it wrote")),
      );
    // A write an earlier process began and never heard back from is checked before any other.
    const earlier = yield* reconcileWrite(key, worker.repositoryKey).pipe(Effect.result);
    if (earlier._tag === "Failure")
      return refused("Kin couldn't reach GitHub to check what an earlier publish left");
    const pull = yield* publisher.value
      .publish({
        workerId: worker.workerId,
        repositoryKey: worker.repositoryKey,
        worktreePath,
        ...(local === undefined ? {} : { local }),
        title,
        progress: { review, begin, done },
      })
      .pipe(Effect.result);
    if (pull._tag === "Success") return { url: pull.success.url, number: pull.success.number };
    if (pull.failure.held === "declined") return { held: "declined" } as const;
    if (pull.failure.held === "owner") {
      const row = yield* inSql(Attempts.attemptOf(key));
      if (row?.readySha != null) return { held: "owner", sha: row.readySha } as const;
    }
    yield* Effect.logWarning("Kin didn't publish a worker's branch", {
      workerId: worker.workerId,
      reason: pull.failure.reason,
    });
    // A write whose answer was lost may have landed: GitHub says, not the failure.
    yield* reconcileWrite(key, worker.repositoryKey).pipe(Effect.ignoreCause({ log: true }));
    const row = yield* inSql(Attempts.attemptOf(key));
    if (row?.pullRequestUrl != null && row.pullRequestNumber !== null)
      return { url: row.pullRequestUrl, number: row.pullRequestNumber };
    if (pull.failure.diverged === true)
      yield* ownerNotice(worker, {
        messageId: `kin-publish-diverged:${worker.workerId}:${worker.startedAt}`,
        body: divergedNotice(worker.title ?? "Worker", branch, repoName(worker)),
      });
    // What the lead hears reached GitHub is what the row shows, never what the failure implies.
    if (row?.pushedSha != null)
      return {
        refused: `Kin pushed ${branch} but opened no pull request: ${pull.failure.reason}.`,
      };
    if (row?.intent === "push" || row?.intent === "pull_request")
      return {
        refused: `Kin may have pushed ${branch} and couldn't check GitHub: ${pull.failure.reason}.`,
      };
    return refused(pull.failure.reason);
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

  /** Interrupts the attempt's run with its stop; undefined while it has no thread to stop yet. */
  const interruptThere = Effect.fn("WorkerTracker.interruptThere")(function* (
    worker: WorkerRow,
    stop: Attempts.Stop,
  ) {
    if (isLocal(worker)) {
      // T3's own interrupt, as the owner's Stop on the thread: no process is killed here.
      const shell = yield* orchestrator.getThreadShell(worker.threadId);
      if (shell === null) return undefined;
      return (
        (yield* threads.interruptThread({
          projectId: shell.projectId,
          threadId: worker.threadId,
          commandId: CommandId.make(stop.stopKey),
          reason: stop.stopReason,
        })).type === "interrupt_requested"
      );
    }
    if (worker.environmentId === null || !isBound(worker)) return undefined;
    return (
      (yield* WorkerEnvironment.stopThere(env, {
        environmentId: worker.environmentId,
        threadId: worker.threadId,
        key: stop.stopKey,
        reason: stop.stopReason,
      })).status === "interrupt_requested"
    );
  });
  /**
   * Sends a stored stop to its thread and records that it went. A failure is recorded too, and
   * with `tell` the owner hears it once; without, it reaches the caller.
   */
  const deliver = Effect.fn("WorkerTracker.deliver")(function* (
    worker: WorkerRow,
    stop: Attempts.Stop,
    tell: boolean,
  ) {
    const key = attemptOf(worker);
    const sent = yield* interruptThere(worker, stop).pipe(Effect.result);
    if (sent._tag === "Success") {
      if (sent.success === undefined) return "no thread" as const;
      yield* inSql(Attempts.stopSent(key, "sent")).pipe(Effect.ignoreCause({ log: true }));
      return sent.success;
    }
    const first = yield* inSql(Attempts.stopSent(key, "failed")).pipe(
      Effect.orElseSucceed(() => true),
    );
    if (!tell) return yield* sent.failure;
    if (first) yield* stopFailed(worker, stop, sent.failure);
    return "failed" as const;
  });
  /**
   * Workers whose stop this process is sending now, so a follower leaves it to its sender. A
   * cache only: a restart starts empty, and a stop still pending in its row is sent then.
   */
  const delivering = new Set<KinWorkerId>();
  const sending = <A, E, R>(workerId: KinWorkerId, effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => delivering.add(workerId)),
      () => effect,
      () => Effect.sync(() => void delivering.delete(workerId)),
    );
  /** Sends this attempt's stop once, when the stop itself couldn't: no thread yet, or a restart. */
  const reach = Effect.fn("WorkerTracker.reach")(function* (worker: WorkerRow, follower = false) {
    if (follower && delivering.has(worker.workerId)) return;
    const stop = yield* stopOf(worker);
    if (stop === undefined || stop.stopState !== "pending") return;
    yield* deliver(worker, stop, true);
  });
  /** No thread, and none will start now that the stop came first: the attempt ends stopped. */
  const stoppedBeforeStart = Effect.fn("WorkerTracker.stoppedBeforeStart")(function* (
    worker: WorkerRow,
  ) {
    const here =
      worker.environmentId ??
      (Option.isSome(environment)
        ? yield* environment.value.getEnvironmentId
        : EnvironmentId.make("local"));
    return yield* record(worker, {
      key: `worker-stopped:${worker.workerId}:${worker.startedAt}`,
      status: "interrupted",
      endedAt: yield* Clock.currentTimeMillis,
      report: blocked(worker, here, "Kin stopped this worker before it started."),
    });
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
    yield* reach(worker, true);
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
      yield* card(worker, (chatId, audience) =>
        chat
          .setTaskCardState({ orgId, chatId, audience, threadId: worker.threadId, state })
          .pipe(Effect.tap(() => Effect.sync(() => void (shown.card = state)))),
      );
    if (waited.timedOut) return false;
    if (waited.runId === null) {
      if (yield* stopRequested(worker)) return yield* stoppedBeforeStart(worker);
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
    const ended = endedStatuses.has(answer.status) ? answer.status : "failed";
    // A run that finished after Kin stopped its worker counts as stopped, so it isn't published.
    const status = ended === "completed" && (yield* stopRequested(worker)) ? "interrupted" : ended;
    const reply =
      status === "completed"
        ? yield* WorkerEnvironment.lastReply(env, environmentId, worker.threadId, answer.runId)
        : undefined;
    const completedAt = read.recentRuns.find((run) => run.runId === answer.runId)?.completedAt;
    const report =
      (reply === undefined ? undefined : parseReport(reply)) ??
      blocked(worker, environmentId, `Worker ended ${status} without a report.`);
    const published: Publication | undefined =
      status === "completed" && worker.kind === "build"
        ? yield* publish(worker, read.thread.worktreePath)
        : undefined;
    if (published !== undefined && "url" in published)
      yield* card(worker, (chatId, audience) =>
        chat.setTaskCardState({
          orgId,
          chatId,
          audience,
          threadId: worker.threadId,
          state: withPublished(state, {
            pullRequestUrl: published.url,
            pullRequestNumber: published.number,
          }),
        }),
      );
    return yield* settleRun(worker, {
      runId: answer.runId,
      status,
      endedAt:
        completedAt == null
          ? yield* Clock.currentTimeMillis
          : DateTime.toEpochMillis(DateTime.makeUnsafe(completedAt)),
      report,
      published,
    });
  });

  /**
   * A finished run's outcome: recorded and reported, unless Kin holds its commit for the owner.
   * Then the lead hears that now and the attempt stays open; the owner's tap or a stop ends it.
   */
  const settleRun = Effect.fn("WorkerTracker.settleRun")(function* (
    worker: WorkerRow,
    input: {
      readonly runId: string;
      readonly status: OrchestrationV2RunStatus;
      readonly endedAt: number;
      readonly report: WorkerReport;
      readonly published: Publication | undefined;
    },
  ) {
    const report = withPublication(input.report, input.published);
    if (input.published !== undefined && "held" in input.published) {
      if (input.published.held === "owner") {
        const key = `worker-held:${input.runId}:${input.published.sha}`;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const current = yield* workerRow(worker.orgId, worker.workerId);
            if (current === undefined || current.startedAt !== worker.startedAt) return;
            yield* enqueueReport(current, key, input.endedAt, report);
          }),
        );
        return true;
      }
      // Not published, by the owner's choice: the attempt ends as an interrupted one does.
      return yield* record(worker, {
        key: `worker-report:${input.runId}`,
        status: "interrupted",
        endedAt: input.endedAt,
        report,
      });
    }
    return yield* record(worker, {
      key: `worker-report:${input.runId}`,
      status: input.status,
      endedAt: input.endedAt,
      report,
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
    if (shell === null)
      return yield* (yield* stopRequested(worker))
        ? stoppedBeforeStart(worker)
        : abandoned("The worker's thread never started.");
    // The project the row was started in, never one the thread was moved to since.
    if (worker.projectId === null || shell.projectId !== worker.projectId)
      return yield* abandoned("The worker's thread is no longer in its project.");
    yield* reach(worker, true);
    const left = worker.startedAt + LOCAL_TASK_LIMIT_MS - (yield* Clock.currentTimeMillis);
    if (left <= 0 && !(yield* stopRequested(worker)))
      yield* stop({
        orgId: worker.orgId,
        agentId: worker.agentId,
        workerId: worker.workerId,
        reason: TASK_LIMIT_REASON,
        key: `kin-work-limit:${worker.workerId}:${worker.startedAt}`,
        startedAt: worker.startedAt,
      }).pipe(Effect.ignoreCause({ log: true }));
    const waited = yield* threads.waitForThread({
      projectId: worker.projectId,
      threadId: worker.threadId,
      timeoutMs: left <= 0 ? LOCAL_WAIT_MS : Math.min(LOCAL_WAIT_MS, left),
    });
    if (waited.timedOut) return false;
    if (waited.run === null) return yield* abandoned("The worker's thread never started a run.");
    if (!endedStatuses.has(waited.run.status)) return false;
    const projection = yield* threads.getThreadProjection(worker.threadId);
    // Someone wrote in the thread since: that newer run's end reports instead.
    if (projection.runs.at(-1)?.id !== waited.run.id) return false;
    const run = waited.run;
    const status =
      run.status === "completed" && (yield* stopRequested(worker)) ? "interrupted" : run.status;
    const reply = projection.messages
      .findLast((message) => message.role === "assistant" && message.runId === run.id)
      ?.text.slice(-MAX_REPLY_CHARS);
    const report = withBlockedHosts(
      (reply === undefined ? undefined : parseReport(reply)) ??
        blocked(worker, here, `Worker ended ${status} without a report.`),
      yield* takeBlocked(stateDir, worker.workerId).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.orElseSucceed(() => []),
      ),
    );
    const project =
      status === "completed" && worker.kind === "build"
        ? Option.getOrUndefined(yield* projects.getById(worker.projectId))
        : undefined;
    const published: Publication | undefined =
      status !== "completed" || worker.kind !== "build"
        ? undefined
        : project === undefined
          ? {
              refused: `Kin didn't publish ${Publish.publishBranch(worker.workerId)}: the worker's project is gone.`,
            }
          : yield* publish(worker, projection.thread.worktreePath, {
              projectRoot: project.workspaceRoot,
            });
    if (published !== undefined && "url" in published) yield* linkPullRequest(worker, published);
    return yield* settleRun(worker, {
      runId: run.id,
      status,
      endedAt:
        run.completedAt === null
          ? yield* Clock.currentTimeMillis
          : DateTime.toEpochMillis(run.completedAt),
      report,
      published,
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
    yield* card(worker, (chatId, audience) =>
      chat.setTaskCardClosed({ orgId, chatId, audience, threadId: worker.threadId, closed: true }),
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

  /**
   * An owner-only line from Kin in the owner's own chat with the lead, written in the caller's
   * transaction when there is one: a message id names it, so it is posted once.
   */
  const ownerMessage = Effect.fn("WorkerTracker.ownerMessage")(function* (
    worker: { readonly orgId: KinOrgId; readonly agentId: KinAgentId },
    input: { readonly messageId: string; readonly body: string },
  ) {
    const [lead] = yield* sql<{ chatId: KinChatId }>`SELECT owner_chat_id AS "chatId"
      FROM kin_leads WHERE org_id = ${worker.orgId} AND agent_id = ${worker.agentId}
      ORDER BY agent_id`;
    if (lead === undefined) return;
    const message = yield* repo.insertMessage({
      orgId: worker.orgId,
      chatId: lead.chatId,
      audience: "owner",
      messageId: KinMessageId.make(input.messageId),
      author: { _tag: "system" },
      kind: "text",
      body: input.body,
      intent: null,
      mentions: [],
      replyTo: null,
      widgetId: null,
      floorRunId: null,
      status: "posted",
      sentBy: null,
      clientMessageId: null,
      createdAt: DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
      editedAt: null,
    });
    yield* sql.afterCommit(hub.publish({ type: "message.posted", orgId: worker.orgId, message }));
  });
  /** The same, best effort, for a notice a message id alone keeps from repeating. */
  const ownerNotice = (
    worker: { readonly orgId: KinOrgId; readonly agentId: KinAgentId },
    input: { readonly messageId: string; readonly body: string },
  ) =>
    sql
      .withTransaction(ownerMessage(worker, input))
      .pipe(Effect.catchCause((cause) => Effect.logError("Kin's owner notice failed", { cause })));
  /** A notice the attempt's row records as sent, in the same transaction, so a restart never repeats it. */
  const noticeOnce = (
    worker: WorkerRow,
    key: Attempts.Attempt,
    column: "noticed_at" | "unchecked_at",
    input: { readonly messageId: string; readonly body: string },
  ) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis;
        if (yield* inSql(Attempts.claimNotice(key, column, at))) yield* ownerMessage(worker, input);
      }),
    );

  /** Tells the owner, in their own chat with the lead, that stopped work may still run. */
  const stopFailed = Effect.fn("WorkerTracker.stopFailed")(function* (
    worker: WorkerRow,
    stop: Attempts.Stop,
    cause: unknown,
  ) {
    yield* Effect.logError("Kin could not stop a worker", { workerId: worker.workerId, cause });
    yield* ownerNotice(worker, {
      messageId: `kin-stop-failed:${worker.workerId}:${worker.startedAt}`,
      body:
        stop.stopLabel === null
          ? leadStopFailedNotice(worker.title ?? "Worker")
          : stopFailedNotice(stop.stopLabel),
    });
  });

  /**
   * Says once what a stopped attempt left on GitHub, from its row. A write whose answer never came
   * is checked against GitHub first; when GitHub can't be reached the owner hears exactly that,
   * once, and this fails so it is tried again.
   */
  const settle = Effect.fn("WorkerTracker.settle")(function* (key: Attempts.Attempt) {
    const worker = yield* workerRow(key.orgId, key.workerId);
    if (worker === undefined) return;
    const stop = yield* stopOf(key);
    if (stop === undefined || stop.noticedAt !== null) return;
    const what = stop.stopLabel ?? `"${worker.title ?? "Worker"}"`;
    const branch = Publish.publishBranch(key.workerId);
    const id = `${key.workerId}:${key.startedAt}`;
    const checked = yield* reconcileWrite(key, worker.repositoryKey).pipe(Effect.result);
    if (checked._tag === "Failure") {
      yield* noticeOnce(worker, key, "unchecked_at", {
        messageId: `kin-stop-unchecked:${id}`,
        body: uncheckedNotice(what, branch, repoName(worker)),
      });
      return yield* checked.failure;
    }
    const row = yield* stopOf(key);
    if (row === undefined) return;
    const left =
      row.pullRequestUrl !== null
        ? { url: row.pullRequestUrl }
        : row.pushedSha !== null
          ? { pushedTo: repoName(worker) }
          : undefined;
    if (left !== undefined)
      yield* noticeOnce(worker, key, "noticed_at", {
        messageId: `kin-stop-published:${id}`,
        body: publishedBeforeStopNotice(what, branch, left),
      });
    else if (row.uncheckedAt !== null)
      yield* noticeOnce(worker, key, "noticed_at", {
        messageId: `kin-stop-checked:${id}`,
        body: checkedNothingNotice(what, branch),
      });
  });
  /** Settles now, and keeps trying in the background while GitHub can't be reached. */
  const settleSoon = (key: Attempts.Attempt) =>
    settle(key).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Kin couldn't yet say what stopped work left on GitHub", { cause }).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const retry = yield* WorkerTrackerRetry;
              yield* settle(key).pipe(Effect.retry(retry));
            }).pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(followers)),
          ),
          Effect.asVoid,
        ),
      ),
    );

  // Traced as `WorkerTracker.stop`, which wraps it.
  const stopNow = Effect.fnUntraced(function* (
    input: Parameters<WorkerTracker["Service"]["stop"]>[0],
  ) {
    // Stored before anything is interrupted: from here no write of this attempt is admitted.
    const taken = yield* inSql(
      sql.withTransaction(Attempts.stopAttempt({ ...input, at: yield* Clock.currentTimeMillis })),
    );
    if (taken._tag === "missing")
      return yield* new KinChatError({ reason: "not_found", message: "Kin record not found." });
    if (taken._tag === "ended") return { stopped: false };
    const worker = yield* workerRow(input.orgId, input.workerId);
    if (worker === undefined || worker.startedAt !== taken.startedAt) return { stopped: false };
    const sent = yield* deliver(worker, taken.row, false);
    // A local launch that never made its thread ends stopped; one making it now is reached
    // when it returns. An unconfirmed launch there is stopped once its follower finds the thread.
    const stopped =
      sent === "no thread" ? isLocal(worker) && (yield* stoppedBeforeStart(worker)) : sent === true;
    yield* track(input.orgId, input.workerId);
    return { stopped };
  });

  const stop: WorkerTracker["Service"]["stop"] = Effect.fn("WorkerTracker.stop")(
    function* (input) {
      return yield* sending(input.workerId, stopNow(input));
    },
    Effect.tapError((error) =>
      isChatError(error) || isMcpFailure(error)
        ? Effect.void
        : Effect.logError("Kin could not stop a worker", { error }),
    ),
    Effect.mapError((error) =>
      isChatError(error) || isMcpFailure(error)
        ? error
        : new KinChatError({ reason: "unavailable", message: STOP_FAILED }),
    ),
  );

  const launch: WorkerTracker["Service"]["launch"] = Effect.fn("WorkerTracker.launch")(function* <
    A,
    E,
  >(
    attempt: {
      readonly orgId: KinOrgId;
      readonly workerId: KinWorkerId;
      readonly startedAt: number;
    },
    run: Effect.Effect<A, E>,
  ) {
    const admitted = yield* Effect.gen(function* () {
      const worker = yield* workerRow(attempt.orgId, attempt.workerId);
      if (
        worker === undefined ||
        worker.startedAt !== attempt.startedAt ||
        endedStatuses.has(worker.status as OrchestrationV2RunStatus)
      )
        return undefined;
      if (!(yield* stopRequested(worker))) return true;
      yield* stoppedBeforeStart(worker);
      return undefined;
    }).pipe(
      Effect.tapError((cause) =>
        Effect.logError("Kin couldn't admit a worker's launch", { cause }),
      ),
      Effect.mapError(() => new KinChatError({ reason: "unavailable", message: STOP_FAILED })),
    );
    if (admitted === undefined) return Option.none();
    const result = yield* run;
    // A stop stored while the launch ran found no thread; it reaches the one the launch made.
    yield* Effect.gen(function* () {
      const worker = yield* workerRow(attempt.orgId, attempt.workerId);
      if (worker !== undefined && worker.startedAt === attempt.startedAt) yield* reach(worker);
    }).pipe(Effect.ignoreCause({ log: true }));
    return Option.some(result);
  });

  /** Sends a stop already stored for this attempt, while it is still the worker's open one. */
  const sendStored = Effect.fn("WorkerTracker.sendStored")(
    function* (key: Attempts.Attempt) {
      const worker = yield* workerRow(key.orgId, key.workerId);
      if (worker === undefined || worker.startedAt !== key.startedAt) return;
      const stop = yield* stopOf(worker);
      if (stop === undefined) return;
      const sent = yield* sending(worker.workerId, deliver(worker, stop, true));
      if (sent === "no thread" && isLocal(worker)) yield* stoppedBeforeStart(worker);
    },
    Effect.catchCause((cause) => Effect.logError("Kin could not send a stop", { cause })),
  );

  /**
   * After the owner's change commits, with its stops already stored: they reach the attempts that
   * were open on the entry. One that can't tells the owner; a restart finds any still pending.
   */
  const withdrawn = Effect.fn("WorkerTracker.withdrawn")(function* (withdrawal: Withdrawal) {
    for (const { workerId, startedAt } of withdrawal.workers) {
      yield* sendStored({ orgId: withdrawal.orgId, workerId, startedAt });
      yield* track(withdrawal.orgId, workerId);
    }
  });
  yield* records.attachWithdrawals(withdrawn);

  // The owner's tap on a publish card: the attempt's follower publishes, or ends it unpublished.
  // The decision is on the attempt's row, so a restart's followers find it even if this missed it.
  const decisions = yield* hub.subscribeAll.pipe(Effect.provideService(Scope.Scope, followers));
  yield* Stream.runForEach(decisions, (event) => {
    if (event.type !== "widget.updated" || event.widget.type !== KIN_WORKER_PUBLISH_CARD)
      return Effect.void;
    const card = decodePublishCard(event.widget.state);
    return Option.isSome(card) &&
      (card.value.status === "publishing" || card.value.status === "declined")
      ? track(event.orgId, card.value.workerId).pipe(Effect.asVoid)
      : Effect.void;
  }).pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(followers));

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
      reason: "Kin agents start workers only through kin_delegate.",
    });
    if (Option.isSome(writer))
      yield* writer.value.appendJournal(lead.orgId, lead.wakeupId, [
        "Did: Kin stopped a delegate_task the agent started; workers start only through kin_delegate.",
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
    // Stops stored before a restart and never sent go now, before any follower runs.
    for (const key of yield* inSql(Attempts.pendingStops()).pipe(Effect.retry(retry)))
      yield* sendStored(key);
    // Stopped attempts that died before saying what reached GitHub say it now.
    for (const key of yield* inSql(Attempts.unsettledStops()).pipe(Effect.retry(retry)))
      yield* settleSoon(key);
    for (const row of yield* openWorkers.pipe(Effect.retry(retry)))
      yield* track(KinOrgId.make(row.orgId), KinWorkerId.make(row.workerId));
  }).pipe(
    Effect.catchCause((cause) => Effect.logError("Kin worker tracker unavailable", { cause })),
  );

  return WorkerTracker.of({ process, track, stop, launch, start });
});

export const layer = Layer.effect(WorkerTracker, make);
