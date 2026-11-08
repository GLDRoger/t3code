import {
  CommandId,
  KinAgentId,
  KinChatError,
  KinChatId,
  KinEvent,
  KinMemoryItemId,
  KinOrgId,
  KinWorkerId,
  MessageId,
  ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TrimmedNonEmptyString,
  WorkerReport,
  type KinLevel,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { isSqlError } from "effect/sql/SqlError";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { ProviderInstanceRegistry } from "../../provider/ProviderInstanceRegistry.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import * as Memory from "../memory/Memory.ts";
import { KinBudget } from "./KinBudget.ts";
import { isOrgPaused, STOP_REASON } from "./orgState.ts";
import { resolveLead } from "./LeadMemory.ts";
import { quote } from "./LeadPrompt.ts";
import { buildBrief, Quoted, reportFormat } from "./workerBrief.ts";

const text = (max: number) => Schema.String.check(Schema.isMaxLength(max));

const WorkerModel = Schema.Union([
  Schema.Literals(["strong", "cheap"]),
  Schema.Struct({ instanceId: ProviderInstanceId, model: TrimmedNonEmptyString }),
]);
export const DelegateInput = Schema.Struct({
  kind: Schema.Literals(["build", "review", "research"]),
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  goal: TrimmedNonEmptyString.check(Schema.isMaxLength(8_000)),
  brief: text(100_000),
  quoted: Schema.optional(Quoted),
  projectId: ProjectId,
  baseRef: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(WorkerModel),
  memoryItemIds: Schema.optional(Schema.Array(KinMemoryItemId).check(Schema.isMaxLength(20))),
  reviewOf: Schema.optional(KinWorkerId),
  sourceEventId: TrimmedNonEmptyString,
});
export const FollowUpInput = Schema.Struct({
  workerId: KinWorkerId,
  brief: TrimmedNonEmptyString.check(Schema.isMaxLength(100_000)),
  quoted: Schema.optional(Quoted),
  sourceEventId: TrimmedNonEmptyString,
});
export const StopInput = Schema.Struct({
  workerId: KinWorkerId,
  reason: Schema.optional(text(2_000)),
});
export const DelegateResult = Schema.Union([
  Schema.Struct({ workerId: KinWorkerId, threadLink: Schema.String }),
  Schema.Struct({ shadowed: Schema.Literal(true), entryId: TrimmedNonEmptyString }),
]);
export const StopResult = Schema.Struct({ workerId: KinWorkerId, stopped: Schema.Boolean });

// lead.md release gate: workers hold a full /mcp credential until T3 scopes tools per capability.
const workerLaunchReady = false;
/** Test seam for the release gate; production always reads `workerLaunchReady`. */
export const WorkerLaunchGate = Context.Reference<boolean>("t3/kin/lead/Workers/WorkerLaunchGate", {
  defaultValue: () => workerLaunchReady,
});

const isLive = (run: OrchestrationV2Run) =>
  run.status === "queued" || ThreadManagement.isActiveRun(run);
type ThreadRuns = Pick<OrchestrationV2ThreadProjection, "thread" | "runs">;
const liveRun = (projection: ThreadRuns) => projection.runs.findLast(isLive);
/** Interrupts the thread's live run and stops its delegated tasks; true when a run was live. */
export const stopThreadTree = Effect.fn("KinWorkers.stopThreadTree")(function* (
  threads: ThreadManagement.ThreadManagementService["Service"],
  input: {
    readonly projection: ThreadRuns;
    readonly prefix: string;
    readonly tag: string;
    readonly reason: string;
  },
) {
  const { projection, prefix, tag, reason } = input;
  const active = liveRun(projection);
  if (active !== undefined)
    yield* threads.interruptThread({
      projectId: projection.thread.projectId,
      threadId: projection.thread.id,
      runId: active.id,
      commandId: CommandId.make(`${prefix}:${tag}`),
      reason,
    });
  yield* threads.stopDelegatedTasks({
    threadId: projection.thread.id,
    commandId: CommandId.make(`${prefix}-tasks:${tag}`),
    reason,
  });
  return active !== undefined;
});

const supportedDrivers = new Set([
  ProviderDriverKind.make("claudeAgent"),
  ProviderDriverKind.make("codex"),
]);
const denied = (message = "Worker operation is not allowed.") =>
  new KinChatError({ reason: "not_allowed", message });
const missing = () => new KinChatError({ reason: "not_found", message: "Kin record not found." });
const unavailable = () =>
  new KinChatError({ reason: "unavailable", message: "Kin workers are unavailable." });
const isChatError = Schema.is(KinChatError);
const toolFailure = (label: string) => (error: unknown) =>
  isChatError(error)
    ? Effect.succeed(error)
    : Effect.logError(
        "Kin worker operation failed",
        isSqlError(error) ? toPersistenceSqlError(label)(error) : error,
      ).pipe(Effect.as(unavailable()));
const guarded =
  (label: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.catch((error) => Effect.flatMap(toolFailure(label)(error), Effect.fail)));
const LeadRow = Schema.Struct({
  level: Schema.Literals(["L0", "L1", "L2", "L3"]),
  models: Schema.fromJsonString(Schema.Struct({ strong: ModelSelection, cheap: ModelSelection })),
  projects: Schema.fromJsonString(Schema.Array(ProjectId)),
  ownerChatId: KinChatId,
});
const WorkerRow = Schema.Struct({
  workerId: KinWorkerId,
  kind: Schema.Literals(["build", "review", "research"]),
  agentId: KinAgentId,
  wakeupId: TrimmedNonEmptyString,
  threadId: ThreadId,
  title: Schema.NullOr(Schema.String),
  chatId: Schema.NullOr(KinChatId),
  model: Schema.fromJsonString(ModelSelection),
  report: Schema.NullOr(Schema.fromJsonString(WorkerReport)),
});
const decodeLead = Schema.decodeUnknownEffect(LeadRow);
const decodeWorker = Schema.decodeUnknownEffect(WorkerRow);
const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(KinEvent));
const decodeSelection = Schema.decodeUnknownEffect(ModelSelection);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

