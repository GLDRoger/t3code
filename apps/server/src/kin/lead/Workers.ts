import {
  EnvironmentId,
  KinAgentId,
  KinChatError,
  KinChatId,
  KinEvent,
  KinMemoryItemId,
  KinOrgId,
  KinPersonId,
  KinRecordKey,
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
import { KinChatService } from "../chat/KinChatService.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import * as Memory from "../memory/Memory.ts";
import { configuredRepositories } from "../memory/MemoryConfig.ts";
import { sourceControlDefinitions } from "../../sourceControl/sourceControlDefinitions.ts";
import { KinGithubRepoScope } from "../triggers/githubEvents.ts";
import { KinBudget } from "./KinBudget.ts";
import * as KinLevels from "./KinLevels.ts";
import { SHARED_REFUSAL, destination, effectiveAudience, turnChat } from "./Audience.ts";
import { workerChat } from "./ChatSharing.ts";
import { KinRecords } from "../work/KinRecords.ts";
import { attemptBegun, noteSensitivity, workerMayResume } from "../work/workerAttempts.ts";
import { WORK_NOT_YOURS, workMayStart, workerStarted } from "../work/workerEntries.ts";
import { sharedTurnMayTouch, toolAdmitted } from "./SharedTools.ts";
import { isOrgPaused, STOP_REASON } from "./orgState.ts";
import { resolveLead } from "./LeadMemory.ts";
import { quote } from "./LeadPrompt.ts";
import { LOCAL_BUILD_ONLY, makeLocalDelegate } from "./localWorkers.ts";
import { buildBrief, publishNote, Quoted, reportFormat } from "./workerBrief.ts";
import * as WorkerEnvironment from "./workerEnvironment.ts";
import {
  labelOf,
  reachableKeys,
  resolveProject,
  type Checkout,
  type HostProject,
} from "./workerProjects.ts";
import { publishBranch } from "./workerPublish.ts";
import { localThreadId } from "./workThread.ts";
import {
  endedStatuses,
  launchRequestId,
  STOPPED_BEFORE_START,
  unboundThreadId,
  WITHDRAWN_REASON,
  WorkerTracker,
} from "./WorkerTracker.ts";

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
  project: TrimmedNonEmptyString.check(Schema.isMaxLength(200)).annotate({
    description:
      "Where the work happens, in plain words: a project or repository name such as t3code, or owner/name. Never an id you were not given.",
  }),
  baseRef: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(WorkerModel),
  memoryItemIds: Schema.optional(Schema.Array(KinMemoryItemId).check(Schema.isMaxLength(20))),
  reviewOf: Schema.optional(KinWorkerId),
  entry: Schema.optional(KinRecordKey).annotate({
    description:
      "The Work entry this works on, such as W-12. Without one, Kin tracks the worker as a new entry of yours.",
  }),
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
export const DelegateResult = Schema.Struct({
  workerId: KinWorkerId,
  threadLink: Schema.String,
  /** The repository or project the name resolved to, as the owner would call it. */
  project: Schema.optional(Schema.String),
});
export const StopResult = Schema.Struct({ workerId: KinWorkerId, stopped: Schema.Boolean });

const supportedDrivers = new Set([
  ProviderDriverKind.make("claudeAgent"),
  ProviderDriverKind.make("codex"),
]);
const denied = (message = "Worker operation is not allowed.") =>
  new KinChatError({ reason: "not_allowed", message });
// Below L2 in a chat the work touches: nothing starts, and the lead hears it in plain words.
const NOT_OPEN =
  "Starting work isn't open to you in this chat. Nothing started; tell the owner what you would do.";
// What a lead hears when work can't start: what is true, that nothing started, and what it can
// still do. None of it blames the lead's own setup or sends the owner to reconfigure it.
const STILL =
  "Nothing started. Say so once, in one line, and don't ask the owner to change your setup. You can still read repos, pull requests and CI yourself, or answer from memory.";
const NO_ENVIRONMENT = `Coding work can't start yet: this host's worker environment isn't set up. That is a one-time step on the host, not a fault in you or in this request. ${STILL}`;
const PAUSED = `Kin is paused by the owner, so no new work starts until they resume it. ${STILL}`;
const OVER_BUDGET = `Today's budget for coding work is used up, so this waits for the daily reset or a higher limit. ${STILL}`;
const NOT_HERE = `Work can't start in that project from this chat. ${STILL}`;
const NO_MEMORY_CONFIG = `Coding work can't start right now: Kin couldn't read which repository holds its memory on this host, and no worker may ever work in that one. That is a step on the host, not a fault in you or in this request. ${STILL}`;
const REVIEW_ELSEWHERE =
  "A review runs in the same repository as the work it reviews. Nothing started. Call again naming that repository as the project.";
const noCheckout = (label: string) =>
  new KinChatError({
    reason: "unavailable",
    message: `${label} has no checkout in the worker environment yet, so work can't start in it. That is a step on the host, not a fault in you or in this request. ${STILL}`,
  });
const RETRY = "Nothing started. Call again with one of those names, or ask which one is meant.";
const missing = () => new KinChatError({ reason: "not_found", message: "Kin record not found." });
const unavailable = () =>
  new KinChatError({ reason: "unavailable", message: "Kin workers are unavailable." });
const unending = () =>
  new KinChatError({
    reason: "unavailable",
    message: `The worker environment's project list didn't end, so Kin couldn't find the project. ${STILL}`,
  });
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
  ownerPersonId: KinPersonId,
  createdBy: Schema.NullOr(KinPersonId),
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
  repositoryKey: Schema.NullOr(Schema.String),
  startedAt: Schema.Number,
});
const PasserRow = Schema.Struct({
  projects: Schema.fromJsonString(Schema.Array(ProjectId)),
  ownerPersonId: KinPersonId,
  createdBy: Schema.NullOr(KinPersonId),
});
const decodeLead = Schema.decodeUnknownEffect(LeadRow);
const decodePasser = Schema.decodeUnknownEffect(PasserRow);
const decodeWorker = Schema.decodeUnknownEffect(WorkerRow);
const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(KinEvent));
/** The chat that asked; other events answer in the owner chat, as the reply bridge does. */
const askingChat = (event: KinEvent, ownerChatId: KinChatId) =>
  event._tag === "chat.message" || event._tag === "widget.action" || event._tag === "chat.reaction"
    ? event.chatId
    : ownerChatId;
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
  const connected = yield* KinGithubRepoScope;
  // Org memory is never a place for a worker, whoever checked it out there, on any host. Read by
  // the key the worker environment reports; unreadable, no work starts anywhere.
  const memoryRepos = yield* configuredRepositories.pipe(
    Effect.map(
      (repositories) =>
        new Set(
          repositories.map(({ repoUrl }) =>
            sourceControlDefinitions.repositoryKeyFromRemote(repoUrl).toLowerCase(),
          ),
        ),
    ),
    Effect.tapError(() =>
      Effect.logWarning("Kin memory repositories are unreadable; no work starts"),
    ),
    Effect.option,
  );
  const memoryKeys = Effect.fromOption(memoryRepos).pipe(
    Effect.mapError(() => new KinChatError({ reason: "unavailable", message: NO_MEMORY_CONFIG })),
  );
  const env = yield* WorkerEnvironment.KinWorkerEnvironment;
  const tracker = yield* WorkerTracker;
  const records = yield* KinRecords;
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
    const [row] = yield* sql`SELECT l.models_json AS models, l.worker_projects_json AS projects,
      l.owner_chat_id AS "ownerChatId", a.owner_person_id AS "ownerPersonId",
      l.created_by_person_id AS "createdBy"
      FROM kin_leads l JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
      WHERE l.org_id = ${ctx.orgId} AND l.agent_id = ${ctx.agentId} ORDER BY l.agent_id`;
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
      project_id AS "projectId", repository_key AS "repositoryKey", started_at AS "startedAt"
      FROM kin_workers WHERE org_id = ${ctx.orgId} AND agent_id = ${ctx.agentId}
        AND worker_id = ${workerId} ORDER BY worker_id`;
    if (row === undefined) return yield* missing();
    return yield* decodeWorker(row);
  });
  /**
   * Whether every chat the work touches is open to it: the chat that asked, the chats its due
   * deferrals were asked from, and the chats of the workers it reaches. A chat's own cap holds
   * there, and a weaker chat can't reach a worker placed in a stronger one.
   */
  const open = Effect.fn("KinWorkers.open")(function* (
    ctx: Lead,
    chats: ReadonlyArray<KinChatId | null>,
  ) {
    const cap = yield* KinLevels.originCap(ctx).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
    if (cap !== undefined && !KinLevels.atLeast(cap, "L2")) return false;
    for (const chatId of chats) {
      const level = yield* KinLevels.effectiveLevel({
        orgId: ctx.orgId,
        agentId: ctx.agentId,
        chatId: chatId ?? undefined,
      }).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.catchTags({ KinLevelRefused: () => Effect.fail(denied()) }),
      );
      if (!KinLevels.atLeast(level, "L2")) return false;
    }
    return true;
  });
  /** What another lead brings to a request it passed on: its own reach rules, read the same way. */
  const passer = Effect.fn("KinWorkers.passer")(function* (orgId: KinOrgId, agentId: KinAgentId) {
    const [row] = yield* sql`SELECT l.worker_projects_json AS projects,
        a.owner_person_id AS "ownerPersonId", l.created_by_person_id AS "createdBy"
      FROM kin_leads l JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
      WHERE l.org_id = ${orgId} AND l.agent_id = ${agentId}
        AND a.role = 'lead' AND a.retired_at IS NULL ORDER BY l.agent_id`;
    return row === undefined ? undefined : yield* decodePasser(row);
  });
  /**
   * `all`, the owner's reach, needs this lead and any that passed the request on to be the host
   * owner's own, placed by the owner in every chat the work touches or it was first asked in.
   * Else `listed`: the projects on every such lead's list, so no chat or hand-off gains reach.
   */
  const reach = Effect.fn("KinWorkers.reach")(
    function* (ctx: Lead, config: typeof LeadRow.Type, chats: ReadonlyArray<KinChatId | null>) {
      const { owner } = identity;
      const origins = yield* KinLevels.origins(ctx);
      const passers = yield* Effect.forEach(
        [...new Set(origins.map((origin) => origin.agentId))].filter((id) => id !== ctx.agentId),
        (agentId) => passer(ctx.orgId, agentId),
      );
      const projects = passers.reduce<ReadonlyArray<ProjectId>>(
        (held, other) =>
          other === undefined ? [] : held.filter((id) => other.projects.includes(id)),
        config.projects,
      );
      const listed = { _tag: "listed" as const, projects };
      const ownersOwn = (lead: typeof PasserRow.Type | undefined) =>
        lead !== undefined &&
        lead.ownerPersonId === owner.personId &&
        (lead.createdBy === null || lead.createdBy === owner.personId);
      if (ctx.orgId !== owner.orgId || ![config, ...passers].every(ownersOwn)) return listed;
      // The owner's reach is for what the owner asked; a teammate's message never borrows it.
      if (!(yield* KinLevels.ownerAlone(ctx))) return listed;
      const asked = [...chats.map((chatId) => ({ agentId: ctx.agentId, chatId })), ...origins];
      for (const { agentId, chatId } of asked)
        if (chatId === null || !(yield* KinLevels.ownerPlaced(ctx.orgId, { agentId, chatId })))
          return listed;
      return { _tag: "all" as const };
    },
    Effect.provideService(SqlClient.SqlClient, sql),
  );
  /** Where new work may start; workers never run on this server. */
  const admit = Effect.fn("KinWorkers.admit")(function* (orgId: KinOrgId) {
    // Not a permission: nothing the lead or the owner's chat settings can change.
    if (Option.isNone(env.environmentId))
      return yield* new KinChatError({ reason: "unavailable", message: NO_ENVIRONMENT });
    if (yield* isOrgPaused(orgId).pipe(Effect.provideService(SqlClient.SqlClient, sql)))
      return yield* denied(PAUSED);
    if (!(yield* budget.admitWorker(orgId)))
      return yield* new KinChatError({ reason: "limit", message: OVER_BUDGET });
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
  /** The worker environment's projects that have a repository, read a bounded number of pages. */
  const checkouts = Effect.fn("KinWorkers.checkouts")(function* (environmentId: EnvironmentId) {
    const memory = yield* memoryKeys;
    const found: Array<Checkout> = [];
    let cursor: number | null = 0;
    for (let page = 0; cursor !== null; page++) {
      if (page === WorkerEnvironment.MAX_PAGES) return yield* unending();
      const listed: Tool.Success<typeof WorkerEnvironment.tools.projects> = yield* env
        .call(environmentId, WorkerEnvironment.tools.projects, { cursor, limit: 100 })
        .pipe(there("The worker could not start."));
      for (const project of listed.projects) {
        const repository = project.repositoryIdentity;
        if (
          repository == null ||
          [repository.canonicalKey, repository.origin?.canonicalKey].some(
            (key) => key !== undefined && memory.has(key.toLowerCase()),
          )
        )
          continue;
        found.push({
          projectId: project.id,
          title: project.title,
          repositoryKey: repository.canonicalKey,
          slug:
            repository.owner === undefined || repository.name === undefined
              ? undefined
              : `${repository.owner}/${repository.name}`,
        });
      }
      if (listed.nextCursor !== null && listed.nextCursor <= cursor) return yield* unending();
      cursor = listed.nextCursor;
    }
    return found;
  });
  /** This host's projects, which a lead may name and a list names. Unreadable reads as none. */
  const hostProjects = Effect.fn("KinWorkers.hostProjects")(
    function* () {
      const found: Array<HostProject> = [];
      let cursor: number | null = 0;
      for (let page = 0; cursor !== null && page < WorkerEnvironment.MAX_PAGES; page++) {
        const listed: Effect.Success<ReturnType<typeof projects.listPage>> =
          yield* projects.listPage({
            cursor,
            limit: 100,
          });
        for (const project of listed.projects)
          found.push({
            projectId: project.id,
            title: project.title,
            repositoryKey: project.repositoryIdentity?.canonicalKey,
            root: project.workspaceRoot,
          });
        cursor =
          listed.nextCursor !== null && listed.nextCursor > cursor ? listed.nextCursor : null;
      }
      return found;
    },
    Effect.orElseSucceed((): Array<HostProject> => []),
  );
  const reachable = Effect.fn("KinWorkers.reachable")(function* (
    allowed: ReadonlyArray<ProjectId> | undefined,
  ) {
    return reachableKeys({
      hostProjects: yield* hostProjects(),
      connectedRepos: connected.repos,
      allowed,
    });
  });
  /**
   * The checkout a plainly named project or repository means, among those the request reaches:
   * the owner's for `allowed` undefined, else the repositories of those host projects.
   */
  const locate = Effect.fn("KinWorkers.locate")(function* (
    environmentId: EnvironmentId,
    named: string,
    allowed: ReadonlyArray<ProjectId> | undefined,
  ) {
    const found = resolveProject({
      named,
      checkouts: yield* checkouts(environmentId),
      hostProjects: yield* hostProjects(),
      connectedRepos: connected.repos,
      allowed,
    });
    const said = `"${named.slice(0, 80).replaceAll('"', "'")}"`;
    switch (found._tag) {
      case "resolved":
        return found;
      case "outside":
        return yield* denied(NOT_HERE);
      case "no_checkout":
        return yield* noCheckout(found.label);
      case "ambiguous":
        return yield* new KinChatError({
          reason: "invalid_state",
          message: `${said} fits several here: ${found.labels.join(", ")}. ${RETRY}`,
        });
      case "unknown":
        return yield* found.labels.length === 0
          ? noCheckout("No repository")
          : new KinChatError({
              reason: "not_found",
              message: `No project or repository here is called ${said}. Work can start in: ${found.labels.join(", ")}. ${RETRY}`,
            });
    }
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
  /** The chat a worker answers in now (`workerChat`), or `fallback` for a row it can't read. */
  const cardChat = Effect.fn("KinWorkers.cardChat")(function* (
    orgId: KinOrgId,
    workerId: KinWorkerId,
    fallback: KinChatId | null,
  ) {
    const route = yield* workerChat({ orgId, workerId }).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
    return route === undefined
      ? fallback
      : route.chatId === null
        ? null
        : KinChatId.make(route.chatId);
  });
  const threadLink = (environmentId: EnvironmentId, threadId: ThreadId) =>
    formatThreadLink({ environmentId, threadId });
  // Cards are best effort: a launched worker must not fail because its card could not be shown.
  const showCard = Effect.fn("KinWorkers.showCard")(
    function* (
      turn: Lead,
      input: {
        readonly orgId: KinOrgId;
        readonly workerId: KinWorkerId;
        /** The worker's own chat, for a row `workerChat` can't read. */
        readonly fallback: KinChatId | null;
        readonly agentId: KinAgentId;
        readonly threadId: ThreadId;
        readonly environmentId: EnvironmentId;
        readonly title: string;
        readonly model: string;
        /** A closed card reopens only for a worker that is running again. */
        readonly reopen: boolean;
      },
    ) {
      // The lead's words on a card are a post: authorised against the chat in the card's write,
      // and routed there too, as a join during the remote call may have moved the worker.
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const chatId = yield* cardChat(input.orgId, input.workerId, input.fallback);
          if (chatId === null) return;
          const route = yield* workerChat({ orgId: input.orgId, workerId: input.workerId }).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          );
          const audience = route?.audience ?? "owner";
          const where = yield* destination(turn, chatId).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          );
          if (where !== "allowed") return yield* denied(SHARED_REFUSAL);
          const card = yield* chat
            .createTaskCard({
              orgId: input.orgId,
              chatId,
              audience,
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
              chatId,
              audience,
              threadId: input.threadId,
              closed: false,
            });
        }),
      );
    },
    Effect.catchCause((cause) => Effect.logWarning("Kin worker task card unavailable", { cause })),
  );

  // With no worker environment named, work runs on this server, under `localWorkers.ts`' rules.
  const shared = guarded("KinWorkers.local");
  const local = yield* makeLocalDelegate({
    lead: (scope) => shared(lead(scope)),
    leadConfig: (ctx) => shared(leadConfig(ctx)),
    sourceEvent: (ctx, eventId) => shared(sourceEvent(ctx, eventId)),
    open: (ctx, chats) => shared(open(ctx, chats)),
    pick: (model, configured) => shared(pick(model, configured)),
    hash: (value) => shared(hash(value)),
    memoryKeys,
    hostProjects,
    connectedRepos: connected.repos,
    memoryItem: (ctx, id) =>
      memory.readItemQuietly(ctx.orgId, id, { lead: ctx.agentId }).pipe(
        Effect.map((item) => ({ id, title: item.head.title, body: item.body })),
        Effect.mapError(() => missing()),
      ),
  });

  const delegate = Effect.fn("KinWorkers.delegate")(function* (
    scope: McpInvocationScope,
    input: typeof DelegateInput.Type,
  ) {
    if (Option.isNone(env.environmentId)) return yield* local.delegate(scope, input);
    const ctx = yield* lead(scope);
    const plan = yield* sql.withTransaction(
      Effect.gen(function* () {
        const audience = yield* effectiveAudience(ctx).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        );
        // The owner's notes never go to work started where someone else reads, and such a turn
        // reads the report of only a worker it may touch.
        if (
          audience !== "owner_only" &&
          ((input.memoryItemIds?.length ?? 0) > 0 ||
            (input.reviewOf !== undefined &&
              !(yield* sharedTurnMayTouch(ctx, input.reviewOf).pipe(
                Effect.provideService(SqlClient.SqlClient, sql),
              ))))
        )
          return yield* denied(SHARED_REFUSAL);
        const config = yield* leadConfig(ctx);
        const event = yield* sourceEvent(ctx, input.sourceEventId);
        if ((input.kind === "review") !== (input.reviewOf !== undefined))
          return yield* denied("Review workers need reviewOf, and only review workers take it.");
        const author =
          input.reviewOf === undefined ? undefined : yield* worker(ctx, input.reviewOf);
        const chatId = askingChat(event, config.ownerChatId);
        const chats = author === undefined ? [chatId] : [chatId, author.chatId];
        return {
          config,
          event,
          author,
          chatId,
          chats,
          open: yield* open(ctx, chats),
          reach: yield* reach(ctx, config, chats),
        };
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
    if (!plan.open) return yield* denied(NOT_OPEN);
    // The host's state comes first: a lead told "not that project" on a host where nothing can
    // start asks the owner to fix something that was never the cause.
    const environmentId = yield* admit(ctx.orgId);
    yield* supported(environmentId, modelSelection);
    const target = yield* locate(
      environmentId,
      input.project,
      plan.reach._tag === "all" ? undefined : plan.reach.projects,
    );
    const { projectId, repositoryKey } = target.checkout;
    // The author's repository passes the same reach as the request by being the same repository.
    const sameRepository = (author: typeof WorkerRow.Type) =>
      author.repositoryKey?.toLowerCase() === repositoryKey.toLowerCase();
    if (plan.author !== undefined && !sameRepository(plan.author))
      return yield* denied(REVIEW_ELSEWHERE);
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
    const startedAt = yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* lead(scope);
        // The gate's check again where the row is written: a join may have aborted the turn.
        if (
          !(yield* toolAdmitted(ctx, "kin_delegate", input).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          ))
        )
          return yield* denied(SHARED_REFUSAL);
        if (input.reviewOf !== undefined && !sameRepository(yield* worker(ctx, input.reviewOf)))
          return yield* denied(REVIEW_ELSEWHERE);
        // Who the work is for, decided here before anything is sent: an owner-only turn's work
        // stays private wherever its chat goes, and only private work carries the owner's notes.
        const context =
          (yield* effectiveAudience(ctx).pipe(Effect.provideService(SqlClient.SqlClient, sql))) ===
          "owner_only"
            ? "private"
            : "shared";
        if (items.length > 0 && context !== "private") return yield* denied(SHARED_REFUSAL);
        // What was checked before the calls there still holds as the row is written.
        const config = yield* leadConfig(ctx);
        if (!(yield* open(ctx, plan.chats))) return yield* denied(NOT_OPEN);
        const still = yield* reach(ctx, config, plan.chats);
        if (
          still._tag !== plan.reach._tag ||
          (still._tag === "listed" &&
            (target.hostProjectId === null || !still.projects.includes(target.hostProjectId)))
        )
          return yield* denied(NOT_HERE);
        // Here, not before: the owner may have closed or taken back the work since.
        if (
          !(yield* workMayStart({
            orgId: ctx.orgId,
            agentId: ctx.agentId,
            ownerPersonId: config.ownerPersonId,
            wakeupId: ctx.wakeupId,
            event: plan.event,
            ...(input.entry === undefined ? {} : { entryKey: input.entry }),
          }).pipe(Effect.provideService(SqlClient.SqlClient, sql)))
        )
          return yield* denied(WORK_NOT_YOURS);
        const startedAt = yield* Clock.currentTimeMillis;
        // The environment is written now, so a launch whose reply is lost can be found there.
        const inserted = yield* sql`INSERT INTO kin_workers (worker_id, org_id, agent_id, wakeup_id,
          kind, thread_id, review_of, model_json, provenance_json, status, report_json, started_at,
          ended_at, title, chat_id, project_id, environment_id, remote_project_id, repository_key,
          context)
          VALUES (${workerId}, ${ctx.orgId}, ${ctx.agentId}, ${ctx.wakeupId}, ${input.kind},
          ${unboundThreadId(workerId)}, ${input.reviewOf ?? null},
          ${yield* encodeJson(modelSelection)}, ${yield* encodeJson(plan.event.provenance)}, 'queued',
          NULL, ${startedAt}, NULL, ${input.title}, ${chatId}, ${target.hostProjectId}, ${environmentId},
          ${projectId}, ${repositoryKey}, ${context})
          ON CONFLICT (worker_id) DO NOTHING RETURNING worker_id`;
        if (inserted.length > 0)
          yield* attemptBegun({
            orgId: ctx.orgId,
            workerId,
            startedAt,
            agentId: ctx.agentId,
            sourceEventId: input.sourceEventId,
          }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
        if (inserted.length > 0)
          yield* workerStarted({
            orgId: ctx.orgId,
            agentId: ctx.agentId,
            workerId,
            wakeupId: ctx.wakeupId,
            title: input.title,
            reviewOf: input.reviewOf ?? null,
            event: plan.event,
            ...(input.entry === undefined ? {} : { entryKey: input.entry }),
          }).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.provideService(KinRecords, records),
          );
        // The entry it now serves may be sensitive; that sticks to the attempt.
        if (inserted.length > 0)
          yield* noteSensitivity({ orgId: ctx.orgId, workerId, startedAt }).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          );
        if (inserted.length === 0) {
          const stored = yield* worker(ctx, workerId);
          if (stored.wakeupId !== ctx.wakeupId) return yield* denied();
          // A retry restarts the same worker, which the owner may have withdrawn since.
          if (
            !(yield* workerMayResume({ orgId: ctx.orgId, agentId: ctx.agentId, workerId }).pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
            ))
          )
            return yield* denied(WORK_NOT_YOURS);
          const retried =
            yield* sql`UPDATE kin_workers SET status = 'queued', started_at = ${startedAt}, ended_at = NULL,
              remote_project_id = ${projectId}, repository_key = ${repositoryKey},
              context = CASE WHEN context = 'private' THEN 'private' ELSE ${context} END,
              environment_id = CASE WHEN thread_id = ${unboundThreadId(workerId)}
                THEN ${environmentId} ELSE environment_id END
            WHERE org_id = ${ctx.orgId} AND worker_id = ${workerId} AND status = 'failed'
            RETURNING worker_id`;
          if (retried.length === 0) return stored.startedAt;
          yield* attemptBegun({
            orgId: ctx.orgId,
            workerId,
            startedAt,
            agentId: ctx.agentId,
            sourceEventId: input.sourceEventId,
          }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
          return startedAt;
        }
        return startedAt;
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
    const launchBound = launch.pipe(
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
      Effect.tap(
        (launched) =>
          sql`UPDATE kin_workers SET thread_id = ${launched.threadId}
          WHERE org_id = ${ctx.orgId} AND worker_id = ${workerId}`,
      ),
    );
    // A stop that came first means no launch; one during it reaches the thread as it returns.
    const admitted = yield* tracker
      .launch({ orgId: ctx.orgId, workerId, startedAt }, launchBound)
      .pipe(
        Effect.catchTags({
          OrchestratorMcpFailure: (error) =>
            Effect.fail(error).pipe(
              there("The worker could not start. Retry the same call or tell the owner."),
            ),
        }),
      );
    if (Option.isNone(admitted)) return yield* denied(STOPPED_BEFORE_START);
    const launched = admitted.value;
    const threadId = launched.threadId;
    yield* stopIfPaused(ctx.orgId, {
      environmentId,
      threadId,
      key: `kin-stop-launch:${workerId}:${launched.runId ?? "idle"}`,
    });
    const live = launched.status === null || !endedStatuses.has(launched.status);
    yield* showCard(ctx, {
      orgId: ctx.orgId,
      workerId,
      fallback: chatId,
      agentId: ctx.agentId,
      threadId,
      environmentId,
      title: input.title,
      model: modelSelection.model,
      reopen: live,
    });
    yield* tracker.track(ctx.orgId, workerId);
    return {
      workerId,
      threadLink: threadLink(environmentId, threadId),
      project: labelOf(target.checkout),
    };
  }, guarded("KinWorkers.delegate"));

  const followUp = Effect.fn("KinWorkers.followUp")(function* (
    scope: McpInvocationScope,
    input: typeof FollowUpInput.Type,
  ) {
    if (Option.isNone(env.environmentId)) return yield* denied(LOCAL_BUILD_ONLY);
    const ctx = yield* lead(scope);
    const plan = yield* sql.withTransaction(
      Effect.gen(function* () {
        const config = yield* leadConfig(ctx);
        const event = yield* sourceEvent(ctx, input.sourceEventId);
        const stored = yield* worker(ctx, input.workerId);
        // A reviewer sees only the author's refs; more lead text would end that isolation.
        if (stored.kind === "review")
          return yield* denied(
            "Review workers take no follow-ups. Start a new review with kin_delegate.",
          );
        const chats = [askingChat(event, config.ownerChatId), stored.chatId];
        return {
          config,
          event,
          worker: stored,
          open: yield* open(ctx, chats),
          reach: yield* reach(ctx, config, chats),
        };
      }),
    );
    if (!plan.open) return yield* denied(NOT_OPEN);
    yield* admit(ctx.orgId);
    // The rule a new worker there would pass, applied to the repository it was started in.
    const key = plan.worker.repositoryKey?.toLowerCase();
    if (
      key === undefined ||
      (yield* memoryKeys).has(key) ||
      !(yield* reachable(plan.reach._tag === "all" ? undefined : plan.reach.projects)).has(key)
    )
      return yield* denied(NOT_HERE);
    // A worker runs where it was launched, even after the host names another environment.
    if (plan.worker.environmentId === null || !bound(plan.worker))
      return yield* denied("That worker never started. Start a new one with kin_delegate.");
    const environmentId = plan.worker.environmentId;
    const workerChatId = plan.worker.chatId;
    // Never restarts work the owner withdrew, nor work on an entry that is no longer this lead's.
    const mayFollowUp = workMayStart({
      orgId: ctx.orgId,
      agentId: ctx.agentId,
      ownerPersonId: plan.config.ownerPersonId,
      wakeupId: ctx.wakeupId,
      event: plan.event,
      followsUp: input.workerId,
    }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
    // Last before the send: the gate's check again, and what a follow-up brings back lands in
    // the worker's chat, so the turn must be one that may write there.
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* lead(scope);
        const audience = yield* effectiveAudience(ctx).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        );
        // Where its answer lands now: its chat, or the owner's once private work's chat was shared.
        const answersIn = yield* cardChat(ctx.orgId, input.workerId, workerChatId);
        if (
          !(yield* toolAdmitted(ctx, "kin_follow_up", input).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          )) ||
          (answersIn !== null &&
            (yield* destination(ctx, answersIn).pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
            )) !== "allowed")
        )
          return yield* denied(SHARED_REFUSAL);
        if (!(yield* mayFollowUp)) return yield* denied(WORK_NOT_YOURS);
        // Before the send: an owner-only turn's brief makes the work private, for good.
        if (audience === "owner_only")
          yield* sql`UPDATE kin_workers SET context = 'private'
            WHERE org_id = ${ctx.orgId} AND worker_id = ${input.workerId}`;
      }),
    );
    const requestKey = (yield* hash({ wakeupId: ctx.wakeupId, input })).slice(0, 32);
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
        clientRequestId: `kin-follow-up:${requestKey}`,
      })
      .pipe(there("The follow-up could not be sent. Retry the same call or tell the owner."));
    // A new started_at marks newer work, so a follower still reporting the last run can't close it.
    const startedAt = yield* Clock.currentTimeMillis;
    const still = yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`UPDATE kin_workers SET status = 'queued', ended_at = NULL,
          started_at = ${startedAt}
          WHERE org_id = ${ctx.orgId} AND worker_id = ${input.workerId}`;
        yield* attemptBegun({
          orgId: ctx.orgId,
          workerId: input.workerId,
          startedAt,
          agentId: ctx.agentId,
          sourceEventId: input.sourceEventId,
        }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
        return yield* mayFollowUp;
      }),
    );
    // Withdrawn during the send, when no attempt of it was open to stop: stopped here instead.
    if (!still) {
      yield* tracker
        .stop({
          orgId: ctx.orgId,
          agentId: ctx.agentId,
          workerId: input.workerId,
          startedAt,
          reason: WITHDRAWN_REASON,
          key: `kin-follow-up-withdrawn:${input.workerId}:${startedAt}`,
        })
        .pipe(
          Effect.catchTags({
            OrchestratorMcpFailure: (error) =>
              Effect.fail(error).pipe(
                there("The worker could not be stopped. Retry or tell the owner."),
              ),
          }),
        );
      return yield* denied(WORK_NOT_YOURS);
    }
    yield* stopIfPaused(ctx.orgId, {
      environmentId,
      threadId: plan.worker.threadId,
      key: `kin-stop-launch:${input.workerId}:${sent.runId}`,
    });
    yield* showCard(ctx, {
      orgId: ctx.orgId,
      workerId: input.workerId,
      fallback: plan.worker.chatId,
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
    const record = yield* sql.withTransaction(
      Effect.gen(function* () {
        const stored = yield* worker(ctx, input.workerId);
        // Its own lead stops it, from an owner-only turn or from the chat it answers in.
        const here = yield* turnChat(ctx).pipe(Effect.provideService(SqlClient.SqlClient, sql));
        const answersIn = yield* cardChat(ctx.orgId, input.workerId, stored.chatId);
        if (
          answersIn !== here?.chatId &&
          (yield* effectiveAudience(ctx).pipe(Effect.provideService(SqlClient.SqlClient, sql))) !==
            "owner_only"
        )
          return yield* missing();
        // The gate's check again: a join may have shared the turn since.
        if (
          !(yield* toolAdmitted(ctx, "kin_worker_stop", input).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          ))
        )
          return yield* denied(SHARED_REFUSAL);
        return { ...stored, chatId: answersIn };
      }),
    );
    const key = `kin-worker-stop:${input.workerId}:${ctx.wakeupId}:${record.startedAt}`;
    const reason = input.reason ?? "Stopped by the Kin agent.";
    // A worker on this server: T3 interrupts its thread and its follower records the end.
    if (record.environmentId === null && record.threadId === localThreadId(input.workerId))
      return {
        workerId: input.workerId,
        stopped: (yield* tracker.stop({
          orgId: ctx.orgId,
          agentId: ctx.agentId,
          workerId: input.workerId,
          reason,
          key,
        })).stopped,
      };
    if (Option.isNone(env.environmentId)) return yield* denied(LOCAL_BUILD_ONLY);
    if (record.environmentId === null) return { workerId: input.workerId, stopped: false };
    // Through the tracker, so a run that ends meanwhile publishes nothing; an unconfirmed launch
    // is stopped once its follower finds the thread. A follow-up's run gets a new key.
    const stopped = yield* tracker
      .stop({ orgId: ctx.orgId, agentId: ctx.agentId, workerId: input.workerId, reason, key })
      .pipe(
        Effect.catchTags({
          OrchestratorMcpFailure: (error) =>
            Effect.fail(error).pipe(
              there("The worker could not be stopped. Retry or tell the owner."),
            ),
        }),
      );
    if (record.chatId !== null)
      yield* chat
        .setTaskCardClosed({
          orgId: ctx.orgId,
          chatId: record.chatId,
          // Closing writes no words.
          audience: "chat",
          threadId: record.threadId,
          closed: true,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Kin worker task card could not close", { cause }),
          ),
        );
    return { workerId: input.workerId, stopped: stopped.stopped };
  }, guarded("KinWorkers.stop"));

  return KinWorkers.of({ delegate, followUp, stop });
});

export const layer = Layer.effect(KinWorkers, make);
