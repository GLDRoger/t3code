import {
  EnvironmentId,
  KinAgentId,
  KinChatError,
  KinChatId,
  KinEvent,
  KinMemoryItemId,
  KinOrgId,
  KinWorkerId,
  ModelSelection,
  type OrchestratorMcpFailure,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TrimmedNonEmptyString,
  WorkerReport,
  type KinLevel,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Tool from "effect/ai/Tool";
import * as SqlClient from "effect/sql/SqlClient";
import { isSqlError } from "effect/sql/SqlError";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import * as Memory from "../memory/Memory.ts";
import { KinBudget } from "./KinBudget.ts";
import * as KinLevels from "./KinLevels.ts";
import { isOrgPaused, STOP_REASON } from "./orgState.ts";
import { resolveLead } from "./LeadMemory.ts";
import { quote } from "./LeadPrompt.ts";
import { buildBrief, Quoted, reportFormat } from "./workerBrief.ts";
import * as WorkerEnvironment from "./workerEnvironment.ts";
import { endedStatuses, WorkerTracker } from "./WorkerTracker.ts";

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
  environmentId: Schema.NullOr(EnvironmentId),
  projectId: Schema.NullOr(ProjectId),
  startedAt: Schema.Number,
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
  const projects = yield* ProjectService.ProjectService;
  const repositories = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const env = yield* WorkerEnvironment.KinWorkerEnvironment;
  const tracker = yield* WorkerTracker;
  const environment = yield* ServerEnvironment;
  const orchestrator = yield* OrchestratorV2;
  const summary = yield* KinLevels.KinShadowSummary;
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
    const [row] = yield* sql`SELECT models_json AS models, worker_projects_json AS projects,
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
      model_json AS model, report_json AS report, environment_id AS "environmentId",
      project_id AS "projectId", started_at AS "startedAt"
      FROM kin_workers WHERE org_id = ${orgId} AND worker_id = ${workerId} ORDER BY worker_id`;
    if (row === undefined) return yield* missing();
    return yield* decodeWorker(row);
  });
  // The level of the chat the worker's card lives in, so a chat's own cap holds there too.
  const levelOf = (ctx: Lead, chatId: KinChatId | null) =>
    KinLevels.effectiveLevel({
      orgId: ctx.orgId,
      agentId: ctx.agentId,
      chatId: chatId ?? undefined,
    }).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.catchTags({ KinLevelRefused: () => Effect.fail(denied()) }),
    );
  // Below L2 the lead's worker calls become shadow entries for the owner's daily summary.
  const shadow = Effect.fn("KinWorkers.shadow")(function* (
    ctx: Lead,
    level: KinLevel,
    tool: string,
    input: unknown,
    target: string,
  ) {
    const entry = yield* KinLevels.recordShadow({
      orgId: ctx.orgId,
      agentId: ctx.agentId,
      threadId: ctx.threadId,
      level,
      unlocksLevel: "L2",
      tool,
      input,
      wouldTarget: target,
    }).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.catchTags({
        KinLevelRefused: (error) =>
          Effect.fail(
            error.reason === "limit"
              ? new KinChatError({
                  reason: "limit",
                  message: KinLevels.SHADOW_LIMIT_MESSAGE,
                })
              : denied(),
          ),
      }),
    );
    if (entry.created) yield* summary.refresh({ orgId: ctx.orgId, agentId: ctx.agentId });
    return { shadowed: true as const, entryId: entry.entryId };
  });
  /** Where new work may start; workers never run on this server. */
  const admit = Effect.fn("KinWorkers.admit")(function* (orgId: KinOrgId) {
    if (Option.isNone(env.environmentId))
      return yield* denied(
        "This Kin host has no worker environment, so workers can't start. Tell the owner.",
      );
    if (yield* isOrgPaused(orgId).pipe(Effect.provideService(SqlClient.SqlClient, sql)))
      return yield* denied("Kin is paused by the owner. Nothing new starts until they resume.");
    if (!(yield* budget.admitWorker(orgId)))
      return yield* new KinChatError({
        reason: "limit",
        message:
          "Today's worker budget is used up. Tell the owner; workers can start again after the daily reset or a higher limit.",
      });
    return env.environmentId.value;
  });
  /** The worker environment refused or could not be reached; its message says which. */
  const there =
    (fallback: string) =>
    <A, R>(effect: Effect.Effect<A, OrchestratorMcpFailure, R>) =>
      effect.pipe(
        Effect.tapError((error) =>
          Effect.logWarning("Kin worker environment call failed", { code: error.code }),
        ),
        Effect.mapError(
          (error) =>
            new KinChatError({
              reason: "unavailable",
              message: `${fallback} The worker environment said: ${error.message}`.slice(0, 2_000),
            }),
        ),
      );
  const pick = Effect.fn("KinWorkers.pick")(function* (
    model: typeof WorkerModel.Type | undefined,
    configured: typeof LeadRow.Type.models,
  ) {
    return model === undefined || model === "strong"
      ? configured.strong
      : model === "cheap"
        ? configured.cheap
        : yield* decodeSelection(model).pipe(Effect.mapError(() => denied()));
  });
  /** The instance there must be Claude Code or Codex, whatever it is called there. */
  const supported = Effect.fn("KinWorkers.supported")(function* (
    environmentId: EnvironmentId,
    chosen: ModelSelection,
  ) {
    const capabilities = yield* env
      .call(environmentId, WorkerEnvironment.tools.capabilities, {})
      .pipe(there("The worker could not start."));
    const instance = capabilities.providers.find(
      (provider) => provider.providerInstanceId === chosen.instanceId,
    );
    if (instance === undefined || !supportedDrivers.has(instance.driverKind))
      return yield* denied("Kin workers run on an enabled Claude Code or Codex provider only.");
  });
  /** The worker environment's project for the same repository as this host's worker project. */
  const projectThere = Effect.fn("KinWorkers.projectThere")(function* (
    environmentId: EnvironmentId,
    projectId: ProjectId,
  ) {
    const here = yield* projects.getById(projectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );
    const key =
      here === undefined
        ? undefined
        : (yield* repositories.resolve(here.workspaceRoot))?.canonicalKey;
    if (key === undefined)
      return yield* denied(
        "That worker project has no repository Kin can match in the worker environment.",
      );
    const matches: Array<ProjectId> = [];
    let cursor: number | null = 0;
    while (cursor !== null) {
      const page: Tool.Success<typeof WorkerEnvironment.tools.projects> = yield* env
        .call(environmentId, WorkerEnvironment.tools.projects, { cursor, limit: 100 })
        .pipe(there("The worker could not start."));
      for (const project of page.projects)
        if (project.repositoryIdentity?.canonicalKey === key) matches.push(project.id);
      cursor = page.nextCursor;
    }
    if (matches.length !== 1)
      return yield* denied(
        matches.length === 0
          ? "The worker environment has no project for this repository. Tell the owner."
          : "The worker environment has several projects for this repository. Tell the owner.",
      );
    return matches[0]!;
  });
  /** The stop fan-out misses a run that starts during its pass; a pause seen after the launch or send stops it. */
  const stopIfPaused = Effect.fn("KinWorkers.stopIfPaused")(function* (
    orgId: KinOrgId,
    target: {
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
      readonly key: string;
    },
  ) {
    if (!(yield* isOrgPaused(orgId).pipe(Effect.provideService(SqlClient.SqlClient, sql)))) return;
    yield* WorkerEnvironment.stopThere(env, { ...target, reason: STOP_REASON }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Kin could not stop a worker started during a pause", { cause }),
      ),
    );
  });
  const threadLink = (environmentId: EnvironmentId, threadId: ThreadId) =>
    formatThreadLink({ environmentId, threadId });
  // Cards are best effort: a launched worker must not fail because its card could not be shown.
  const showCard = Effect.fn("KinWorkers.showCard")(
    function* (input: {
      readonly orgId: KinOrgId;
      readonly chatId: KinChatId;
      readonly agentId: KinAgentId;
      readonly threadId: ThreadId;
      readonly environmentId: EnvironmentId;
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
          remote: { environmentId: input.environmentId, status: "working" },
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
        const chatId =
          event._tag === "chat.message" ||
          event._tag === "widget.action" ||
          event._tag === "chat.reaction"
            ? event.chatId
            : config.ownerChatId;
        return { config, event, author, chatId, level: yield* levelOf(ctx, chatId) };
      }),
    );
    const modelSelection = yield* pick(input.model, plan.config.models);
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
    if (!KinLevels.atLeast(plan.level, "L2"))
      return yield* shadow(ctx, plan.level, "kin_delegate", input, input.projectId);
    const environmentId = yield* admit(ctx.orgId);
    yield* supported(environmentId, modelSelection);
    const projectId = yield* projectThere(environmentId, input.projectId);
    const items =
      reviewRefs !== undefined
        ? []
        : yield* Effect.forEach(input.memoryItemIds ?? [], (id) =>
            memory.readItemQuietly(ctx.orgId, id, { lead: ctx.agentId }).pipe(
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
    const chatId = plan.chatId;
    // The row exists before the launch there, so a crash between them is found at the next start.
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* lead(scope);
        if (input.reviewOf !== undefined) yield* worker(ctx.orgId, input.reviewOf);
        const startedAt = yield* Clock.currentTimeMillis;
        const inserted = yield* sql`INSERT INTO kin_workers (worker_id, org_id, agent_id, wakeup_id,
          kind, thread_id, review_of, model_json, provenance_json, status, report_json, started_at,
          ended_at, title, chat_id, project_id) VALUES (${workerId}, ${ctx.orgId}, ${ctx.agentId},
          ${ctx.wakeupId}, ${input.kind}, ${`kin-worker-${workerId}`}, ${input.reviewOf ?? null},
          ${yield* encodeJson(modelSelection)}, ${yield* encodeJson(plan.event.provenance)}, 'queued',
          NULL, ${startedAt}, NULL, ${input.title}, ${chatId}, ${input.projectId})
          ON CONFLICT DO NOTHING RETURNING worker_id`;
        if (inserted.length === 0) {
          const stored = yield* worker(ctx.orgId, workerId);
          if (stored.wakeupId !== ctx.wakeupId) return yield* denied();
          yield* sql`UPDATE kin_workers SET status = 'queued', started_at = ${startedAt}, ended_at = NULL
            WHERE org_id = ${ctx.orgId} AND worker_id = ${workerId} AND status = 'failed'`;
        }
      }),
    );
    // The same request id there makes a retry return the thread the first launch started.
    const launched = yield* env
      .call(environmentId, WorkerEnvironment.tools.launch, {
        projectId,
        title: input.title,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: {
          type: "worktree",
          baseRef: input.baseRef ?? "origin/HEAD",
          startFromOrigin: true,
        },
        message: brief,
        clientRequestId: `kin-worker:${workerId}`,
      })
      .pipe(
        Effect.tapError(() =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            yield* sql`UPDATE kin_workers SET status = 'failed', ended_at = ${now}
              WHERE org_id = ${ctx.orgId} AND worker_id = ${workerId} AND status = 'queued'`;
          }).pipe(Effect.ignore),
        ),
        there("The worker could not start. Retry the same call or tell the owner."),
      );
    const threadId = launched.threadId;
    yield* sql`UPDATE kin_workers SET environment_id = ${environmentId}, thread_id = ${threadId}
      WHERE org_id = ${ctx.orgId} AND worker_id = ${workerId}`;
    yield* stopIfPaused(ctx.orgId, {
      environmentId,
      threadId,
      key: `kin-stop-launch:${workerId}:${launched.runId ?? "idle"}`,
    });
    const live = launched.status === null || !endedStatuses.has(launched.status);
    yield* showCard({
      orgId: ctx.orgId,
      chatId,
      agentId: ctx.agentId,
      threadId,
      environmentId,
      title: input.title,
      model: modelSelection.model,
      reopen: live,
    });
    yield* tracker.track(ctx.orgId, workerId);
    return { workerId, threadLink: threadLink(environmentId, threadId) };
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
        return { config, worker: stored, level: yield* levelOf(ctx, stored.chatId) };
      }),
    );
    if (!KinLevels.atLeast(plan.level, "L2"))
      return yield* shadow(ctx, plan.level, "kin_follow_up", input, input.workerId);
    yield* admit(ctx.orgId);
    if (plan.worker.projectId === null || !plan.config.projects.includes(plan.worker.projectId))
      return yield* denied("Workers may only run in this lead's worker projects.");
    // A worker runs where it was launched, even after the host names another environment.
    if (plan.worker.environmentId === null)
      return yield* denied("That worker never started. Start a new one with kin_delegate.");
    const environmentId = plan.worker.environmentId;
    const key = (yield* hash({ wakeupId: ctx.wakeupId, input })).slice(0, 32);
    const sent = yield* env
      .call(environmentId, WorkerEnvironment.tools.send, {
        threadId: plan.worker.threadId,
        message: [
          "Follow-up from Kin. Continue this task yourself.",
          input.brief,
          ...(input.quoted ?? []).map((item) => quote("quoted text (untrusted)", item, true)),
          reportFormat,
        ].join("\n\n"),
        mode: "queue",
        clientRequestId: `kin-follow-up:${key}`,
      })
      .pipe(there("The follow-up could not be sent. Retry the same call or tell the owner."));
    // A new started_at marks newer work, so a follower still reporting the last run can't close it.
    yield* sql`UPDATE kin_workers SET status = 'queued', ended_at = NULL,
      started_at = ${yield* Clock.currentTimeMillis}
      WHERE org_id = ${ctx.orgId} AND worker_id = ${input.workerId}`;
    yield* stopIfPaused(ctx.orgId, {
      environmentId,
      threadId: plan.worker.threadId,
      key: `kin-stop-launch:${input.workerId}:${sent.runId}`,
    });
    if (plan.worker.chatId !== null)
      yield* showCard({
        orgId: ctx.orgId,
        chatId: plan.worker.chatId,
        agentId: plan.worker.agentId,
        threadId: plan.worker.threadId,
        environmentId,
        title: plan.worker.title ?? "Worker",
        model: plan.worker.model.model,
        reopen: true,
      });
    yield* tracker.track(ctx.orgId, input.workerId);
    return {
      workerId: input.workerId,
      threadLink: threadLink(environmentId, plan.worker.threadId),
    };
  }, guarded("KinWorkers.followUp"));

  const stop = Effect.fn("KinWorkers.stop")(function* (
    scope: McpInvocationScope,
    input: typeof StopInput.Type,
  ) {
    const ctx = yield* lead(scope);
    const record = yield* sql.withTransaction(worker(ctx.orgId, input.workerId));
    if (record.environmentId === null) return { workerId: input.workerId, stopped: false };
    const environmentId = record.environmentId;
    // A follow-up in the same wake-up starts a new run, which a second stop must still reach.
    const stopped = yield* WorkerEnvironment.stopThere(env, {
      environmentId,
      threadId: record.threadId,
      key: `kin-worker-stop:${input.workerId}:${ctx.wakeupId}:${record.startedAt}`,
      reason: input.reason ?? "Stopped by the Kin lead.",
    }).pipe(there("The worker could not be stopped. Retry or tell the owner."));
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
    return { workerId: input.workerId, stopped: stopped.status === "interrupt_requested" };
  }, guarded("KinWorkers.stop"));

  return KinWorkers.of({ delegate, followUp, stop });
});

export const layer = Layer.effect(KinWorkers, make);