type Lead = Effect.Success<ReturnType<typeof resolveLead>>;

export class KinWorkers extends Context.Service<
  KinWorkers,
  {
    readonly delegate: (
      scope: McpInvocationScope,
      input: typeof DelegateInput.Type,
    ) => Effect.Effect<typeof DelegateResult.Type, KinChatError>;
    readonly followUp: (
      scope: McpInvocationScope,
      input: typeof FollowUpInput.Type,
    ) => Effect.Effect<typeof DelegateResult.Type, KinChatError>;
    readonly stop: (
      scope: McpInvocationScope,
      input: typeof StopInput.Type,
    ) => Effect.Effect<typeof StopResult.Type, KinChatError>;
  }
>()("t3/kin/lead/Workers/KinWorkers") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const identity = yield* KinIdentity;
  const chat = yield* KinChatService;
  const budget = yield* KinBudget;
  const memory = yield* Memory.Memory;
  const launch = yield* ThreadLaunch.ThreadLaunchService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const providers = yield* ProviderInstanceRegistry;
  const environment = yield* ServerEnvironment;
  const orchestrator = yield* OrchestratorV2;
  const digest = yield* Digest.Digest;
  const hash = Effect.fn("KinWorkers.hash")((value: unknown) =>
    digest
      .digest(Digest.sha256, new TextEncoder().encode(stableStringify(value)))
      .pipe(Effect.map(Hex.encode)),
  );
  const lead = (scope: McpInvocationScope) =>
    resolveLead(scope).pipe(
      Effect.provideService(KinIdentity, identity),
      Effect.provideService(SqlClient.SqlClient, sql),
    );
  const leadConfig = Effect.fn("KinWorkers.leadConfig")(function* (ctx: Lead) {
    const [row] = yield* sql`SELECT level, models_json AS models, worker_projects_json AS projects,
      owner_chat_id AS "ownerChatId" FROM kin_leads
      WHERE org_id = ${ctx.orgId} AND agent_id = ${ctx.agentId} ORDER BY agent_id`;
    if (row === undefined) return yield* denied();
    return yield* decodeLead(row);
  });
  const sourceEvent = Effect.fn("KinWorkers.sourceEvent")(function* (ctx: Lead, eventId: string) {
    const [row] = yield* sql<{ json: string }>`SELECT json FROM kin_events
      WHERE org_id = ${ctx.orgId} AND agent_id = ${ctx.agentId} AND wakeup_id = ${ctx.wakeupId}
        AND event_id = ${eventId} ORDER BY event_id`;
    if (row === undefined) return yield* missing();
    return yield* decodeEvent(row.json);
  });
  const worker = Effect.fn("KinWorkers.worker")(function* (orgId: KinOrgId, workerId: KinWorkerId) {
    const [row] = yield* sql`SELECT worker_id AS "workerId", kind, agent_id AS "agentId",
      wakeup_id AS "wakeupId", thread_id AS "threadId", title, chat_id AS "chatId",
      model_json AS model, report_json AS report
      FROM kin_workers WHERE org_id = ${orgId} AND worker_id = ${workerId} ORDER BY worker_id`;
    if (row === undefined) return yield* missing();
    return yield* decodeWorker(row);
  });
  // Shadow levels record what the lead would have done (LEAD-8 renders the summary).
  const shadow = Effect.fn("KinWorkers.shadow")(function* (
    ctx: Lead,
    level: KinLevel,
    tool: string,
    input: unknown,
    target: string,
  ) {
    const entryId = `shadow-${(yield* hash({ wakeupId: ctx.wakeupId, tool, input })).slice(0, 32)}`;
    const json = yield* encodeJson(input);
    const inserted = yield* sql`INSERT INTO kin_shadow_entries
      (entry_id, org_id, agent_id, wakeup_id, level, unlocks_level, tool, input_json, would_target, created_at)
      VALUES (${entryId}, ${ctx.orgId}, ${ctx.agentId}, ${ctx.wakeupId}, ${level}, 'L2', ${tool}, ${json}, ${target},
        ${yield* Clock.currentTimeMillis}) ON CONFLICT DO NOTHING RETURNING entry_id`;
    if (inserted.length === 0) {
      const [stored] = yield* sql<{
        json: string;
      }>`SELECT input_json AS json FROM kin_shadow_entries
        WHERE org_id = ${ctx.orgId} AND entry_id = ${entryId} ORDER BY entry_id`;
      if (stored?.json !== json) return yield* denied();
    }
    return { shadowed: true as const, entryId };
  });
  const admit = Effect.fn("KinWorkers.admit")(function* (orgId: KinOrgId) {
    if (!(yield* WorkerLaunchGate))
      return yield* denied("Worker launches are disabled until T3 tool scoping lands.");
    if (yield* isOrgPaused(orgId).pipe(Effect.provideService(SqlClient.SqlClient, sql)))
      return yield* denied("Kin is paused by the owner. Nothing new starts until they resume.");
    if (!(yield* budget.admitWorker(orgId)))
      return yield* new KinChatError({
        reason: "limit",
        message:
          "Today's worker budget is used up. Tell the owner; workers can start again after the daily reset or a higher limit.",
      });
  });
  const selection = Effect.fn("KinWorkers.selection")(function* (
    model: typeof WorkerModel.Type | undefined,
    configured: typeof LeadRow.Type.models,
  ) {
    const chosen =
      model === undefined || model === "strong"
        ? configured.strong
        : model === "cheap"
          ? configured.cheap
          : yield* decodeSelection(model).pipe(Effect.mapError(() => denied()));
    const instance = yield* providers.getInstance(chosen.instanceId);
    if (instance === undefined || !instance.enabled || !supportedDrivers.has(instance.driverKind))
      return yield* denied("Kin workers run on an enabled Claude Code or Codex provider only.");
    return chosen;
  });
  /** The stop fan-out misses a run that starts during its pass; a pause seen after the launch or send stops it. */
  const stopIfPaused = Effect.fn("KinWorkers.stopIfPaused")(function* (
    orgId: KinOrgId,
    projection: ThreadRuns,
  ) {
    if (!(yield* isOrgPaused(orgId).pipe(Effect.provideService(SqlClient.SqlClient, sql)))) return;
    yield* stopThreadTree(threads, {
      projection,
      prefix: "kin-stop-launch",
      tag: `${projection.thread.id}:${liveRun(projection)?.id ?? "idle"}`,
      reason: STOP_REASON,
    });
  });
  const threadLink = Effect.fn("KinWorkers.threadLink")(function* (threadId: ThreadId) {
    return formatThreadLink({ environmentId: yield* environment.getEnvironmentId, threadId });
  });
  // Cards are best effort: a launched worker must not fail because its card could not be shown.
  const showCard = Effect.fn("KinWorkers.showCard")(
    function* (input: {
      readonly orgId: KinOrgId;
      readonly chatId: KinChatId;
      readonly agentId: KinAgentId;
      readonly threadId: ThreadId;
      readonly title: string;
      readonly model: string;
      /** A closed card reopens only for a worker that is running again. */
      readonly reopen: boolean;
    }) {
      const card = yield* chat
        .createTaskCard({
          orgId: input.orgId,
          chatId: input.chatId,
          authorAgentId: input.agentId,
          threadId: input.threadId,
          title: input.title,
          model: input.model,
        })
        .pipe(
          Effect.provideService(OrchestratorV2, orchestrator),
          Effect.provideService(ServerEnvironment, environment),
        );
      if (card.closedAt !== null && input.reopen)
        yield* chat.setTaskCardClosed({
          orgId: input.orgId,
          chatId: input.chatId,
          threadId: input.threadId,
          closed: false,
        });
    },
    Effect.catchCause((cause) => Effect.logWarning("Kin worker task card unavailable", { cause })),
  );

  const delegate = Effect.fn("KinWorkers.delegate")(function* (
    scope: McpInvocationScope,
    input: typeof DelegateInput.Type,
  ) {
    const ctx = yield* lead(scope);
    const plan = yield* sql.withTransaction(
      Effect.gen(function* () {
        const config = yield* leadConfig(ctx);
        const event = yield* sourceEvent(ctx, input.sourceEventId);
        if (!config.projects.includes(input.projectId))
          return yield* denied("Workers may only run in this lead's worker projects.");
        if ((input.kind === "review") !== (input.reviewOf !== undefined))
          return yield* denied("Review workers need reviewOf, and only review workers take it.");
        const author =
          input.reviewOf === undefined ? undefined : yield* worker(ctx.orgId, input.reviewOf);
        return { config, event, author };
      }),
    );
    const modelSelection = yield* selection(input.model, plan.config.models);
    let reviewRefs: ReadonlyArray<{ kind: string; ref: string }> | undefined;
    if (plan.author !== undefined) {
      if (
        modelSelection.instanceId === plan.author.model.instanceId ||
        modelSelection.model === plan.author.model.model
      )
        return yield* denied(
          "A reviewer needs a different provider instance and a different model from the author worker.",
        );
      reviewRefs = (plan.author.report?.evidence ?? [])
        .filter((item) => item.kind === "pr" || item.kind === "commit")
        .map(({ kind, ref }) => ({ kind, ref }));
      if (reviewRefs.length === 0)
        return yield* denied("The author worker has not reported a PR or commit to review yet.");
    }
    if (plan.config.level === "L0" || plan.config.level === "L1")
      return yield* shadow(ctx, plan.config.level, "kin_delegate", input, input.projectId);
    yield* admit(ctx.orgId);
    const items =
      reviewRefs !== undefined
        ? []
        : yield* Effect.forEach(input.memoryItemIds ?? [], (id) =>
            memory.readItemQuietly(ctx.orgId, id).pipe(
              Effect.map((item) => ({ id, title: item.head.title, body: item.body })),
              Effect.mapError(() => missing()),
            ),
          );
    const brief =
      reviewRefs !== undefined
        ? buildBrief({ goal: input.goal, reviewRefs })
        : buildBrief({
            goal: input.goal,
            brief: input.brief,
            ...(input.quoted === undefined ? {} : { quoted: input.quoted }),
            memory: items,
          });
    const workerId = KinWorkerId.make(
      `wk-${(yield* hash({ wakeupId: ctx.wakeupId, input })).slice(0, 32)}`,
    );
    const threadId = ThreadId.make(`kin-worker-${workerId}`);
    const chatId =
      plan.event._tag === "chat.message" || plan.event._tag === "widget.action"
        ? plan.event.chatId
        : plan.config.ownerChatId;
    const ordinal = yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* lead(scope);
        if (input.reviewOf !== undefined) yield* worker(ctx.orgId, input.reviewOf);
        const startedAt = yield* Clock.currentTimeMillis;
        const inserted = yield* sql`INSERT INTO kin_workers (worker_id, org_id, agent_id, wakeup_id,
          kind, thread_id, review_of, model_json, provenance_json, status, report_json, started_at,
          ended_at, title, chat_id) VALUES (${workerId}, ${ctx.orgId}, ${ctx.agentId}, ${ctx.wakeupId},
          ${input.kind}, ${threadId}, ${input.reviewOf ?? null}, ${yield* encodeJson(modelSelection)},
          ${yield* encodeJson(plan.event.provenance)}, 'queued', NULL, ${startedAt}, NULL,
          ${input.title}, ${chatId}) ON CONFLICT DO NOTHING RETURNING worker_id`;
        if (inserted.length === 0) {
          const stored = yield* worker(ctx.orgId, workerId);
          if (stored.wakeupId !== ctx.wakeupId || stored.threadId !== threadId)
            return yield* denied();
          yield* sql`UPDATE kin_workers SET status = 'queued', started_at = ${startedAt}, ended_at = NULL
            WHERE org_id = ${ctx.orgId} AND worker_id = ${workerId} AND status = 'failed'`;
        }
        const [row] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_workers
          WHERE org_id = ${ctx.orgId} AND wakeup_id = ${ctx.wakeupId} AND rowid <= (
            SELECT rowid FROM kin_workers WHERE org_id = ${ctx.orgId} AND worker_id = ${workerId})`;
        return row?.n ?? 1;
      }),
    );
    const launched = yield* launch
      .launch({
        commandId: CommandId.make(`kin-worker:${ctx.wakeupId}:${ordinal}`),
        threadId,
        projectId: input.projectId,
        title: input.title,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: {
          type: "worktree",
          baseRef: input.baseRef ?? "origin/HEAD",
          startFromOrigin: true,
        },
        initialMessage: {
          messageId: MessageId.make(`kin-worker-msg:${workerId}`),
          text: brief,
          attachments: [],
        },
        createdBy: "agent",
        creationSource: "server",
      })
      .pipe(
        Effect.tapError(() =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            yield* sql`UPDATE kin_workers SET status = 'failed', ended_at = ${now}
              WHERE org_id = ${ctx.orgId} AND worker_id = ${workerId} AND status = 'queued'`;
          }).pipe(Effect.ignore),
        ),
        Effect.mapError(
          () =>
            new KinChatError({
              reason: "unavailable",
              message: "The worker could not start. Retry the same call or tell the owner.",
            }),
        ),
      );
    yield* stopIfPaused(ctx.orgId, launched.projection);
    const live = launched.projection.runs.some(isLive);
    // A resumed launch can start nothing; the row then takes the thread's real outcome.
    if (!live) {
      const last = launched.projection.runs.at(-1);
      const endedAt =
        last?.completedAt == null
          ? yield* Clock.currentTimeMillis
          : DateTime.toEpochMillis(last.completedAt);
      yield* sql`UPDATE kin_workers SET status = ${last?.status ?? "failed"}, ended_at = ${endedAt}
        WHERE org_id = ${ctx.orgId} AND worker_id = ${workerId} AND status = 'queued'`;
    }
    yield* showCard({
      orgId: ctx.orgId,
      chatId,
      agentId: ctx.agentId,
      threadId,
      title: input.title,
      model: modelSelection.model,
      reopen: live,
    });
    return { workerId, threadLink: yield* threadLink(threadId) };
  }, guarded("KinWorkers.delegate"));

  const followUp = Effect.fn("KinWorkers.followUp")(function* (
    scope: McpInvocationScope,
    input: typeof FollowUpInput.Type,
  ) {
    const ctx = yield* lead(scope);
    const plan = yield* sql.withTransaction(
      Effect.gen(function* () {
        const config = yield* leadConfig(ctx);
        yield* sourceEvent(ctx, input.sourceEventId);
        const stored = yield* worker(ctx.orgId, input.workerId);
        // A reviewer sees only the author's refs; more lead text would end that isolation.
        if (stored.kind === "review")
          return yield* denied(
            "Review workers take no follow-ups. Start a new review with kin_delegate.",
          );
        return { config, worker: stored };
      }),
    );
    if (plan.config.level === "L0" || plan.config.level === "L1")
      return yield* shadow(ctx, plan.config.level, "kin_follow_up", input, input.workerId);
    yield* admit(ctx.orgId);
    const key = (yield* hash({ wakeupId: ctx.wakeupId, input })).slice(0, 32);
    const projection = yield* threads
      .getThreadProjection(plan.worker.threadId)
      .pipe(Effect.mapError(() => missing()));
    const sent = yield* threads
      .sendToThread({
        projectId: projection.thread.projectId,
        commandId: CommandId.make(`kin-follow-up:${ctx.wakeupId}:${key}`),
        threadId: plan.worker.threadId,
        messageId: MessageId.make(`kin-follow-up-msg:${key}`),
        text: [
          "Follow-up from Kin. Continue this task yourself.",
          input.brief,
          ...(input.quoted ?? []).map((item) => quote("quoted text (untrusted)", item, true)),
          reportFormat,
        ].join("\n\n"),
        attachments: [],
        mode: "queue",
        createdBy: "agent",
        creationSource: "server",
      })
      .pipe(
        Effect.mapError(
          () =>
            new KinChatError({
              reason: "unavailable",
              message: "The follow-up could not be sent. Retry the same call or tell the owner.",
            }),
        ),
      );
    yield* sql`UPDATE kin_workers SET status = 'queued', ended_at = NULL
      WHERE org_id = ${ctx.orgId} AND worker_id = ${input.workerId}`;
    yield* stopIfPaused(ctx.orgId, sent.projection);
    if (plan.worker.chatId !== null)
      yield* showCard({
        orgId: ctx.orgId,
        chatId: plan.worker.chatId,
        agentId: plan.worker.agentId,
        threadId: plan.worker.threadId,
        title: plan.worker.title ?? projection.thread.title,
        model: plan.worker.model.model,
        reopen: true,
      });
    return { workerId: input.workerId, threadLink: yield* threadLink(plan.worker.threadId) };
  }, guarded("KinWorkers.followUp"));

  const stop = Effect.fn("KinWorkers.stop")(function* (
    scope: McpInvocationScope,
    input: typeof StopInput.Type,
  ) {
    const ctx = yield* lead(scope);
    const record = yield* sql.withTransaction(worker(ctx.orgId, input.workerId));
    const projection = yield* threads
      .getThreadProjection(record.threadId)
      .pipe(Effect.mapError(() => missing()));
    // A follow-up in the same wake-up starts a new run, which a second stop must still reach.
    const tag = `${input.workerId}:${ctx.wakeupId}:${(liveRun(projection) ?? projection.runs.at(-1))?.id ?? "idle"}`;
    const stopped = yield* stopThreadTree(threads, {
      projection,
      prefix: "kin-worker-stop",
      tag,
      reason: input.reason ?? "Stopped by the Kin lead.",
    });
    if (record.chatId !== null)
      yield* chat
        .setTaskCardClosed({
          orgId: ctx.orgId,
          chatId: record.chatId,
          threadId: record.threadId,
          closed: true,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Kin worker task card could not close", { cause }),
          ),
        );
    return { workerId: input.workerId, stopped };
  }, guarded("KinWorkers.stop"));

  return KinWorkers.of({ delegate, followUp, stop });
});

export const layer = Layer.effect(KinWorkers, make);
