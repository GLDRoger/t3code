import {
  CommandId,
  KinAgentId,
  KinLead,
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
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import { isSqlError } from "effect/sql/SqlError";

import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as KinIdentity from "../chat/KinIdentity.ts";
import * as Memory from "../memory/Memory.ts";
import * as KinEventQueue from "./KinEventQueue.ts";
import * as KinLeadRegistry from "./KinLeadRegistry.ts";
import { KinLeadPrompt } from "./LeadPrompt.ts";

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
const encodeUsage = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
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
  const sql = yield* SqlClient.SqlClient;
  const queue = yield* KinEventQueue.KinEventQueue;
  const memory = yield* Memory.Memory;
  const hooks = yield* Effect.serviceOption(KinWakeupHooks);
  const prompt = yield* KinLeadPrompt;
  const identity = yield* KinIdentity.KinIdentity;
  const registry = yield* KinLeadRegistry.KinLeadRegistry;
  const projects = yield* ProjectService.ProjectService;
  const launch = yield* ThreadLaunchService.ThreadLaunchService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const threadActivity = threads.streamDomainEvents.pipe(
    Stream.filter(
      (event) =>
        event.type === "run.updated" ||
        (event.type === "provider-turn.updated" && event.payload.completedAt !== null),
    ),
    Stream.runHead,
  );

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
    if (record.threadId !== null)
      yield* identity.endAgentThread({ orgId: record.orgId, threadId: record.threadId });
    retired.add(record.agentId);
  });
  const capture = Effect.fn("WakeupRunner.capture")(function* (row: typeof RunningRow.Type) {
    if (row.threadId === null || row.runId === null) return;
    const projection = yield* threads.getThreadProjection(row.threadId);
    const runIds = new Set([row.runId]);
    for (const run of projection.runs.toSorted((a, b) => a.ordinal - b.ordinal)) {
      if (
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
    const usage = turns.flatMap((turn) =>
      turn.tokenUsage === undefined ? [] : [{ providerTurnId: turn.id, ...turn.tokenUsage }],
    );
    const tokens = yield* encodeUsage(usage);
    yield* sql`UPDATE kin_wakeups SET tokens_json = ${tokens}
      WHERE org_id = ${row.orgId} AND agent_id = ${row.agentId} AND wakeup_id = ${row.wakeupId} AND status = 'running'`;
  });
  const wait = Effect.fn("WakeupRunner.wait")(function* (
    row: typeof RunningRow.Type,
    projectId: ProjectId,
  ) {
    if (row.threadId === null || row.runId === null) return;
    const threadId = row.threadId;
    const runId = row.runId;
    const remaining = Math.max(0, row.startedAt + 900_000 - (yield* Clock.currentTimeMillis));
    const result = yield* threads.waitForThread({
      projectId,
      threadId: row.threadId,
      runId: row.runId,
      timeoutMs: remaining,
    });
    const status = result.timedOut
      ? "timed_out"
      : result.run?.status === "completed"
        ? "completed"
        : "failed";
    yield* Effect.gen(function* () {
      if (result.timedOut) {
        yield* threads.interruptThread({
          projectId,
          threadId,
          runId: result.run?.id ?? runId,
          commandId: CommandId.make(`kin-timeout:${row.wakeupId}`),
        });
        const settled = yield* threads.waitForThread({
          projectId,
          threadId,
          runId,
          timeoutMs: 30_000,
        });
        if (settled.timedOut)
          yield* Effect.logWarning("Kin timed-out run may continue after interrupt", {
            orgId: row.orgId,
            wakeupId: row.wakeupId,
            runId,
          });
      }
      yield* capture(row);
      yield* queue.finish({ orgId: row.orgId, wakeupId: row.wakeupId, status });
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
  });
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
    else yield* queue.finish({ orgId: row.orgId, wakeupId: row.wakeupId, status: "failed" });
  });

  const runOnce = Effect.fn("WakeupRunner.runOnce")(
    function* (orgId: KinOrgId, agentId: KinAgentId) {
      const record = yield* lead(orgId, agentId);
      if (record.retiredAt !== null) return yield* retire(record);
      const paused = yield* sql`SELECT 1 FROM kin_org_state WHERE org_id = ${orgId} AND paused = 1`;
      if (paused.length > 0) return;
      if (record.threadId !== null) {
        const unfinished = yield* sql`SELECT 1 FROM orchestration_v2_projection_provider_turns
          WHERE thread_id = ${record.threadId} AND completed_at IS NULL LIMIT 1`;
        const busy = yield* sql`SELECT 1 FROM orchestration_v2_projection_runs
          WHERE thread_id = ${record.threadId}
            AND status IN ${sql.in(["queued", ...ThreadManagementService.ACTIVE_RUN_STATUSES])} LIMIT 1`;
        if (unfinished.length > 0 || busy.length > 0) {
          yield* Effect.raceFirst(yield* queue.changes(orgId), threadActivity).pipe(
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
          const events = yield* Effect.acquireRelease(
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
            const paused =
              yield* sql`SELECT 1 FROM kin_org_state WHERE org_id = ${orgId} AND paused = 1`;
            if (paused.length > 0) {
              yield* queue.release({
                orgId,
                wakeupId,
                countAttempt: false,
                notBefore: (yield* Clock.currentTimeMillis) + 5_000,
              });
              return;
            }
            const current = yield* lead(orgId, agentId);
            if (current.retiredAt !== null) {
              yield* queue.finish({ orgId, wakeupId, status: "failed" });
              return yield* retire(current);
            }
            const pinned = yield* memory.prepareWakeup(orgId).pipe(
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
            });
            const urgent =
              yield* sql`SELECT 1 FROM kin_events WHERE org_id = ${orgId} AND wakeup_id = ${wakeupId} AND priority IN ('P0', 'P1') LIMIT 1`;
            const modelSelection =
              urgent.length > 0 || events.some((event) => event._tag === "routine")
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
                yield* identity.registerAgentThread({ orgId, agentId, threadId });
                yield* sql`UPDATE kin_leads SET thread_id = ${threadId} WHERE org_id = ${orgId} AND agent_id = ${agentId}`;
                yield* sql`UPDATE kin_wakeups SET thread_id = ${threadId}, model = ${modelSelection.model}
              WHERE org_id = ${orgId} AND wakeup_id = ${wakeupId} AND agent_id = ${agentId} AND status = 'running'`;
              }),
            );
            yield* registry.register(threadId, { orgId, agentId, wakeupId, level: current.level });
            const commandId = CommandId.make(`kin-wakeup:${wakeupId}`);
            const messageId = MessageId.make(`kin-wakeup-msg:${wakeupId}`);
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
                ? run.userMessageId === `kin-wakeup-msg:${row.wakeupId}`
                : run.id === row.runId,
            );
            if (projection === undefined || run === undefined) {
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
            yield* Effect.raceFirst(changed, threadActivity).pipe(
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
          const paused =
            yield* sql`SELECT 1 FROM kin_org_state WHERE org_id = ${orgId} AND paused = 1`;
          const next = paused.length === 0 ? yield* queue.nextReady(orgId) : undefined;
          const now = yield* Clock.currentTimeMillis;
          if (next !== undefined && next.readyAt <= now) {
            yield* runOnce(orgId, next.agentId);
            return;
          }
          yield* Effect.raceFirst(changed, threadActivity).pipe(
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

export const layer = Layer.effect(WakeupRunner, make);
