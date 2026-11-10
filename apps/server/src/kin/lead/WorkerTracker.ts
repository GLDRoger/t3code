import {
  CommandId,
  EnvironmentId,
  KinAgentId,
  KinAuthor,
  KinChatId,
  KinEventId,
  KinOrgId,
  KinWorkerId,
  type OrchestratorMcpFailure,
  type OrchestrationV2RunStatus,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2Subagent,
  ThreadId,
  type WorkerReport,
} from "@t3tools/contracts";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
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
import { KinChatService } from "../chat/KinChatService.ts";
import * as Writer from "../memory/MemoryWriter.ts";
import { remoteTaskCardState } from "../widgets/taskCard.ts";
import { KinEventQueue } from "./KinEventQueue.ts";
import { KinLeadRegistry } from "./KinLeadRegistry.ts";
import { parseReport } from "./workerBrief.ts";
import * as WorkerEnvironment from "./workerEnvironment.ts";

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
const WorkerRow = Schema.Struct({
  orgId: KinOrgId,
  workerId: KinWorkerId,
  agentId: KinAgentId,
  threadId: ThreadId,
  chatId: Schema.NullOr(KinChatId),
  environmentId: Schema.NullOr(EnvironmentId),
  status: Schema.String,
  startedAt: Schema.Number,
});
type WorkerRow = typeof WorkerRow.Type;
const decodeWorker = Schema.decodeUnknownEffect(WorkerRow);
const decodeAuthor = Schema.decodeUnknownEffect(KinAuthor);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

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
  // Followers live as long as this service, so shutting down stops them.
  const followers = yield* Scope.Scope;
  const bootedAt = yield* Clock.currentTimeMillis;

  const workerRow = Effect.fn("WorkerTracker.workerRow")(function* (
    orgId: KinOrgId,
    workerId: KinWorkerId,
  ) {
    const [raw] = yield* sql`SELECT org_id AS "orgId", worker_id AS "workerId",
      agent_id AS "agentId", thread_id AS "threadId", chat_id AS "chatId",
      environment_id AS "environmentId", status, started_at AS "startedAt"
      FROM kin_workers WHERE org_id = ${orgId} AND worker_id = ${workerId} ORDER BY worker_id`;
    return raw === undefined ? undefined : yield* decodeWorker(raw);
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
  /** Keyed on the answer run, so a replay enqueues the same event; `key` names it. */
  const enqueueReport = Effect.fn("WorkerTracker.enqueueReport")(function* (
    worker: WorkerRow,
    key: string,
    endedAt: number,
    report: WorkerReport,
  ) {
    const eventId = KinEventId.make(key);
    yield* queue
      .enqueue({
        _tag: "worker.report",
        orgId: worker.orgId,
        eventId,
        agentId: worker.agentId,
        receivedAt: DateTime.makeUnsafe(endedAt),
        dedupeKey: eventId,
        provenance: yield* author(worker),
        workerId: worker.workerId,
        report,
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
  // Cards are best effort: a worker's outcome never waits on its card.
  const card = <A, E>(worker: WorkerRow, effect: (chatId: KinChatId) => Effect.Effect<A, E>) =>
    worker.chatId === null
      ? Effect.void
      : effect(worker.chatId).pipe(
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
    const updated = yield* sql`UPDATE kin_workers SET status = ${input.status},
      report_json = ${yield* encodeJson(input.report)}, ended_at = ${input.endedAt}
      WHERE org_id = ${worker.orgId} AND worker_id = ${worker.workerId}
        AND started_at = ${worker.startedAt} RETURNING worker_id`;
    if (updated.length === 0) return false;
    yield* enqueueReport(worker, input.key, input.endedAt, input.report);
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

  /** One wait on the worker's thread there; true once its latest run is reported. */
  const followOnce = Effect.fn("WorkerTracker.followOnce")(function* (
    orgId: KinOrgId,
    workerId: KinWorkerId,
  ) {
    const worker = yield* workerRow(orgId, workerId);
    if (worker === undefined || worker.environmentId === null) return true;
    if (endedStatuses.has(worker.status as OrchestrationV2RunStatus)) return true;
    const environmentId = worker.environmentId;
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
    yield* card(worker, (chatId) =>
      chat.setTaskCardState({
        orgId,
        chatId,
        threadId: worker.threadId,
        state: remoteTaskCardState(read.thread),
      }),
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
    return yield* record(worker, {
      key: `worker-report:${answer.runId}`,
      status,
      endedAt:
        completedAt == null
          ? yield* Clock.currentTimeMillis
          : DateTime.toEpochMillis(DateTime.makeUnsafe(completedAt)),
      report:
        (reply === undefined ? undefined : parseReport(reply)) ??
        blocked(worker, environmentId, `Worker ended ${status} without a report.`),
    });
  });

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
        `Kin can no longer reach this worker: ${error.message}`.slice(0, 800),
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
    yield* followOnce(orgId, workerId).pipe(
      Effect.repeat({ while: (done) => !done }),
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

  // A crash between the insert and the launch there leaves a queued row bound to nothing. Rows
  // from this process are skipped: their launch may still be in flight.
  const recoverUnbound = Effect.fn("WorkerTracker.recoverUnbound")(function* () {
    const rows = yield* sql<{
      orgId: string;
      workerId: string;
      threadId: string;
      chatId: string | null;
    }>`SELECT org_id AS "orgId", worker_id AS "workerId", thread_id AS "threadId", chat_id AS "chatId"
      FROM kin_workers WHERE org_id IN (SELECT org_id FROM kin_leads GROUP BY org_id)
        AND status = 'queued' AND environment_id IS NULL AND started_at < ${bootedAt}
      ORDER BY org_id, worker_id`;
    for (const row of rows) {
      const orgId = KinOrgId.make(row.orgId);
      yield* sql`UPDATE kin_workers SET status = 'failed', ended_at = ${yield* Clock.currentTimeMillis}
        WHERE org_id = ${orgId} AND worker_id = ${row.workerId} AND status = 'queued'`;
      if (row.chatId !== null)
        yield* chat
          .setTaskCardClosed({
            orgId,
            chatId: KinChatId.make(row.chatId),
            threadId: ThreadId.make(row.threadId),
            closed: true,
          })
          .pipe(Effect.catchTags({ KinChatError: () => Effect.void }));
    }
  });
  const openWorkers = sql<{ orgId: string; workerId: string }>`
    SELECT org_id AS "orgId", worker_id AS "workerId" FROM kin_workers
    WHERE org_id IN (SELECT org_id FROM kin_leads GROUP BY org_id)
      AND environment_id IS NOT NULL AND status NOT IN ${sql.in([...endedStatuses])}
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
    yield* recoverUnbound().pipe(Effect.retry(retry));
    for (const row of yield* openWorkers.pipe(Effect.retry(retry)))
      yield* track(KinOrgId.make(row.orgId), KinWorkerId.make(row.workerId));
  }).pipe(
    Effect.catchCause((cause) => Effect.logError("Kin worker tracker unavailable", { cause })),
  );

  return WorkerTracker.of({ process, track, start });
});

export const layer = Layer.effect(WorkerTracker, make);
