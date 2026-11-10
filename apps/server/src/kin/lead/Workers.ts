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
import { buildBrief, publishNote, Quoted, reportFormat } from "./workerBrief.ts";
import * as WorkerEnvironment from "./workerEnvironment.ts";
import { publishBranch } from "./workerPublish.ts";
import { endedStatuses, launchRequestId, unboundThreadId, WorkerTracker } from "./WorkerTracker.ts";

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
export const DelegateResult = Schema.Struct({ workerId: KinWorkerId, threadLink: Schema.String });
export const StopResult = Schema.Struct({ workerId: KinWorkerId, stopped: Schema.Boolean });

const supportedDrivers = new Set([
  ProviderDriverKind.make("claudeAgent"),
  ProviderDriverKind.make("codex"),
]);
const denied = (message = "Worker operation is not allowed.") =>
  new KinChatError({ reason: "not_allowed", message });
// Below L2 in the worker's chat: nothing starts, and the lead hears it in plain words.
const NOT_OPEN =
  "Starting work isn't open to you in this chat. Nothing started; tell the owner what you would do.";
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
const bound = (worker: { readonly workerId: KinWorkerId; readonly threadId: ThreadId }) =>
  worker.threadId !== unboundThreadId(worker.workerId);
/** Transport failures and timeouts; a refusal there carries the code it was refused with. */
const isAmbiguous = (error: OrchestratorMcpFailure) => error.code === "orchestration_error";

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
  /** The lead's own worker; another lead's, even in the same org, reads as not found. */
  const worker = Effect.fn("KinWorkers.worker")(function* (ctx: Lead, workerId: KinWorkerId) {
    const [row] = yield* sql`SELECT worker_id AS "workerId", kind, agent_id AS "agentId",
      wakeup_id AS "wakeupId", thread_id AS "threadId", title, chat_id AS "chatId",
      model_json AS model, report_json AS report, environment_id AS "environmentId",
      project_id AS "projectId", started_at AS "startedAt"
      FROM kin_workers WHERE org_id = ${ctx.orgId} AND agent_id = ${ctx.agentId}
        AND worker_id = ${workerId} ORDER BY worker_id`;
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
        Effect.mapError((error) => {
          const { known, untrusted } = WorkerEnvironment.describeFailure(error);
          return new KinChatError({
            reason: "unavailable",
            message: `${fallback} ${known} Its own words:\n${quote("worker environment error (untrusted)", untrusted, true)}`,
          });
        }),
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
    for (let page = 0; cursor !== null; page++) {
      if (page === WorkerEnvironment.MAX_PAGES)
        return yield* denied("The worker environment's project list didn't end. Tell the owner.");
      const listed: Tool.Success<typeof WorkerEnvironment.tools.projects> = yield* env
        .call(environmentId, WorkerEnvironment.tools.projects, { cursor, limit: 100 })
        .pipe(there("The worker could not start."));
      for (const project of listed.projects)
        if (project.repositoryIdentity?.canonicalKey === key) matches.push(project.id);
      if (listed.nextCursor !== null && listed.nextCursor <= cursor)
        return yield* denied("The worker environment's project list didn't end. Tell the owner.");
      cursor = listed.nextCursor;
    }
    if (matches.length !== 1)
      return yield* denied(
        matches.length === 0
          ? "The worker environment has no project for this repository. Tell the owner."
          : "The worker environment has several projects for this repository. Tell the owner.",
      );
    return { projectId: matches[0]!, repositoryKey: key };
  });
  /**
   * The stop fan-out misses a run that starts during its pass; a pause seen after the launch or
   * send stops it, and stops the worker server again.
   */
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
        Effect.logWarning("Kin's stop there went unanswered during a pause", { cause }),
      ),
    );
    yield* env.stopServer.pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Kin could not stop the worker server during a pause", { cause }),
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
          input.reviewOf === undefined ? undefined : yield* worker(ctx, input.reviewOf);
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
    if (!KinLevels.atLeast(plan.level, "L2")) return yield* denied(NOT_OPEN);
    const environmentId = yield* admit(ctx.orgId);
    yield* supported(environmentId, modelSelection);
    const { projectId, repositoryKey } = yield* projectThere(environmentId, input.projectId);
    const items =
      reviewRefs !== undefined
        ? []
        : yield* Effect.forEach(input.memoryItemIds ?? [], (id) =>
            memory.readItemQuietly(ctx.orgId, id, { lead: ctx.agentId }).pipe(
              Effect.map((item) => ({ id, title: item.head.title, body: item.body })),
              Effect.mapError(() => missing()),
            ),
          );
    const workerId = KinWorkerId.make(
      `wk-${(yield* hash({ wakeupId: ctx.wakeupId, input })).slice(0, 32)}`,
    );
    const branch = input.kind === "build" ? publishBranch(workerId) : undefined;
    const brief =
      reviewRefs !== undefined
        ? buildBrief({ goal: input.goal, reviewRefs })
        : buildBrief({
            goal: input.goal,
            brief: input.brief,
            ...(input.quoted === undefined ? {} : { quoted: input.quoted }),
            ...(branch === undefined ? {} : { branch }),
            memory: items,
          });
    const chatId = plan.chatId;
    // The row exists before the launch there, so a crash between them is found at the next start.
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* lead(scope);
        if (input.reviewOf !== undefined) yield* worker(ctx, input.reviewOf);
        const startedAt = yield* Clock.currentTimeMillis;
        // The environment is written now, so a launch whose reply is lost can be found there.
        const inserted = yield* sql`INSERT INTO kin_workers (worker_id, org_id, agent_id, wakeup_id,
          kind, thread_id, review_of, model_json, provenance_json, status, report_json, started_at,
          ended_at, title, chat_id, project_id, environment_id, remote_project_id, repository_key)
          VALUES (${workerId}, ${ctx.orgId}, ${ctx.agentId}, ${ctx.wakeupId}, ${input.kind},
          ${unboundThreadId(workerId)}, ${input.reviewOf ?? null},
          ${yield* encodeJson(modelSelection)}, ${yield* encodeJson(plan.event.provenance)}, 'queued',
          NULL, ${startedAt}, NULL, ${input.title}, ${chatId}, ${input.projectId}, ${environmentId},
          ${projectId}, ${repositoryKey})
          ON CONFLICT (worker_id) DO NOTHING RETURNING worker_id`;
        if (inserted.length === 0) {
          const stored = yield* worker(ctx, workerId);
          if (stored.wakeupId !== ctx.wakeupId) return yield* denied();
          yield* sql`UPDATE kin_workers SET status = 'queued', started_at = ${startedAt}, ended_at = NULL,
              remote_project_id = ${projectId}, repository_key = ${repositoryKey},
              environment_id = CASE WHEN thread_id = ${unboundThreadId(workerId)}
                THEN ${environmentId} ELSE environment_id END
            WHERE org_id = ${ctx.orgId} AND worker_id = ${workerId} AND status = 'failed'`;
        }
      }),
    );
    // The same request id there makes a retry return the thread the first launch started.
    const launch = env.call(environmentId, WorkerEnvironment.tools.launch, {
      projectId,
      title: input.title,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: {
        type: "worktree",
        baseRef: input.baseRef ?? "origin/HEAD",
        startFromOrigin: true,
        ...(branch === undefined ? {} : { branch }),
      },
      message: brief,
      clientRequestId: launchRequestId(workerId),
    });
    const launched = yield* launch.pipe(
      // A lost reply or a timeout may follow a launch that happened; asking again finds it.
      Effect.catchIf(isAmbiguous, () => launch),
      Effect.catchIf(isAmbiguous, (error) =>
        Effect.gen(function* () {
          // Still open, so pause and the tracker cover it; the follower asks there until it
          // finds the thread or learns there is none.
          yield* Effect.logWarning("Kin worker launch unconfirmed", { code: error.code });
          yield* tracker.track(ctx.orgId, workerId);
          return yield* new KinChatError({
            reason: "unavailable",
            message:
              "The worker environment didn't confirm the launch. Kin keeps checking and reports what it finds; retrying the same call is safe.",
          });
        }),
      ),
      Effect.tapError((error) =>
        isChatError(error)
          ? Effect.void
          : Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;
              // A plain refusal started nothing, so there is nothing there to look for.
              yield* sql`UPDATE kin_workers SET status = 'failed', ended_at = ${now},
                  remote_project_id = NULL
                WHERE org_id = ${ctx.orgId} AND worker_id = ${workerId} AND status = 'queued'
                  AND thread_id = ${unboundThreadId(workerId)}`;
            }).pipe(Effect.ignore),
      ),
      Effect.catchTags({
        OrchestratorMcpFailure: (error) =>
          Effect.fail(error).pipe(
            there("The worker could not start. Retry the same call or tell the owner."),
          ),
      }),
    );
    const threadId = launched.threadId;
    yield* sql`UPDATE kin_workers SET thread_id = ${threadId}
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
        const stored = yield* worker(ctx, input.workerId);
        // A reviewer sees only the author's refs; more lead text would end that isolation.
        if (stored.kind === "review")
          return yield* denied(
            "Review workers take no follow-ups. Start a new review with kin_delegate.",
          );
        return { config, worker: stored, level: yield* levelOf(ctx, stored.chatId) };
      }),
    );
    if (!KinLevels.atLeast(plan.level, "L2")) return yield* denied(NOT_OPEN);
    yield* admit(ctx.orgId);
    if (plan.worker.projectId === null || !plan.config.projects.includes(plan.worker.projectId))
      return yield* denied("Workers may only run in this lead's worker projects.");
    // A worker runs where it was launched, even after the host names another environment.
    if (plan.worker.environmentId === null || !bound(plan.worker))
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
          ...(plan.worker.kind === "build" ? [publishNote(publishBranch(input.workerId))] : []),
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
    const record = yield* sql.withTransaction(worker(ctx, input.workerId));
    if (record.environmentId === null || !bound(record))
      return { workerId: input.workerId, stopped: false };
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
