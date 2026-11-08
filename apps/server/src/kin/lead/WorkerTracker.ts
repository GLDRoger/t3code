import {
  CommandId,
  KinAgentId,
  KinAuthor,
  KinChatId,
  KinEventId,
  KinOrgId,
  KinWorkerId,
  ThreadId,
  isProviderNativeSubagentThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type WorkerReport,
} from "@t3tools/contracts";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import { isSqlError } from "effect/sql/SqlError";
import * as Stream from "effect/Stream";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationEventStore } from "../../persistence/OrchestrationEventStore.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import * as Writer from "../memory/MemoryWriter.ts";
import { KinBudget } from "./KinBudget.ts";
import { KinEventQueue } from "./KinEventQueue.ts";
import { KinLeadRegistry } from "./KinLeadRegistry.ts";
import { parseReport } from "./workerBrief.ts";

const consumer = "worker-tracker";
const ended = new Set<OrchestrationV2Run["status"]>([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);
const stoppedStatuses = new Set<OrchestrationV2Run["status"]>(["interrupted", "cancelled"]);
// Claude folds native subagent usage into the parent turn's otherUsage; Codex bills each native thread.
const separatelyBilledNativeDrivers = new Set<string>(["codex"]);
const maxEventAttempts = 8;
const maxLineageDepth = 32;

/** Retry policy for the tracker's start and each event; tests swap in a zero-delay schedule. */
export const WorkerTrackerRetry = Context.Reference<Schedule.Schedule<unknown, unknown>>(
  "t3/kin/lead/WorkerTracker/WorkerTrackerRetry",
  {
    defaultValue: () =>
      Schedule.min([Schedule.exponential("1 second"), Schedule.spaced("30 seconds")]),
  },
);
const toMillis = (value: DateTime.Utc | null) =>
  value === null ? undefined : DateTime.toEpochMillis(value);
const endedAtMillis = (run: OrchestrationV2Run) =>
  toMillis(run.completedAt) ?? toMillis(run.startedAt) ?? DateTime.toEpochMillis(run.requestedAt);
const WorkerRow = Schema.Struct({
  orgId: KinOrgId,
  workerId: KinWorkerId,
  agentId: KinAgentId,
  threadId: ThreadId,
  chatId: Schema.NullOr(KinChatId),
});
const decodeWorker = Schema.decodeUnknownEffect(WorkerRow);
const decodeAuthor = Schema.decodeUnknownEffect(KinAuthor);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export class WorkerTrackerEventError extends Schema.TaggedError<WorkerTrackerEventError>()(
  "WorkerTrackerEventError",
  { sequence: Schema.Number, cause: Schema.Defect() },
) {}

export class WorkerTracker extends Context.Service<
  WorkerTracker,
  {
    /** Handles one stored event; replays are idempotent (charges and reports key on the run). */
    readonly process: (
      stored: OrchestrationV2StoredEvent,
    ) => Effect.Effect<boolean, WorkerTrackerEventError>;
    readonly start: Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/kin/lead/WorkerTracker") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const orchestrator = yield* OrchestratorV2;
  const events = yield* OrchestrationEventStore;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const budget = yield* KinBudget;
  const queue = yield* KinEventQueue;
  const chat = yield* KinChatService;
  const registry = yield* KinLeadRegistry;
  const environment = yield* ServerEnvironment;
  const writer = yield* Effect.serviceOption(Writer.MemoryWriter);

  const bootedAt = yield* Clock.currentTimeMillis;

  const orgIds = Effect.fn("WorkerTracker.orgIds")(function* () {
    const rows = yield* sql<{
      orgId: string;
    }>`SELECT org_id AS "orgId" FROM kin_leads GROUP BY org_id ORDER BY org_id`;
    return rows.map((row) => KinOrgId.make(row.orgId));
  });
  const advance = Effect.fn("WorkerTracker.advance")(function* (sequence: number) {
    const orgs = yield* orgIds();
    if (orgs.length === 0) return;
    yield* sql`UPDATE kin_cursor SET after_sequence = ${sequence}
      WHERE consumer = ${consumer} AND org_id IN ${sql.in(orgs)} AND after_sequence < ${sequence}`;
  });

  const author = Effect.fn("WorkerTracker.author")(function* (worker: typeof WorkerRow.Type) {
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

  const workerFor = Effect.fn("WorkerTracker.workerFor")(function* (threadId: ThreadId) {
    const [raw] = yield* sql`SELECT w.org_id AS "orgId", w.worker_id AS "workerId",
      w.agent_id AS "agentId", w.thread_id AS "threadId", w.chat_id AS "chatId"
      FROM kin_workers w JOIN kin_leads l ON l.org_id = w.org_id AND l.agent_id = w.agent_id
      WHERE w.thread_id = ${threadId} ORDER BY w.worker_id`;
    return raw === undefined ? undefined : yield* decodeWorker(raw);
  });
  // Separately billed native children run their turns on their own thread with no run attempt; the
  // run's time window picks them out, and run windows on one thread never overlap.
  const nativeChildTurns = Effect.fn("WorkerTracker.nativeChildTurns")(function* (
    projection: OrchestrationV2ThreadProjection,
    run: OrchestrationV2Run,
  ) {
    const from = toMillis(run.startedAt) ?? DateTime.toEpochMillis(run.requestedAt);
    const until = toMillis(run.completedAt) ?? Number.POSITIVE_INFINITY;
    const turns: Array<OrchestrationV2ProviderTurn> = [];
    const seen = new Set<ThreadId>();
    const pending = [projection];
    for (let parent = pending.pop(); parent !== undefined; parent = pending.pop()) {
      for (const subagent of parent.subagents) {
        const childId = subagent.childThreadId;
        if (
          subagent.origin !== "provider_native" ||
          !separatelyBilledNativeDrivers.has(subagent.driver) ||
          childId === null ||
          seen.has(childId)
        )
          continue;
        seen.add(childId);
        // A child that cannot load must not cost the worker its report; charges only grow later.
        const child = yield* threads.getThreadProjection(childId).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("Kin worker native child usage unavailable", { childId, cause }),
          ),
          Effect.orElseSucceed(() => undefined),
        );
        if (child === undefined) continue;
        for (const turn of child.providerTurns) {
          const at = toMillis(turn.startedAt) ?? toMillis(turn.completedAt);
          if (turn.runAttemptId === null && at !== undefined && at >= from && at < until)
            turns.push(turn);
        }
        pending.push(child);
      }
    }
    return turns;
  });
  /** Charges are keyed on the run and only grow, so a replay never bills twice. */
  const charge = Effect.fn("WorkerTracker.charge")(function* (
    worker: typeof WorkerRow.Type,
    projection: OrchestrationV2ThreadProjection,
    run: OrchestrationV2Run,
  ) {
    const attempts = new Set(
      projection.attempts.filter((item) => item.runId === run.id).map((item) => item.id),
    );
    const own = projection.providerTurns.filter(
      (turn) => turn.runAttemptId !== null && attempts.has(turn.runAttemptId),
    );
    yield* budget.chargeWorker({
      orgId: worker.orgId,
      workerId: worker.workerId,
      runId: run.id,
      usage: [...own, ...(yield* nativeChildTurns(projection, run))].map((turn) => ({
        providerTurnId: turn.id,
        ...(turn.turnTokenUsage === undefined ? {} : { turnTokenUsage: turn.turnTokenUsage }),
        ...(turn.tokenUsage === undefined ? {} : { tokenUsage: turn.tokenUsage }),
        usedTokens: turn.tokenUsage?.usedTokens,
      })),
    });
  });
  // Every field comes from stored state, so a replay enqueues byte-identical JSON.
  const enqueueReport = Effect.fn("WorkerTracker.enqueueReport")(function* (
    worker: typeof WorkerRow.Type,
    run: OrchestrationV2Run,
    report: WorkerReport,
    kind: "worker-report" | "worker-abandoned" = "worker-report",
  ) {
    const eventId = KinEventId.make(`${kind}:${run.id}`);
    yield* queue
      .enqueue({
        _tag: "worker.report",
        orgId: worker.orgId,
        eventId,
        agentId: worker.agentId,
        receivedAt: DateTime.makeUnsafe(endedAtMillis(run)),
        dedupeKey: eventId,
        provenance: yield* author(worker),
        workerId: worker.workerId,
        report,
      })
      .pipe(
        Effect.catchTags({
          // The id is keyed on the answer run, so a conflict is this run's own report replayed with
          // drifted provenance; the abandon report uses its own id and never collides with it.
          KinEventQueueConflict: (error) =>
            error.eventId === eventId ? Effect.void : Effect.fail(error),
          KinEventQueueRetiredAgent: () => Effect.void,
          KinEventQueueUnknownAgent: () => Effect.void,
        }),
      );
  });
  const blocked = Effect.fn("WorkerTracker.blocked")(function* (
    worker: typeof WorkerRow.Type,
    summary: string,
  ) {
    const link = formatThreadLink({
      environmentId: yield* environment.getEnvironmentId,
      threadId: worker.threadId,
    });
    return {
      result: "blocked",
      summary,
      evidence: [{ kind: "link", ref: link }],
      openQuestions: [],
      memorySuggestions: [],
      misleadingMemory: [],
      parsed: false,
    } satisfies WorkerReport;
  });
  // Cards are best effort, so a worker without one has nothing to close.
  const closeCard = (input: {
    readonly orgId: KinOrgId;
    readonly chatId: KinChatId;
    readonly threadId: ThreadId;
  }) =>
    chat.setTaskCardClosed({ ...input, closed: true }).pipe(
      Effect.catchTags({
        KinChatError: (error) => (error.reason === "not_found" ? Effect.void : Effect.fail(error)),
      }),
    );
  // A worker's delegate_task descendants bill to it; provider-native children bill with their parent
  // run. Only subagent links count: a fork is someone else's work, even though it keeps rootThreadId.
  const childRunEnded = Effect.fn("WorkerTracker.childRunEnded")(function* (
    run: OrchestrationV2Run,
  ) {
    let shell: OrchestrationV2ThreadShell | null = yield* threads.getThreadShell(run.threadId);
    if (shell === null || isProviderNativeSubagentThread(shell)) return undefined;
    for (let depth = 0; depth < maxLineageDepth; depth += 1) {
      const parentId: ThreadId | null = shell.lineage.parentThreadId;
      if (shell.lineage.relationshipToParent !== "subagent" || parentId === null) return undefined;
      const owner = yield* workerFor(parentId);
      if (owner !== undefined) {
        yield* charge(owner, yield* threads.getThreadProjection(run.threadId), run);
        return owner.orgId;
      }
      shell = yield* threads.getThreadShell(parentId);
      if (shell === null) return undefined;
    }
    yield* Effect.logWarning("Kin worker lineage deeper than the cap; run not charged", {
      runId: run.id,
    });
    return undefined;
  });

  /** Returns the organization whose worker the run belonged to, if any. */
  const runEnded = Effect.fn("WorkerTracker.runEnded")(function* (run: OrchestrationV2Run) {
    if (!ended.has(run.status)) return undefined;
    const worker = yield* workerFor(run.threadId);
    if (worker === undefined) return yield* childRunEnded(run);
    const projection = yield* threads.getThreadProjection(worker.threadId);
    yield* charge(worker, projection, run);
    // A restart or usage-limit continuation carries the work on; its own end reports.
    if (
      projection.runs.some(
        (item) =>
          item.restartContinuationOfRunId === run.id ||
          item.usageLimitContinuationOfRunId === run.id,
      )
    )
      return worker.orgId;
    const settled = yield* threads.waitForThread({
      projectId: projection.thread.projectId,
      threadId: worker.threadId,
      runId: run.id,
      timeoutMs: 0,
      untilDelegatedWorkSettled: true,
    });
    // The worker's own children will wake it again; that later run reports.
    if (settled.timedOut) return worker.orgId;
    // The report keys on the answer run: a re-emitted parent run settles to the same answer.
    const answer = settled.resultRun ?? run;
    const reply = projection.messages.findLast(
      (message) =>
        message.role === "assistant" && message.runId === answer.id && !message.streaming,
    );
    const report =
      (answer.status === "completed" && reply !== undefined
        ? parseReport(reply.text)
        : undefined) ?? (yield* blocked(worker, `Worker ended ${answer.status} without a report.`));
    yield* sql`UPDATE kin_workers SET status = ${answer.status}, report_json = ${yield* encodeJson(report)},
      ended_at = ${endedAtMillis(answer)} WHERE org_id = ${worker.orgId} AND worker_id = ${worker.workerId}`;
    yield* enqueueReport(worker, answer, report);
    if (stoppedStatuses.has(answer.status) && worker.chatId !== null)
      yield* closeCard({ orgId: worker.orgId, chatId: worker.chatId, threadId: worker.threadId });
    return worker.orgId;
  });

  // After the last attempt the worker must not stay open with no report and a live card.
  const abandon = Effect.fn("WorkerTracker.abandon")(
    function* (stored: OrchestrationV2StoredEvent, cause: Cause.Cause<unknown>) {
      yield* Effect.logError("Kin worker tracker gave up on an event", {
        sequence: stored.sequence,
        attempts: maxEventAttempts,
        cause,
      });
      const { event } = stored;
      if (event.type !== "run.updated" || !ended.has(event.payload.status)) return false;
      const run = event.payload;
      const worker = yield* workerFor(run.threadId).pipe(Effect.orElseSucceed(() => undefined));
      if (worker === undefined) return false;
      // A later or still-running run owns the worker's outcome; don't fail it over an old event.
      const runs = yield* threads.getThreadProjection(worker.threadId).pipe(
        Effect.map((projection) => projection.runs),
        Effect.orElseSucceed(() => undefined),
      );
      if (
        runs !== undefined &&
        (runs.at(-1)?.id !== run.id || runs.some((item) => !ended.has(item.status)))
      )
        return true;
      const report = yield* blocked(worker, "Kin's tracker could not process the run.");
      const closed = yield* sql`UPDATE kin_workers SET status = 'failed',
      report_json = ${yield* encodeJson(report)}, ended_at = ${endedAtMillis(run)}
      WHERE org_id = ${worker.orgId} AND worker_id = ${worker.workerId}
        AND status NOT IN ${sql.in([...ended])} RETURNING worker_id`;
      if (closed.length === 0) return true;
      yield* enqueueReport(worker, run, report, "worker-abandoned").pipe(Effect.ignore);
      if (worker.chatId !== null)
        yield* closeCard({
          orgId: worker.orgId,
          chatId: worker.chatId,
          threadId: worker.threadId,
        }).pipe(Effect.ignore);
      return true;
    },
    Effect.orElseSucceed(() => true),
  );

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

  /** True when the event touched a worker, so the follower should persist its position. */
  const process = Effect.fn("WorkerTracker.process")(
    function* (stored: OrchestrationV2StoredEvent) {
      const { event } = stored;
      if (event.type === "run.updated") return (yield* runEnded(event.payload)) !== undefined;
      if (event.type === "subagent.updated") yield* strayDelegation(event.payload);
      return false;
    },
    (effect, stored) =>
      effect.pipe(
        Effect.mapError(
          (error) =>
            new WorkerTrackerEventError({
              sequence: stored.sequence,
              cause: isSqlError(error)
                ? toPersistenceSqlError("WorkerTracker.process")(error)
                : error,
            }),
        ),
      ),
  );

  // Every step is idempotent, so each event retries on a fresh schedule and a stream failure
  // resubscribes after the last handled event. An event that keeps failing is abandoned.
  const follow = Effect.fnUntraced(function* (
    eventType: "run.updated" | "subagent.updated",
    from: number,
  ) {
    const retry = yield* WorkerTrackerRetry;
    let after = from;
    const step = (stored: OrchestrationV2StoredEvent) =>
      process(stored).pipe(
        Effect.retry({ schedule: retry, times: maxEventAttempts - 1 }),
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) => abandon(stored, cause),
        ),
        Effect.flatMap((touched) => (touched ? advance(stored.sequence) : Effect.void)),
        Effect.tap(() =>
          Effect.sync(() => {
            after = Math.max(after, stored.sequence);
          }),
        ),
      );
    return yield* Effect.suspend(() =>
      orchestrator
        .streamStoredEventsFrom({ eventType, afterSequence: after })
        .pipe(Stream.runForEach(step)),
    ).pipe(
      Effect.tapCause((cause) =>
        Effect.logWarning("Kin worker tracker stream failed; resuming", {
          eventType,
          after,
          cause,
        }),
      ),
      Effect.retry(retry),
      Effect.forkScoped,
    );
  });

  // A crash between the insert and the launch leaves a queued row with no thread. Rows from this
  // process are skipped: their launch may still be in flight.
  const recoverQueued = Effect.fn("WorkerTracker.recoverQueued")(function* (orgId: KinOrgId) {
    const rows = yield* sql<{
      workerId: string;
      threadId: string;
      chatId: string | null;
    }>`SELECT worker_id AS "workerId", thread_id AS "threadId", chat_id AS "chatId" FROM kin_workers
      WHERE org_id = ${orgId} AND status = 'queued' AND started_at < ${bootedAt} ORDER BY worker_id`;
    for (const row of rows) {
      const threadId = ThreadId.make(row.threadId);
      if ((yield* threads.getThreadShell(threadId)) !== null) continue;
      yield* sql`UPDATE kin_workers SET status = 'failed', ended_at = ${yield* Clock.currentTimeMillis}
        WHERE org_id = ${orgId} AND worker_id = ${row.workerId} AND status = 'queued'`;
      if (row.chatId !== null)
        yield* closeCard({ orgId, chatId: KinChatId.make(row.chatId), threadId });
    }
  });

  const begin = Effect.gen(function* () {
    const latest = yield* events.latestAgentSequence();
    const orgs = yield* orgIds();
    for (const orgId of orgs) {
      yield* sql`INSERT INTO kin_cursor (org_id, consumer, after_sequence)
        VALUES (${orgId}, ${consumer}, ${latest}) ON CONFLICT DO NOTHING RETURNING org_id`;
      yield* recoverQueued(orgId);
      // With no unreported worker there is nothing to replay for this organization.
      const open = yield* sql`SELECT 1 FROM kin_workers WHERE org_id = ${orgId}
        AND status NOT IN ${sql.in([...ended])} ORDER BY worker_id LIMIT 1`;
      if (open.length === 0)
        yield* sql`UPDATE kin_cursor SET after_sequence = ${latest}
          WHERE org_id = ${orgId} AND consumer = ${consumer} AND after_sequence < ${latest}`;
    }
    const [row] =
      orgs.length === 0
        ? []
        : yield* sql<{ after: number | null }>`SELECT MIN(after_sequence) AS after FROM kin_cursor
            WHERE consumer = ${consumer} AND org_id IN ${sql.in(orgs)} ORDER BY 1`;
    return { runs: row?.after ?? latest, latest };
  }).pipe(
    Effect.tapCause((cause) =>
      Effect.logWarning("Kin worker tracker could not start; retrying", { cause }),
    ),
  );
  const start = Effect.gen(function* () {
    const { runs, latest } = yield* begin.pipe(Effect.retry(yield* WorkerTrackerRetry));
    yield* follow("run.updated", runs);
    yield* follow("subagent.updated", latest);
  }).pipe(
    Effect.catchCause((cause) => Effect.logError("Kin worker tracker unavailable", { cause })),
  );

  return WorkerTracker.of({ process, start });
});

export const layer = Layer.effect(WorkerTracker, make);
