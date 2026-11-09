import {
  CommandId,
  KinAgentId,
  KinLead,
  KinMessageId,
  KinOrgId,
  KinWakeupId,
  MessageId,
  ModelSelection,
  ProjectId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import { isSqlError } from "effect/sql/SqlError";

import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as KinIdentity from "../chat/KinIdentity.ts";
import * as Floor from "../floor/KinFloor.ts";
import * as Writer from "../memory/MemoryWriter.ts";
import * as Memory from "../memory/Memory.ts";
import * as Routines from "../triggers/routines.ts";
import * as OwnerCheck from "../triggers/ownerCheck.ts";
import * as KinEventQueue from "./KinEventQueue.ts";
import * as KinBudget from "./KinBudget.ts";
import * as KinLeadRegistry from "./KinLeadRegistry.ts";
import { KinLeadPrompt } from "./LeadPrompt.ts";
import { nonClaudeLeadModel } from "./leadModels.ts";
import * as RoutineContent from "./RoutineContent.ts";
import { PAUSE_POLL_INTERVAL_MS } from "./KinStop.ts";
import { isOrgPaused } from "./orgState.ts";
import { KinPromotion } from "../levels/Promotion.ts";
import { KinReplyBridge } from "../reply/KinReplyBridge.ts";

/** How long one wake-up may run before it is interrupted. */
const WAKEUP_DEADLINE_MS = 900_000;
/** Each message steered into a running wake-up buys it this long, up to the cap; then they queue. */
const MAX_STEERS = 5;
const STEER_EXTENSION_MS = 300_000;
const WAKEUP_HARD_CAP_MS = 1_800_000;
const deadlineAt = (startedAt: number, steers: number) =>
  startedAt + Math.min(WAKEUP_HARD_CAP_MS, WAKEUP_DEADLINE_MS + steers * STEER_EXTENSION_MS);
const isSteerRun = (wakeupId: KinWakeupId, run: { readonly userMessageId: string }) =>
  KinIdentity.isAdoptedRunMessage(wakeupId, run.userMessageId) &&
  run.userMessageId !== KinIdentity.rescueMessageId(wakeupId);
const ownerCheckDispatcherReady = false;

export class KinWakeupError extends Schema.TaggedError<KinWakeupError>()("KinWakeupError", {
  orgId: KinOrgId,
  agentId: KinAgentId,
  cause: Schema.Defect(),
}) {}

export class KinWakeupHooks extends Context.Service<
  KinWakeupHooks,
  {
    readonly memoryCheckoutInvalid: (error: Memory.MemoryCheckoutInvalid) => Effect.Effect<void>;
  }
>()("t3/kin/lead/WakeupRunner/KinWakeupHooks") {}

export class WakeupRunner extends Context.Service<
  WakeupRunner,
  {
    readonly runOnce: (orgId: KinOrgId, agentId: KinAgentId) => Effect.Effect<void, KinWakeupError>;
    readonly recover: Effect.Effect<void, KinWakeupError>;
    readonly start: Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/kin/lead/WakeupRunner") {}

const runnerCause = (cause: unknown) =>
  isSqlError(cause) ? toPersistenceSqlError("WakeupRunner")(cause) : cause;
const isWakeupError = Schema.is(KinWakeupError);
const LeadRow = Schema.Struct({
  orgId: KinOrgId,
  agentId: KinAgentId,
  name: Schema.String,
  level: KinLead.fields.level,
  threadId: Schema.NullOr(ThreadId),
  models: Schema.fromJsonString(Schema.Struct({ strong: ModelSelection, cheap: ModelSelection })),
  orgName: Schema.String,
  retiredAt: Schema.NullOr(Schema.String),
});
const RunningRow = Schema.Struct({
  orgId: KinOrgId,
  agentId: KinAgentId,
  wakeupId: KinWakeupId,
  threadId: Schema.NullOr(ThreadId),
  runId: Schema.NullOr(RunId),
  startedAt: Schema.Number,
});
const decodeLead = Schema.decodeUnknownEffect(LeadRow);
const decodeRunning = Schema.decodeUnknownEffect(RunningRow);
const ulid = Effect.gen(function* () {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let timestamp = yield* Clock.currentTimeMillis;
  let value = "";
  for (let i = 0; i < 10; i++) {
    value = alphabet.charAt(timestamp % 32) + value;
    timestamp = Math.floor(timestamp / 32);
  }
  for (let i = 0; i < 16; i++) value += alphabet.charAt(yield* Random.nextIntBetween(0, 31));
  return value;
});

const make = Effect.gen(function* () {
  const ownerCheck = yield* Effect.serviceOption(OwnerCheck.OwnerCheck);
  const promotion = yield* Effect.serviceOption(KinPromotion);
  const bridge = yield* Effect.serviceOption(KinReplyBridge);
  const endReply = (row: { readonly orgId: KinOrgId; readonly wakeupId: KinWakeupId }) =>
    Option.isSome(bridge) ? bridge.value.end(row.orgId, row.wakeupId) : Effect.void;
  const finishWakeup = Effect.fn("WakeupRunner.finishWakeup")(function* (
    row: typeof RunningRow.Type,
    status: "completed" | "failed" | "timed_out",
  ) {
    const finished = yield* queue.finish({ orgId: row.orgId, wakeupId: row.wakeupId, status });
    // Something visible already happened, so a silent retry could repeat it; say so instead.
    if (finished.stranded > 0 && Option.isSome(bridge)) yield* bridge.value.partway(row);
  });
  const routineContent = yield* Effect.serviceOption(RoutineContent.KinRoutineContent);
  const sql = yield* SqlClient.SqlClient;
  const queue = yield* KinEventQueue.KinEventQueue;
  const budget = yield* KinBudget.KinBudget;
  const memory = yield* Memory.Memory;
  const writer = yield* Effect.serviceOption(Writer.MemoryWriter);
  const hooks = yield* Effect.serviceOption(KinWakeupHooks);
  const prompt = yield* KinLeadPrompt;
  const identity = yield* KinIdentity.KinIdentity;
  const floor = yield* Floor.KinFloor;
  const registry = yield* KinLeadRegistry.KinLeadRegistry;
  const projects = yield* ProjectService.ProjectService;
  const launch = yield* ThreadLaunchService.ThreadLaunchService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const settings = yield* ServerSettingsService;
  const paused = (orgId: KinOrgId) =>
    isOrgPaused(orgId).pipe(Effect.provideService(SqlClient.SqlClient, sql));
  const threadActivity = Effect.fn("WakeupRunner.threadActivity")(function* (orgId: KinOrgId) {
    const rows = yield* sql<{
      threadId: string;
    }>`SELECT thread_id AS "threadId" FROM kin_leads WHERE org_id = ${orgId} AND thread_id IS NOT NULL ORDER BY thread_id`;
    const leadThreads = new Set(rows.map((row) => row.threadId));
    return yield* threads.streamDomainEvents.pipe(
      Stream.filter(
        (event) =>
          leadThreads.has(event.threadId) &&
          (event.type === "run.updated" ||
            (event.type === "provider-turn.updated" && event.payload.completedAt !== null)),
      ),
      Stream.runHead,
    );
  });

  const lead = Effect.fn("WakeupRunner.lead")(function* (orgId: KinOrgId, agentId: KinAgentId) {
    const [row] = yield* sql`SELECT l.org_id AS "orgId", l.agent_id AS "agentId", l.name,
      l.level, l.thread_id AS "threadId", l.models_json AS models, o.name AS "orgName", a.retired_at AS "retiredAt"
      FROM kin_leads l JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
      JOIN kin_orgs o ON o.org_id = l.org_id WHERE l.org_id = ${orgId} AND l.agent_id = ${agentId}`;
    return yield* decodeLead(row);
  });
  const retired = new Set<KinAgentId>();
  const retire = Effect.fn("WakeupRunner.retire")(function* (record: typeof LeadRow.Type) {
    if (retired.has(record.agentId)) return;
    yield* queue.expireAgent(record.orgId, record.agentId);
    if (record.threadId !== null) {
      const stopped = yield* threads.forceStopThread({ threadId: record.threadId });
      if (stopped.outcome === "releasing") return;
      yield* identity.endAgentThread({ orgId: record.orgId, threadId: record.threadId });
    }
    retired.add(record.agentId);
  });
  const capture = Effect.fn("WakeupRunner.capture")(function* (row: typeof RunningRow.Type) {
    if (row.threadId === null || row.runId === null) return;
    const projection = yield* threads.getThreadProjection(row.threadId);
    const runIds = new Set([row.runId]);
    for (const run of projection.runs.toSorted((a, b) => a.ordinal - b.ordinal)) {
      if (
        KinIdentity.isAdoptedRunMessage(row.wakeupId, run.userMessageId) ||
        (run.restartContinuationOfRunId !== undefined &&
          runIds.has(run.restartContinuationOfRunId)) ||
        (run.usageLimitContinuationOfRunId !== undefined &&
          runIds.has(run.usageLimitContinuationOfRunId))
      )
        runIds.add(run.id);
    }
    const attempts = new Set(
      projection.attempts
        .filter((attempt) => runIds.has(attempt.runId))
        .map((attempt) => attempt.id),
    );
    const turns = projection.providerTurns.filter(
      (turn) => turn.runAttemptId !== null && attempts.has(turn.runAttemptId),
    );
    const usage = turns.map((turn) => ({
      providerTurnId: turn.id,
      ...(turn.turnTokenUsage === undefined ? {} : { turnTokenUsage: turn.turnTokenUsage }),
      ...(turn.tokenUsage === undefined ? {} : { tokenUsage: turn.tokenUsage }),
      usedTokens: turn.tokenUsage?.usedTokens,
    }));
    yield* budget.charge({ orgId: row.orgId, wakeupId: row.wakeupId, usage });
  });
  const wait = Effect.fn("WakeupRunner.wait")(
    function* (row: typeof RunningRow.Type, projectId: ProjectId) {
      if (row.threadId === null || row.runId === null) return;
      const threadId = row.threadId;
      const runId = row.runId;
      const { orgId, agentId, wakeupId } = row;
      // Recovery resumes the count from the thread, so steer ids and the deadline stay stable.
      const steering = {
        open: true,
        steers: (yield* threads.getThreadProjection(threadId)).messages.filter((message) =>
          isSteerRun(wakeupId, { userMessageId: message.id }),
        ).length,
        lock: yield* Semaphore.make(1),
      };
      const deadline = () => deadlineAt(row.startedAt, steering.steers);
      const steer = Effect.fn("WakeupRunner.steer")(function* () {
        if (!steering.open || steering.steers >= MAX_STEERS) return;
        let events = yield* queue.steer({ orgId, agentId, wakeupId });
        for (const priority of new Set(events.map((event) => event.priority))) {
          const admission = yield* budget.admit(orgId, priority);
          if (admission.allowed) continue;
          yield* queue.release({
            orgId,
            wakeupId,
            eventIds: events.filter((event) => event.priority === priority).map((e) => e.eventId),
            notBefore: admission.nextReset,
            countAttempt: false,
            budgetDeferred: true,
          });
          events = events.filter((event) => event.priority !== priority);
        }
        if (events.length === 0) return;
        steering.steers++;
        const n = steering.steers;
        const messageId = MessageId.make(KinIdentity.steerMessageId(wakeupId, n));
        const deliver = Effect.gen(function* () {
          const text = yield* prompt.steer({ orgId, agentId, events });
          const claimed = yield* sql<{ messageId: string }>`
            SELECT json_extract(json, '$.messageId') AS "messageId" FROM kin_events
            WHERE org_id = ${orgId} AND wakeup_id = ${wakeupId} AND state = 'claimed'
              AND tag IN ('chat.message', 'widget.action', 'chat.reaction') ORDER BY event_id`;
          yield* floor.renew({
            orgId,
            agentId,
            until: deadline(),
            messageIds: claimed.map((event) => KinMessageId.make(event.messageId)),
          });
          if (Option.isSome(bridge)) yield* bridge.value.steered(orgId, wakeupId);
          const send = (mode: "steer" | "queue") =>
            threads.sendToThread({
              commandId: CommandId.make(`kin-steer:${wakeupId}:${n}:${mode}`),
              projectId,
              threadId,
              messageId,
              text,
              attachments: [],
              mode,
              createdBy: "system",
              creationSource: "server",
            });
          // Past its turn, the steer starts a run this wake-up adopts.
          yield* send("steer").pipe(
            Effect.catchTags({ ThreadManagementNoSteerableRunError: () => send("queue") }),
          );
        });
        // A steer that may have landed is never re-sent; one that did not goes back to the queue.
        yield* deliver.pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              const landed = (yield* threads.getThreadProjection(threadId)).messages.some(
                (message) => message.id === messageId,
              );
              if (landed) return;
              steering.steers--;
              yield* Effect.logWarning("Kin steer failed; its messages wait", {
                orgId,
                wakeupId,
                errorTag: error._tag,
              });
              yield* queue.release({
                orgId,
                wakeupId,
                eventIds: events.map((event) => event.eventId),
                notBefore: yield* Clock.currentTimeMillis,
                countAttempt: false,
              });
            }),
          ),
        );
      });
      const steerer = yield* Effect.gen(function* () {
        while (true) {
          const changed = yield* queue.changes(orgId);
          yield* steering.lock.withPermits(1)(
            steer().pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Kin steer failed", { orgId, wakeupId, cause }),
              ),
            ),
          );
          yield* changed;
        }
      }).pipe(Effect.forkChild);
      let current = runId;
      let result: Effect.Success<ReturnType<typeof threads.waitForThread>>;
      while (true) {
        result = yield* threads.waitForThread({
          projectId,
          threadId,
          runId: current,
          timeoutMs: Math.max(0, deadline() - (yield* Clock.currentTimeMillis)),
        });
        if (result.timedOut && (yield* Clock.currentTimeMillis) < deadline()) continue;
        // Under the steer lock, so no steer lands once the wake-up stops waiting.
        const next = yield* steering.lock.withPermits(1)(
          Effect.gen(function* () {
            const projection = yield* threads.getThreadProjection(threadId);
            const after = projection.runs.find((run) => run.id === current)?.ordinal ?? 0;
            const adopted = result.timedOut
              ? undefined
              : projection.runs
                  .filter(
                    (run) =>
                      run.ordinal > after &&
                      isSteerRun(wakeupId, run) &&
                      (run.status === "queued" || ThreadManagementService.isActiveRun(run)),
                  )
                  .toSorted((a, b) => a.ordinal - b.ordinal)[0];
            if (adopted === undefined) steering.open = false;
            return adopted;
          }),
        );
        if (next === undefined) break;
        current = next.id;
      }
      yield* Fiber.interrupt(steerer);
      const status = result.timedOut
        ? "timed_out"
        : result.run?.status === "completed"
          ? "completed"
          : "failed";
      // The stop switch interrupted this run: hand its events back without spending an attempt.
      const stopped = status === "failed" && (yield* paused(row.orgId));
      yield* Effect.gen(function* () {
        if (result.timedOut) {
          yield* threads.interruptThread({
            projectId,
            threadId,
            runId: result.run?.id ?? current,
            commandId: CommandId.make(`kin-timeout:${row.wakeupId}`),
          });
          const settled = yield* threads.waitForThread({
            projectId,
            threadId,
            runId: current,
            timeoutMs: 30_000,
          });
          if (settled.timedOut)
            yield* Effect.logWarning("Kin timed-out run may continue after interrupt", {
              orgId: row.orgId,
              wakeupId: row.wakeupId,
              runId: current,
            });
        }
        // The reply lands before memory commits, while the wake-up still owns its lane.
        if (Option.isSome(bridge) && !stopped)
          yield* bridge.value.complete({
            orgId: row.orgId,
            wakeupId: row.wakeupId,
            projectId,
            rootRunId: runId,
            rescueUntil: status === "completed" ? deadline() : null,
          });
        if (Option.isSome(writer)) {
          const ended =
            yield* sql`SELECT 1 FROM kin_lead_tool_calls WHERE org_id = ${row.orgId} AND wakeup_id = ${row.wakeupId} AND call_key = 'end'`;
          if (ended.length === 0)
            yield* writer.value.appendJournal(row.orgId, row.wakeupId, [
              Writer.LEAD_ENDED_WITHOUT_KIN_END,
            ]);
          yield* writer.value.commitWakeup(
            row.orgId,
            row.wakeupId,
            status === "completed" ? "completed" : "failed",
          );
        }
        yield* capture(row);
        if (stopped)
          yield* queue.release({
            orgId: row.orgId,
            wakeupId: row.wakeupId,
            countAttempt: false,
            notBefore: (yield* Clock.currentTimeMillis) + PAUSE_POLL_INTERVAL_MS,
          });
        else yield* finishWakeup(row, status);
      }).pipe(
        Effect.onExit((exit) =>
          result.timedOut && Exit.isFailure(exit)
            ? queue
                .finish({ orgId: row.orgId, wakeupId: row.wakeupId, status: "timed_out" })
                .pipe(Effect.ignore)
            : Effect.void,
        ),
      );
      if (status === "completed")
        yield* threads.settleThread({
          threadId: row.threadId,
          commandId: CommandId.make(`kin-settle:${row.wakeupId}`),
          byOwnAgent: true,
        });
    },
    (effect, row) =>
      effect.pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit) && Option.isSome(writer)
            ? writer.value.discard(row.orgId, row.wakeupId).pipe(Effect.ignore)
            : Effect.void,
        ),
        Effect.ensuring(endReply(row)),
      ),
  );
  const clearMissingThread = Effect.fn("WakeupRunner.clearMissingThread")(function* (
    row: typeof RunningRow.Type,
  ) {
    if (row.threadId === null) return;
    const threadId = row.threadId;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const existing =
          yield* sql`SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}`;
        if (existing.length > 0) return;
        const registered =
          yield* sql`SELECT 1 FROM kin_agent_threads WHERE org_id = ${row.orgId} AND agent_id = ${row.agentId} AND thread_id = ${threadId} AND ended_at IS NULL`;
        if (registered.length > 0) yield* identity.endAgentThread({ orgId: row.orgId, threadId });
        yield* sql`UPDATE kin_leads SET thread_id = NULL WHERE org_id = ${row.orgId} AND agent_id = ${row.agentId} AND thread_id = ${threadId}`;
      }),
    );
  });
  const cleanup = Effect.fn("WakeupRunner.cleanup")(function* (
    row: typeof RunningRow.Type,
    interrupted = false,
  ) {
    if (Option.isSome(writer))
      yield* writer.value.discard(row.orgId, row.wakeupId).pipe(Effect.ignore);
    yield* endReply(row);
    const [running] =
      yield* sql`SELECT 1 FROM kin_wakeups WHERE org_id = ${row.orgId} AND wakeup_id = ${row.wakeupId} AND status = 'running'`;
    if (running === undefined) return;
    if (row.threadId !== null) {
      const projection = yield* threads.getThreadProjection(row.threadId).pipe(Effect.option);
      if (Option.isSome(projection))
        yield* threads
          .interruptThread({
            projectId: projection.value.thread.projectId,
            threadId: row.threadId,
            commandId: CommandId.make(`kin-exit:${row.wakeupId}`),
          })
          .pipe(Effect.ignore);
    }
    yield* clearMissingThread(row).pipe(Effect.ignore);
    yield* capture(row).pipe(Effect.ignore);
    if (interrupted) yield* queue.requeueUnfinished(row.orgId, row.wakeupId);
    else yield* finishWakeup(row, "failed");
  });

  const runOnce = Effect.fn("WakeupRunner.runOnce")(
    function* (orgId: KinOrgId, agentId: KinAgentId) {
      const record = yield* lead(orgId, agentId);
      if (record.retiredAt !== null) return yield* retire(record);
      if (yield* paused(orgId)) return;
      if (record.threadId !== null) {
        const unfinished = yield* sql`SELECT 1 FROM orchestration_v2_projection_provider_turns
          WHERE thread_id = ${record.threadId} AND completed_at IS NULL LIMIT 1`;
        const busy = yield* sql`SELECT 1 FROM orchestration_v2_projection_runs
          WHERE thread_id = ${record.threadId}
            AND status IN ${sql.in(["queued", ...ThreadManagementService.ACTIVE_RUN_STATUSES])} LIMIT 1`;
        if (unfinished.length > 0 || busy.length > 0) {
          yield* Effect.raceFirst(yield* queue.changes(orgId), threadActivity(orgId)).pipe(
            Effect.timeoutOrElse({ duration: 60_000, orElse: () => Effect.void }),
          );
          return;
        }
      }
      const wakeupId = KinWakeupId.make(yield* ulid);
      const startedAt = yield* Clock.currentTimeMillis;
      let row: typeof RunningRow.Type = {
        orgId,
        agentId,
        wakeupId,
        threadId: null,
        runId: null,
        startedAt,
      };
      yield* Effect.scoped(
        Effect.gen(function* () {
          let events = yield* Effect.acquireRelease(
            queue.claim({ orgId, agentId, wakeupId, model: record.models.strong.model }),
            (_, exit) =>
              cleanup(row, Exit.hasInterrupts(exit)).pipe(
                Effect.catch((error) =>
                  Effect.logError("Kin wake-up finalizer failed", {
                    orgId,
                    wakeupId,
                    errorTag: error._tag,
                  }),
                ),
              ),
          );
          row = { ...row, startedAt: yield* Clock.currentTimeMillis };
          yield* Effect.gen(function* () {
            if (yield* paused(orgId)) {
              yield* queue.release({
                orgId,
                wakeupId,
                countAttempt: false,
                notBefore: (yield* Clock.currentTimeMillis) + PAUSE_POLL_INTERVAL_MS,
              });
              return;
            }
            const current = yield* lead(orgId, agentId);
            if (current.retiredAt !== null) {
              yield* queue.finish({ orgId, wakeupId, status: "failed" });
              return yield* retire(current);
            }
            // Provisioning refuses these too; a row written another way still never launches.
            const notClaude = nonClaudeLeadModel(yield* settings.getSettings, current.models);
            if (notClaude !== undefined)
              return yield* new KinWakeupError({ orgId, agentId, cause: notClaude });
            let cheapOnly = false;
            for (const priority of new Set(events.map((item) => item.priority))) {
              const admission = yield* budget.admit(orgId, priority);
              cheapOnly ||= admission.cheapOnly;
              if (!admission.allowed) {
                const deferred = new Set(
                  events.filter((item) => item.priority === priority).map((item) => item.eventId),
                );
                yield* queue.release({
                  orgId,
                  wakeupId,
                  eventIds: events
                    .filter((event) => deferred.has(event.eventId))
                    .map((event) => event.eventId),
                  notBefore: admission.nextReset,
                  countAttempt: false,
                  budgetDeferred: true,
                });
                events = events.filter((event) => !deferred.has(event.eventId));
              }
            }
            const routines = yield* Effect.serviceOption(Routines.KinRoutines);
            if (Option.isSome(routines))
              events = yield* Effect.filter(events, (event) =>
                event._tag === "routine"
                  ? routines.value.isEnabled(orgId, event.routine)
                  : Effect.succeed(true),
              );
            if (events.length === 0) {
              yield* queue.finish({ orgId, wakeupId, status: "completed" });
              return;
            }
            const budgetContext = yield* budget.promptContext(orgId);
            const lane = Option.isSome(bridge)
              ? Option.getOrUndefined(yield* bridge.value.lane({ orgId, agentId, wakeupId }))
              : undefined;
            const pinned = yield* memory.prepareWakeup(orgId, wakeupId, { lead: agentId }).pipe(
              Effect.tapError((error) =>
                Effect.logError("Kin memory preparation failed", {
                  orgId,
                  wakeupId,
                  errorTag: error._tag,
                }),
              ),
              Effect.tapError((error) =>
                error._tag === "MemoryCheckoutInvalid" && Option.isSome(hooks)
                  ? hooks.value.memoryCheckoutInvalid(error)
                  : Effect.void,
              ),
            );
            const eveningRun = events.some(
              (event) => event._tag === "routine" && event.routine === "evening_summary",
            );
            if (Option.isSome(ownerCheck)) {
              for (const event of events) {
                if (event._tag === "routine" && event.routine === "owner_check")
                  // Keep cards dark until the verified action dispatcher and clients land.
                  if (ownerCheckDispatcherReady)
                    yield* ownerCheck.value.post(orgId, event.eventId, event.ownerCheckItems ?? []);
              }
              events = events.filter(
                (event) => event._tag !== "routine" || event.routine !== "owner_check",
              );
              if (events.length === 0) {
                yield* queue.finish({ orgId, wakeupId, status: "completed" });
                return;
              }
            }
            if (Option.isSome(routineContent)) {
              // Briefs and summaries are written by the server, so they never wake the lead.
              for (const event of events)
                if (RoutineContent.isRoutineContent(event))
                  yield* routineContent.value.post(agentId, event).pipe(
                    // A failed brief retries on its own; the rest of the batch still runs.
                    Effect.catch((error) =>
                      Effect.logWarning("Kin routine content failed", {
                        orgId,
                        eventId: event.eventId,
                        cause: error.cause,
                      }).pipe(
                        Effect.andThen(
                          queue.release({
                            orgId,
                            wakeupId,
                            eventIds: [event.eventId],
                            countAttempt: true,
                          }),
                        ),
                      ),
                    ),
                  );
            }
            // The review and promotion cards are server-drawn after the summary, never the lead's.
            if (eveningRun && Option.isSome(promotion))
              yield* promotion.value.evening({ orgId, agentId });
            if (Option.isSome(routineContent)) {
              events = events.filter((event) => !RoutineContent.isRoutineContent(event));
              if (events.length === 0) {
                yield* queue.finish({ orgId, wakeupId, status: "completed" });
                return;
              }
            }
            const paths = yield* memory.ensureCheckouts(orgId);
            const { project } = yield* projects.bootstrap({
              commandId: CommandId.make(`kin-project:${orgId}`),
              projectId: ProjectId.make(`kin:${orgId}`),
              workspaceRoot: paths.read,
              title: `Kin · ${record.orgName}`,
            });
            const text = yield* prompt.build({
              orgId,
              agentId,
              wakeupId,
              events,
              memoryHead: pinned.head,
              budgetContext,
              ...(lane === undefined ? {} : { lane }),
            });
            const urgent =
              yield* sql`SELECT 1 FROM kin_events WHERE org_id = ${orgId} AND wakeup_id = ${wakeupId} AND priority IN ('P0', 'P1') LIMIT 1`;
            const modelSelection =
              !cheapOnly && (urgent.length > 0 || events.some((event) => event._tag === "routine"))
                ? current.models.strong
                : current.models.cheap;
            const threadId = current.threadId ?? ThreadId.make(`kin:${yield* ulid}`);
            row = { ...row, threadId };
            yield* sql.withTransaction(
              Effect.gen(function* () {
                const [active] =
                  yield* sql`SELECT 1 FROM kin_agents WHERE org_id = ${orgId} AND agent_id = ${agentId} AND retired_at IS NULL`;
                if (active === undefined)
                  return yield* new KinWakeupError({ orgId, agentId, cause: "retired" });
                // The post-time grant may have lapsed while these events waited to be claimed;
                // it now lasts as long as the wake-up may run, so a slow first reply still lands.
                yield* floor.renew({
                  orgId,
                  agentId,
                  until: row.startedAt + WAKEUP_DEADLINE_MS,
                  messageIds: events.flatMap((event) =>
                    event._tag === "chat.message" ||
                    event._tag === "widget.action" ||
                    event._tag === "chat.reaction"
                      ? [event.messageId]
                      : [],
                  ),
                });
                yield* identity.registerAgentThread({ orgId, agentId, threadId });
                yield* sql`UPDATE kin_leads SET thread_id = ${threadId} WHERE org_id = ${orgId} AND agent_id = ${agentId}`;
                yield* sql`UPDATE kin_wakeups SET thread_id = ${threadId}, model = ${modelSelection.model}
              WHERE org_id = ${orgId} AND wakeup_id = ${wakeupId} AND agent_id = ${agentId} AND status = 'running'`;
              }),
            );
            yield* registry.register(threadId, { orgId, agentId, wakeupId, level: current.level });
            if (Option.isSome(bridge))
              yield* bridge.value.begin({
                orgId,
                agentId,
                wakeupId,
                threadId,
                startedAt: row.startedAt,
              });
            const commandId = CommandId.make(`kin-wakeup:${wakeupId}`);
            const messageId = MessageId.make(KinIdentity.wakeupMessageId(wakeupId));
            const sent =
              current.threadId === null
                ? (yield* launch.launch({
                    commandId,
                    threadId,
                    projectId: project.id,
                    title: current.name,
                    modelSelection,
                    runtimeMode: "full-access",
                    interactionMode: "default",
                    workspaceStrategy: { type: "root" },
                    initialMessage: { messageId, text, attachments: [] },
                    createdBy: "system",
                    creationSource: "server",
                  })).projection
                : (yield* threads.sendToThread({
                    commandId,
                    projectId: project.id,
                    threadId,
                    messageId,
                    text,
                    attachments: [],
                    mode: "queue",
                    freshContext: true,
                    modelSelection,
                    createdBy: "system",
                    creationSource: "server",
                  })).projection;
            const run = sent.runs.findLast((run) => run.userMessageId === messageId);
            if (run === undefined)
              return yield* new KinWakeupError({ orgId, agentId, cause: "missing_run" });
            row = { ...row, runId: run.id };
            yield* sql`UPDATE kin_wakeups SET run_id = ${run.id} WHERE org_id = ${orgId} AND wakeup_id = ${wakeupId} AND agent_id = ${agentId} AND status = 'running'`;
            // A pause that landed during launch found no run to stop; stop it here instead.
            if (yield* paused(orgId))
              yield* threads.interruptThread({
                projectId: project.id,
                threadId,
                runId: run.id,
                commandId: CommandId.make(`kin-stop-launch:${wakeupId}`),
              });
            yield* wait(row, project.id);
          }).pipe(
            Effect.onExit((exit) =>
              Exit.isFailure(exit)
                ? cleanup(row, Exit.hasInterrupts(exit)).pipe(
                    Effect.catch((error) =>
                      Effect.logError("Kin wake-up cleanup failed", {
                        orgId,
                        wakeupId,
                        errorTag: error._tag,
                      }),
                    ),
                  )
                : Effect.void,
            ),
          );
        }),
      ).pipe(
        Effect.retry({
          while: (error) => error._tag === "KinEventQueueBusy",
          schedule: Schedule.spaced("5 seconds"),
        }),
      );
    },
    (effect, orgId, agentId) =>
      effect.pipe(
        Effect.mapError(
          (cause) => new KinWakeupError({ orgId, agentId, cause: runnerCause(cause) }),
        ),
      ),
  );
  const recoverOrg = Effect.fn("WakeupRunner.recoverOrg")(
    function* (orgId: KinOrgId) {
      const rows = yield* sql<{
        wakeupId: string;
      }>`SELECT org_id AS "orgId", agent_id AS "agentId", wakeup_id AS "wakeupId", thread_id AS "threadId", run_id AS "runId", started_at AS "startedAt" FROM kin_wakeups WHERE org_id = ${orgId} AND status = 'running' ORDER BY started_at, wakeup_id`;
      for (const raw of rows) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.acquireRelease(Effect.void, () =>
              queue
                .finish({ orgId, wakeupId: KinWakeupId.make(raw.wakeupId), status: "failed" })
                .pipe(Effect.ignore),
            );
            let row = yield* decodeRunning(raw);
            yield* Effect.acquireRelease(Effect.void, (_, exit) =>
              cleanup(row, Exit.hasInterrupts(exit)).pipe(Effect.ignore),
            );
            const existing =
              row.threadId === null
                ? []
                : yield* sql`SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id = ${row.threadId}`;
            const projection =
              row.threadId === null || existing.length === 0
                ? undefined
                : yield* threads.getThreadProjection(row.threadId);
            const run = projection?.runs.find((run) =>
              row.runId === null
                ? run.userMessageId === KinIdentity.wakeupMessageId(row.wakeupId)
                : run.id === row.runId,
            );
            if (projection === undefined || run === undefined) {
              const receipts =
                yield* sql`SELECT 1 FROM kin_lead_tool_calls WHERE org_id = ${row.orgId} AND wakeup_id = ${row.wakeupId} LIMIT 1`;
              if (receipts.length > 0 && Option.isSome(writer)) {
                yield* writer.value
                  .commitWakeup(row.orgId, row.wakeupId, "failed")
                  .pipe(
                    Effect.catchCause((cause) =>
                      Effect.logError(
                        "Kin recovery commit failed; requeueing unfinished wake-up",
                        cause,
                      ),
                    ),
                  );
              }
              if (projection === undefined) yield* clearMissingThread(row);
              yield* queue.requeueUnfinished(row.orgId, row.wakeupId);
              return;
            }
            row = { ...row, runId: run.id };
            yield* sql`UPDATE kin_wakeups SET run_id = ${run.id} WHERE org_id = ${row.orgId} AND agent_id = ${row.agentId} AND wakeup_id = ${row.wakeupId} AND status = 'running'`;
            const record = yield* lead(row.orgId, row.agentId);
            if (record.retiredAt !== null) {
              yield* cleanup(row);
              return yield* retire(record);
            }
            yield* identity.registerAgentThread({
              orgId: row.orgId,
              agentId: row.agentId,
              threadId: projection.thread.id,
            });
            yield* registry.register(projection.thread.id, { ...row, level: record.level });
            if (Option.isSome(bridge))
              yield* bridge.value.begin({ ...row, threadId: projection.thread.id });
            yield* wait(row, projection.thread.projectId).pipe(
              Effect.onExit((exit) =>
                Exit.isFailure(exit)
                  ? cleanup(row, Exit.hasInterrupts(exit)).pipe(Effect.ignore)
                  : Effect.void,
              ),
            );
          }),
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("Kin wake-up recovery failed", {
              orgId,
              wakeupId: raw.wakeupId,
              cause,
            }),
          ),
        );
      }
    },
    Effect.mapError((cause) =>
      isWakeupError(cause)
        ? cause
        : new KinWakeupError({
            orgId: KinOrgId.make("startup"),
            agentId: KinAgentId.make("startup"),
            cause: runnerCause(cause),
          }),
    ),
  );

  const orgIds = Effect.fn("WakeupRunner.orgIds")(function* () {
    const rows = yield* sql<{
      orgId: string;
    }>`SELECT org_id AS "orgId" FROM kin_leads GROUP BY org_id ORDER BY org_id`;
    return rows.map((row) => KinOrgId.make(row.orgId));
  });
  const recover = Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.forEach(
        yield* orgIds(),
        (orgId) =>
          recoverOrg(orgId).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("Kin org recovery failed", { orgId, cause }),
            ),
          ),
        {
          concurrency: "unbounded",
          discard: true,
        },
      );
    }),
  ).pipe(
    Effect.mapError(
      (cause) =>
        new KinWakeupError({
          orgId: KinOrgId.make("startup"),
          agentId: KinAgentId.make("startup"),
          cause: runnerCause(cause),
        }),
    ),
  );
  const start = Effect.gen(function* () {
    const organizations = new Set<KinOrgId>();
    yield* Effect.gen(function* () {
      for (const orgId of yield* orgIds()) {
        if (organizations.has(orgId)) continue;
        organizations.add(orgId);
        yield* Effect.gen(function* () {
          const changed = yield* queue.changes(orgId);
          yield* recoverOrg(orgId);
          const unfinished =
            yield* sql`SELECT 1 FROM kin_wakeups WHERE org_id = ${orgId} AND status = 'running'`;
          if (unfinished.length > 0) {
            yield* Effect.raceFirst(changed, threadActivity(orgId)).pipe(
              Effect.timeoutOrElse({ duration: 60_000, orElse: () => Effect.void }),
            );
            return;
          }
          const rows = yield* sql<{
            agentId: string;
          }>`SELECT l.agent_id AS "agentId" FROM kin_leads l
              JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
              WHERE l.org_id = ${orgId} AND a.retired_at IS NOT NULL ORDER BY l.agent_id`;
          for (const row of rows) yield* retire(yield* lead(orgId, KinAgentId.make(row.agentId)));
          const next = (yield* paused(orgId)) ? undefined : yield* queue.nextReady(orgId);
          const now = yield* Clock.currentTimeMillis;
          if (next !== undefined && next.readyAt <= now) {
            yield* runOnce(orgId, next.agentId);
            return;
          }
          yield* Effect.raceFirst(changed, threadActivity(orgId)).pipe(
            Effect.timeoutOrElse({
              duration: Math.min(60_000, Math.max(1, (next?.readyAt ?? Infinity) - now)),
              orElse: () => Effect.void,
            }),
          );
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("Kin runner iteration failed", { orgId, cause }).pipe(
              Effect.andThen(Effect.sleep("1 second")),
            ),
          ),
          Effect.forever,
          Effect.catchCause((cause) => Effect.logError("Kin org loop failed", { orgId, cause })),
          Effect.ensuring(Effect.sync(() => organizations.delete(orgId))),
          Effect.forkScoped,
        );
      }
    }).pipe(
      Effect.catchCause((cause) => Effect.logError("Kin runner discovery failed", { cause })),
      Effect.repeat(Schedule.spaced("60 seconds")),
      Effect.forkScoped,
    );
  }).pipe(Effect.catchCause((cause) => Effect.logError("Kin runner unavailable", { cause })));
  return WakeupRunner.of({ runOnce, recover, start });
});

export const layer = Layer.effect(WakeupRunner, make).pipe(Layer.provide(Floor.layer));
