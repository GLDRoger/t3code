import {
  CommandId,
  KinAgentId,
  KinAuthor,
  KinChatId,
  KinEventId,
  KinOrgId,
  KinWorkerId,
  ThreadId,
  type OrchestrationV2Run,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2Subagent,
  type WorkerReport,
} from "@t3tools/contracts";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
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
import * as Stream from "effect/Stream";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import * as Writer from "../memory/MemoryWriter.ts";
import { KinBudget } from "./KinBudget.ts";
import { KinEventQueue } from "./KinEventQueue.ts";
import { KinLeadRegistry } from "./KinLeadRegistry.ts";
import { parseReport } from "./Workers.ts";

const consumer = "worker-tracker";
const ended = new Set<OrchestrationV2Run["status"]>([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);
const stoppedStatuses = new Set<OrchestrationV2Run["status"]>(["interrupted", "cancelled"]);
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

export class WorkerTracker extends Context.Service<
  WorkerTracker,
  {
    /** Handles one stored event; replays are idempotent (charges and reports key on the run). */
    readonly process: (stored: OrchestrationV2StoredEvent) => Effect.Effect<void>;
    readonly start: Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/kin/lead/WorkerTracker") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const orchestrator = yield* OrchestratorV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const budget = yield* KinBudget;
  const queue = yield* KinEventQueue;
  const chat = yield* KinChatService;
  const registry = yield* KinLeadRegistry;
  const environment = yield* ServerEnvironment;
  const writer = yield* Effect.serviceOption(Writer.MemoryWriter);

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

  const runEnded = Effect.fn("WorkerTracker.runEnded")(function* (run: OrchestrationV2Run) {
    if (!ended.has(run.status)) return;
    const [raw] = yield* sql`SELECT w.org_id AS "orgId", w.worker_id AS "workerId",
      w.agent_id AS "agentId", w.thread_id AS "threadId", w.chat_id AS "chatId"
      FROM kin_workers w JOIN kin_leads l ON l.org_id = w.org_id AND l.agent_id = w.agent_id
      WHERE w.thread_id = ${run.threadId} ORDER BY w.worker_id`;
    if (raw === undefined) return;
    const worker = yield* decodeWorker(raw);
    const projection = yield* threads.getThreadProjection(worker.threadId);
    const attempts = new Set(
      projection.attempts.filter((item) => item.runId === run.id).map((item) => item.id),
    );
    yield* budget.chargeWorker({
      orgId: worker.orgId,
      workerId: worker.workerId,
      runId: run.id,
      usage: projection.providerTurns
        .filter((turn) => turn.runAttemptId !== null && attempts.has(turn.runAttemptId))
        .map((turn) => ({
          providerTurnId: turn.id,
          ...(turn.turnTokenUsage === undefined ? {} : { turnTokenUsage: turn.turnTokenUsage }),
          ...(turn.tokenUsage === undefined ? {} : { tokenUsage: turn.tokenUsage }),
          usedTokens: turn.tokenUsage?.usedTokens,
        })),
    });
    // A restart or usage-limit continuation carries the work on; its own end reports.
    if (
      projection.runs.some(
        (item) =>
          item.restartContinuationOfRunId === run.id ||
          item.usageLimitContinuationOfRunId === run.id,
      )
    )
      return;
    const settled = yield* threads.waitForThread({
      projectId: projection.thread.projectId,
      threadId: worker.threadId,
      runId: run.id,
      timeoutMs: 0,
      untilDelegatedWorkSettled: true,
    });
    // The worker's own children will wake it again; that later run reports.
    if (settled.timedOut) return;
    const reply = projection.messages.findLast(
      (message) => message.role === "assistant" && message.runId === run.id && !message.streaming,
    );
    const link = formatThreadLink({
      environmentId: yield* environment.getEnvironmentId,
      threadId: worker.threadId,
    });
    const report: WorkerReport = (run.status === "completed" && reply !== undefined
      ? parseReport(reply.text)
      : undefined) ?? {
      result: "blocked",
      summary: `Worker ended ${run.status} without a report.`,
      evidence: [{ kind: "link", ref: link }],
      openQuestions: [],
      memorySuggestions: [],
      misleadingMemory: [],
      parsed: false,
    };
    const now = yield* Clock.currentTimeMillis;
    const endedAt = run.completedAt === null ? now : DateTime.toEpochMillis(run.completedAt);
    yield* sql`UPDATE kin_workers SET status = ${run.status}, report_json = ${yield* encodeJson(report)},
      ended_at = ${endedAt} WHERE org_id = ${worker.orgId} AND worker_id = ${worker.workerId}`;
    const eventId = KinEventId.make(`worker-report:${run.id}`);
    yield* queue
      .enqueue({
        _tag: "worker.report",
        orgId: worker.orgId,
        eventId,
        agentId: worker.agentId,
        receivedAt: DateTime.makeUnsafe(now),
        dedupeKey: eventId,
        provenance: yield* author(worker),
        workerId: worker.workerId,
        report,
      })
      .pipe(
        Effect.catchTags({
          KinEventQueueRetiredAgent: () => Effect.void,
          KinEventQueueUnknownAgent: () => Effect.void,
        }),
      );
    if (stoppedStatuses.has(run.status) && worker.chatId !== null)
      yield* chat.setTaskCardClosed({
        orgId: worker.orgId,
        chatId: worker.chatId,
        threadId: worker.threadId,
        closed: true,
      });
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

  const process = Effect.fn("WorkerTracker.process")(
    function* (stored: OrchestrationV2StoredEvent) {
      const { event } = stored;
      if (event.type === "run.updated") {
        yield* runEnded(event.payload);
        yield* advance(stored.sequence);
      } else if (event.type === "subagent.updated") yield* strayDelegation(event.payload);
    },
    Effect.catchCause((cause) => Effect.logError("Kin worker tracker event failed", { cause })),
  );

  // Same high-water query as the event store; orchestration does not expose its sink to Kin.
  const latestSequence = sql<{ sequence: number | null }>`SELECT MAX(sequence) AS sequence
    FROM orchestration_events INDEXED BY idx_orchestration_events_application_sequence
    WHERE application_event_version = 2 AND aggregate_kind = 'thread'`.pipe(
    Effect.map((rows) => rows[0]?.sequence ?? 0),
  );
  // The orchestrator's stored-event stream is bounded and may drop a slow subscriber, so each
  // follower resumes after the last event it processed; replays are idempotent.
  const follow = (eventType: "run.updated" | "subagent.updated", from: number) => {
    let after = from;
    return Effect.suspend(() =>
      orchestrator.streamStoredEventsFrom({ eventType, afterSequence: after }).pipe(
        Stream.runForEach((stored) =>
          process(stored).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                after = Math.max(after, stored.sequence);
              }),
            ),
          ),
        ),
      ),
    ).pipe(
      Effect.tapCause((cause) => Effect.logWarning("Kin worker tracker stream ended", { cause })),
      Effect.retry(Schedule.spaced("5 seconds")),
      Effect.forkScoped,
    );
  };
  const start = Effect.gen(function* () {
    const latest = yield* latestSequence;
    const orgs = yield* orgIds();
    for (const orgId of orgs) {
      yield* sql`INSERT INTO kin_cursor (org_id, consumer, after_sequence)
        VALUES (${orgId}, ${consumer}, ${latest}) ON CONFLICT DO NOTHING RETURNING org_id`;
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
    yield* follow("run.updated", row?.after ?? latest);
    yield* follow("subagent.updated", latest);
  }).pipe(
    Effect.catchCause((cause) => Effect.logError("Kin worker tracker unavailable", { cause })),
  );

  return WorkerTracker.of({ process, start });
});

export const layer = Layer.effect(WorkerTracker, make);
