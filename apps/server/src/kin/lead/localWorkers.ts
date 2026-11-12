import {
  CommandId,
  type KinChatId,
  KinChatError,
  type KinEvent,
  type KinMemoryItemId,
  type KinOrgId,
  KinWorkerId,
  MessageId,
  type ModelSelection,
  ProjectId,
} from "@t3tools/contracts";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import { ServerConfig } from "../../config.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import { deriveProviderInstanceConfigMap } from "../../provider/ProviderInstanceRegistryHydration.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { effectiveAudience } from "./Audience.ts";
import { KinBudget } from "./KinBudget.ts";
import type { resolveLead } from "./LeadMemory.ts";
import { isOrgPaused } from "./orgState.ts";
import { toolAdmitted } from "./SharedTools.ts";
import { buildBrief } from "./workerBrief.ts";
import { labelOf, resolveProject, type Checkout, type HostProject } from "./workerProjects.ts";
import { workerHosts } from "./workerNetwork.ts";
import { publishBranch } from "./workerPublish.ts";
import { grantHosts } from "./workNetwork.ts";
import type { DelegateInput } from "./Workers.ts";
import { STOPPED_BEFORE_START, WorkerTracker } from "./WorkerTracker.ts";
import { localThreadId } from "./workThread.ts";
import {
  cleanupJob,
  docBrief,
  type DocumentInput,
  planJob,
  workerJobSensitive,
} from "../gendocs/DocJobs.ts";
import { jobBranch, jobWorktree, KinWorkspace } from "../gendocs/workspace.ts";
import { KinRecords } from "../work/KinRecords.ts";
import { attemptBegun, noteSensitivity } from "../work/workerAttempts.ts";
import { WORK_NOT_YOURS, workMayStart, workerStarted } from "../work/workerEntries.ts";

type Lead = Effect.Success<ReturnType<typeof resolveLead>>;
type Config = {
  readonly models: { readonly strong: ModelSelection; readonly cheap: ModelSelection };
  readonly ownerChatId: KinChatId;
  readonly ownerPersonId: string;
  readonly createdBy: string | null;
};
type Input = typeof DelegateInput.Type;

const STILL =
  "Nothing started. Say so once, in one line, and don't ask the owner to change your setup. You can still read repos, pull requests and CI yourself, or answer from memory.";
/** What a lead hears for anything the local path doesn't do yet. */
export const LOCAL_BUILD_ONLY = `On this host, workers do build tasks only, started from your direct chat with the owner: no review, research or follow-up from you yet. ${STILL}`;
export const LOCAL_DIRECT_ONLY = `On this host, work starts only from your direct chat with the owner, when only the owner is in the turn. If this came from somewhere else, say you'll pick it up there with the owner. ${STILL}`;
const NOT_CLAUDE = `Workers on this host run on Claude only, which has the file wall they need. ${STILL}`;
const LAUNCH_FAILED = `The worker couldn't start on this host. Retry the same call or tell the owner. ${STILL}`;

const denied = (message: string) => new KinChatError({ reason: "not_allowed", message });
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const isChatError = Schema.is(KinChatError);

/**
 * `kin_delegate` when the host names no worker environment: the worker is a thread on this server,
 * in a fresh worktree of one of its projects. `WorkIsolation` gives it file tools in that worktree
 * and nothing else, and `WorkerTracker` commits, publishes and reports for it. Only the host
 * owner's own lead, from its direct chat with the owner in an owner-only turn, starts one.
 */
export const makeLocalDelegate = Effect.fn("KinLocalWorkers.make")(function* (shared: {
  readonly lead: (scope: McpInvocationScope) => Effect.Effect<Lead, KinChatError>;
  readonly leadConfig: (ctx: Lead) => Effect.Effect<Config, KinChatError>;
  readonly sourceEvent: (ctx: Lead, eventId: string) => Effect.Effect<KinEvent, KinChatError>;
  readonly open: (
    ctx: Lead,
    chats: ReadonlyArray<KinChatId | null>,
  ) => Effect.Effect<boolean, KinChatError>;
  readonly pick: (
    model: Input["model"],
    configured: Config["models"],
  ) => Effect.Effect<ModelSelection, KinChatError>;
  readonly hash: (value: unknown) => Effect.Effect<string, KinChatError>;
  readonly memoryKeys: Effect.Effect<ReadonlySet<string>, KinChatError>;
  readonly hostProjects: () => Effect.Effect<ReadonlyArray<HostProject>>;
  readonly connectedRepos: ReadonlyArray<string>;
  readonly memoryItem: (
    ctx: Lead,
    id: KinMemoryItemId,
  ) => Effect.Effect<
    { readonly id: string; readonly title: string; readonly body: string },
    KinChatError
  >;
}) {
  const sql = yield* SqlClient.SqlClient;
  const identity = yield* KinIdentity;
  const chat = yield* KinChatService;
  const budget = yield* KinBudget;
  const tracker = yield* WorkerTracker;
  const records = yield* KinRecords;
  const environment = yield* ServerEnvironment;
  const orchestrator = yield* OrchestratorV2;
  const launcher = yield* ThreadLaunchService.ThreadLaunchService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;
  const { stateDir, worktreesDir } = serverConfig;
  const workspace = yield* KinWorkspace;
  const projects = yield* ProjectService.ProjectService;
  const kinDirectory = path.join(stateDir, "kin");
  const fs = yield* FileSystem.FileSystem;

  /**
   * From stored rows only: the host owner's own lead, the turn owner-only, its event the owner's in
   * the lead's direct chat with them, and nothing in the turn from another chat or another lead.
   */
  const ownersDirectChat = Effect.fn("KinLocalWorkers.ownersDirectChat")(
    function* (ctx: Lead, config: Config, event: KinEvent) {
      const { owner } = identity;
      if (
        ctx.orgId !== owner.orgId ||
        config.ownerPersonId !== owner.personId ||
        (config.createdBy !== null && config.createdBy !== owner.personId)
      )
        return false;
      // Work the owner gave the lead counts as asked in its direct chat: the stored assigner
      // is the owner, and the turn answers there (`turnChat`). Their taking it back never does.
      const ownerAssigned =
        event._tag === "record.changed" &&
        event.reason === "assigned" &&
        event.provenance._tag === "human" &&
        event.provenance.personId === owner.personId;
      if (
        !ownerAssigned &&
        ((event._tag !== "chat.message" &&
          event._tag !== "widget.action" &&
          event._tag !== "chat.reaction") ||
          event.chatId !== config.ownerChatId)
      )
        return false;
      if ((yield* effectiveAudience(ctx)) !== "owner_only") return false;
      const rows = yield* sql<{ chatId: string | null; origin: string | null }>`
        SELECT json_extract(json, '$.chatId') AS "chatId", json_extract(json, '$.origin') AS origin
        FROM kin_events WHERE org_id = ${ctx.orgId} AND agent_id = ${ctx.agentId}
          AND wakeup_id = ${ctx.wakeupId} ORDER BY event_id`;
      return (
        rows.length > 0 &&
        rows.every(
          (row) =>
            row.origin === null && (row.chatId === null || row.chatId === config.ownerChatId),
        )
      );
    },
    Effect.provideService(SqlClient.SqlClient, sql),
    Effect.catchCause((cause) =>
      Effect.logWarning("Kin local worker check failed; refusing", { cause }).pipe(
        Effect.as(false),
      ),
    ),
  );

  /** Claude only: the work wall (`WorkIsolation`) wraps Claude sessions and nothing else. */
  const claudeOnly = Effect.fn("KinLocalWorkers.claudeOnly")(function* (chosen: ModelSelection) {
    const entry = deriveProviderInstanceConfigMap(yield* settings.getSettings)[chosen.instanceId];
    if (entry?.driver !== "claudeAgent") return yield* denied(NOT_CLAUDE);
  });

  /** A project on this server with a repository, never Kin's own memory or state. */
  const locate = Effect.fn("KinLocalWorkers.locate")(function* (named: string) {
    const memory = yield* shared.memoryKeys;
    const all = yield* shared.hostProjects();
    const inKin = (root: string | undefined) => {
      if (root === undefined) return true;
      const relative = path.relative(kinDirectory, path.resolve(root));
      return !relative.startsWith("..") && !path.isAbsolute(relative);
    };
    const checkouts: Array<Checkout> = all.flatMap((project) =>
      project.repositoryKey === undefined ||
      memory.has(project.repositoryKey.toLowerCase()) ||
      inKin(project.root)
        ? []
        : [
            {
              projectId: project.projectId,
              title: project.title,
              repositoryKey: project.repositoryKey,
              slug: /^github\.com\/([^/]+\/[^/]+)$/i.exec(project.repositoryKey)?.[1],
            },
          ],
    );
    const found = resolveProject({
      named,
      checkouts,
      hostProjects: all,
      connectedRepos: shared.connectedRepos,
      allowed: undefined,
    });
    const said = `"${named.slice(0, 80).replaceAll('"', "'")}"`;
    const retry = "Nothing started. Call again with one of those names, or ask which one is meant.";
    if (found._tag === "resolved") return found.checkout;
    if (found._tag === "ambiguous")
      return yield* new KinChatError({
        reason: "invalid_state",
        message: `${said} fits several here: ${found.labels.join(", ")}. ${retry}`,
      });
    if (found._tag === "unknown" && found.labels.length > 0)
      return yield* new KinChatError({
        reason: "not_found",
        message: `No project or repository here is called ${said}. Work can start in: ${found.labels.join(", ")}. ${retry}`,
      });
    return yield* new KinChatError({
      reason: "unavailable",
      message: `That repository isn't cloned on this host yet, so work can't start in it. That is a step on the host, not a fault in you or in this request. ${STILL}`,
    });
  });

  const delegate = Effect.fn("KinLocalWorkers.delegate")(function* (
    scope: McpInvocationScope,
    input: Input,
  ) {
    const ctx = yield* shared.lead(scope);
    // Default-deny for everything this slice doesn't do, before anything is read.
    if (input.kind !== "build" || input.reviewOf !== undefined)
      return yield* denied(LOCAL_BUILD_ONLY);
    const plan = yield* sql.withTransaction(
      Effect.gen(function* () {
        const config = yield* shared.leadConfig(ctx);
        const event = yield* shared.sourceEvent(ctx, input.sourceEventId);
        if (!(yield* ownersDirectChat(ctx, config, event))) return yield* denied(LOCAL_DIRECT_ONLY);
        return { config, event, open: yield* shared.open(ctx, [config.ownerChatId]) };
      }),
    );
    if (!plan.open)
      return yield* denied(
        "Starting work isn't open to you in this chat. Nothing started; tell the owner what you would do.",
      );
    if (yield* isOrgPaused(ctx.orgId).pipe(Effect.provideService(SqlClient.SqlClient, sql)))
      return yield* denied(
        `Kin is paused by the owner, so no new work starts until they resume it. ${STILL}`,
      );
    if (!(yield* budget.admitWorker(ctx.orgId)))
      return yield* new KinChatError({
        reason: "limit",
        message: `Today's budget for coding work is used up, so this waits for the daily reset or a higher limit. ${STILL}`,
      });
    const modelSelection = yield* shared.pick(input.model, plan.config.models);
    yield* claudeOnly(modelSelection);
    const target = yield* locate(input.project);
    const items = yield* Effect.forEach(input.memoryItemIds ?? [], (id) =>
      shared.memoryItem(ctx, id),
    );
    const workerId = KinWorkerId.make(
      `wk-${(yield* shared.hash({ wakeupId: ctx.wakeupId, input })).slice(0, 32)}`,
    );
    const branch = publishBranch(workerId);
    const threadId = localThreadId(workerId);
    const chatId = plan.config.ownerChatId;
    const startedAt = yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* shared.lead(scope);
        const config = yield* shared.leadConfig(ctx);
        // The checks again where the row is written: a join may have shared the turn meanwhile.
        if (
          !(yield* toolAdmitted(ctx, "kin_delegate", input).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          )) ||
          !(yield* ownersDirectChat(ctx, config, plan.event))
        )
          return yield* denied(LOCAL_DIRECT_ONLY);
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
        const inserted = yield* sql`INSERT INTO kin_workers (worker_id, org_id, agent_id, wakeup_id,
          kind, thread_id, review_of, model_json, provenance_json, status, report_json, started_at,
          ended_at, title, chat_id, project_id, environment_id, remote_project_id, repository_key,
          context)
          VALUES (${workerId}, ${ctx.orgId}, ${ctx.agentId}, ${ctx.wakeupId}, 'build', ${threadId},
          NULL, ${yield* encodeJson(modelSelection)}, ${yield* encodeJson(plan.event.provenance)},
          'queued', NULL, ${startedAt}, NULL, ${input.title}, ${chatId}, ${target.projectId}, NULL,
          NULL, ${target.repositoryKey}, 'private')
          ON CONFLICT (worker_id) DO NOTHING RETURNING worker_id`;
        if (inserted.length > 0) {
          yield* attemptBegun({
            orgId: ctx.orgId,
            workerId,
            startedAt,
            agentId: ctx.agentId,
            sourceEventId: input.sourceEventId,
          }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
          yield* workerStarted({
            orgId: ctx.orgId,
            agentId: ctx.agentId,
            workerId,
            wakeupId: ctx.wakeupId,
            title: input.title,
            event: plan.event,
            ...(input.entry === undefined ? {} : { entryKey: input.entry }),
          }).pipe(
            Effect.provideService(KinRecords, records),
            Effect.provideService(SqlClient.SqlClient, sql),
          );
          // The entry it now serves may be sensitive; that sticks to the attempt.
          yield* noteSensitivity({ orgId: ctx.orgId, workerId, startedAt }).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          );
          return startedAt;
        }
        const [stored] = yield* sql<{ wakeupId: string; startedAt: number }>`SELECT
            wakeup_id AS "wakeupId", started_at AS "startedAt"
          FROM kin_workers WHERE org_id = ${ctx.orgId} AND agent_id = ${ctx.agentId}
            AND worker_id = ${workerId} ORDER BY worker_id`;
        if (stored === undefined || stored.wakeupId !== ctx.wakeupId)
          return yield* denied(LOCAL_DIRECT_ONLY);
        return stored.startedAt;
      }),
    );
    const brief = buildBrief({
      goal: input.goal,
      brief: input.brief,
      ...(input.quoted === undefined ? {} : { quoted: input.quoted }),
      branch,
      local: true,
      memory: items,
    });
    const baseRef =
      input.baseRef ??
      (yield* launcher
        .checkWorktreeBase({
          projectId: target.projectId,
          workspaceStrategy: { type: "worktree", baseRef: "origin/HEAD", startFromOrigin: true },
        })
        .pipe(
          Effect.as("origin/HEAD"),
          Effect.orElseSucceed(() => "HEAD"),
        ));
    // What the owner allows now; the worker's sandbox reads this when its session opens.
    yield* workerHosts(ctx.orgId).pipe(
      Effect.flatMap(({ allowed }) =>
        grantHosts(
          stateDir,
          workerId,
          allowed.map((entry) => entry.host),
        ),
      ),
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.catchCause((cause) =>
        Effect.logWarning("Kin worker starts without network", { workerId, cause }),
      ),
    );
    // A retry replays the same command, which returns the thread the first launch made. A stop
    // that came first means no launch; one during it reaches the thread as it returns.
    const launch = launcher
      .launch({
        commandId: CommandId.make(`kin-work:${workerId}`),
        threadId,
        projectId: target.projectId,
        title: input.title,
        modelSelection,
        runtimeMode: "auto-accept-edits",
        interactionMode: "default",
        workspaceStrategy: { type: "worktree", baseRef, branch, startFromOrigin: true },
        initialMessage: {
          messageId: MessageId.make(`kin-work-msg:${workerId}`),
          text: brief,
          attachments: [],
        },
        createdBy: "system",
        creationSource: "server",
      })
      .pipe(
        Effect.tapError((cause) =>
          Effect.gen(function* () {
            yield* Effect.logWarning("Kin local worker launch failed", { workerId, cause });
            yield* sql`UPDATE kin_workers SET status = 'failed', ended_at = ${yield* Clock.currentTimeMillis}
              WHERE org_id = ${ctx.orgId} AND worker_id = ${workerId} AND status = 'queued'`;
          }).pipe(Effect.ignore),
        ),
        Effect.mapError((error) =>
          isChatError(error)
            ? error
            : new KinChatError({ reason: "unavailable", message: LAUNCH_FAILED }),
        ),
      );
    const launched = yield* tracker
      .launch({ orgId: ctx.orgId, workerId, startedAt }, launch)
      .pipe(
        Effect.mapError((error) =>
          isChatError(error)
            ? error
            : new KinChatError({ reason: "unavailable", message: LAUNCH_FAILED }),
        ),
      );
    if (Option.isNone(launched)) return yield* denied(STOPPED_BEFORE_START);
    // Cards are best effort: a launched worker must not fail because its card could not be shown.
    yield* chat
      .createTaskCard({
        orgId: ctx.orgId,
        chatId,
        audience: "owner",
        authorAgentId: ctx.agentId,
        threadId,
        title: input.title,
        model: modelSelection.model,
      })
      .pipe(
        Effect.provideService(OrchestratorV2, orchestrator),
        Effect.provideService(ServerEnvironment, environment),
        Effect.catchCause((cause) =>
          Effect.logWarning("Kin worker task card unavailable", { cause }),
        ),
      );
    yield* tracker.track(ctx.orgId, workerId);
    return {
      workerId,
      threadLink: formatThreadLink({
        environmentId: yield* environment.getEnvironmentId,
        threadId,
      }),
      project: labelOf(target),
    };
  });

  const documentProjects = new Map<string, ProjectId>();
  /** The project a document job's thread belongs to, rooted at the org's workspace. */
  const documentsProject = Effect.fn("KinLocalWorkers.documentsProject")(function* (
    orgId: KinOrgId,
  ) {
    const known = documentProjects.get(orgId);
    if (known !== undefined) return known;
    const root = yield* workspace.root(orgId);
    // A deleted project's id replays its deletion, so each deletion moves on to the next id.
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      const suffix = attempt === 1 ? "" : `:${attempt}`;
      const { project } = yield* projects
        .bootstrap({
          commandId: CommandId.make(`kin-documents-project:${orgId}${suffix}`),
          projectId: ProjectId.make(`kin-documents:${orgId}${suffix}`),
          workspaceRoot: root,
          title: "Kin documents",
        })
        .pipe(
          Effect.mapError(
            () => new KinChatError({ reason: "unavailable", message: LAUNCH_FAILED }),
          ),
        );
      if (project.deletedAt !== null) continue;
      documentProjects.set(orgId, project.id);
      return project.id;
    }
    return yield* new KinChatError({ reason: "unavailable", message: LAUNCH_FAILED });
  });

  /**
   * `kin_document` without a recipe to run: a worker on this server makes a one-off file, or
   * writes a recipe, in a worktree of the org's workspace. The same rules as `delegate`: the
   * host owner's lead, in its direct chat with the owner, in an owner-only turn. No network.
   */
  const document = Effect.fn("KinLocalWorkers.document")(function* (
    scope: McpInvocationScope,
    input: DocumentInput,
  ) {
    const ctx = yield* shared.lead(scope);
    const plan = yield* sql.withTransaction(
      Effect.gen(function* () {
        const config = yield* shared.leadConfig(ctx);
        const event = yield* shared.sourceEvent(ctx, input.sourceEventId);
        if (!(yield* ownersDirectChat(ctx, config, event))) return yield* denied(LOCAL_DIRECT_ONLY);
        return { config, event, open: yield* shared.open(ctx, [config.ownerChatId]) };
      }),
    );
    if (!plan.open)
      return yield* denied(
        "Starting work isn't open to you in this chat. Nothing started; tell the owner what you would do.",
      );
    if (yield* isOrgPaused(ctx.orgId).pipe(Effect.provideService(SqlClient.SqlClient, sql)))
      return yield* denied(
        `Kin is paused by the owner, so no new work starts until they resume it. ${STILL}`,
      );
    if (!(yield* budget.admitWorker(ctx.orgId)))
      return yield* new KinChatError({
        reason: "limit",
        message: `Today's budget for worker tasks is used up, so this waits for the daily reset or a higher limit. ${STILL}`,
      });
    const job = yield* planJob(ctx.orgId, input).pipe(
      Effect.provideService(KinWorkspace, workspace),
      Effect.provideService(KinRecords, records),
      Effect.provideService(SqlClient.SqlClient, sql),
    );
    const modelSelection = yield* shared.pick("strong", plan.config.models);
    yield* claudeOnly(modelSelection);
    const workerId = KinWorkerId.make(
      `wk-${(yield* shared.hash({ wakeupId: ctx.wakeupId, document: input })).slice(0, 32)}`,
    );
    const threadId = localThreadId(workerId);
    const chatId = plan.config.ownerChatId;
    const worktreePath = jobWorktree(worktreesDir, workerId);
    const answered =
      plan.event._tag === "chat.message" || plan.event._tag === "widget.action"
        ? plan.event.messageId
        : null;
    const projectId = yield* documentsProject(ctx.orgId);
    // A job that never ran still owes its prepared worktree, inputs included.
    const discardJob = cleanupJob(ctx.orgId, workerId).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ServerConfig, serverConfig),
      Effect.provideService(KinWorkspace, workspace),
    );
    const started = yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* shared.lead(scope);
        const config = yield* shared.leadConfig(ctx);
        if (
          !(yield* toolAdmitted(ctx, "kin_document", input).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          )) ||
          !(yield* ownersDirectChat(ctx, config, plan.event))
        )
          return yield* denied(LOCAL_DIRECT_ONLY);
        const startedAt = yield* Clock.currentTimeMillis;
        const inserted = yield* sql`INSERT INTO kin_workers (worker_id, org_id, agent_id, wakeup_id,
          kind, thread_id, review_of, model_json, provenance_json, status, report_json, started_at,
          ended_at, title, chat_id, project_id, environment_id, remote_project_id, repository_key,
          context)
          VALUES (${workerId}, ${ctx.orgId}, ${ctx.agentId}, ${ctx.wakeupId}, 'build', ${threadId},
          NULL, ${yield* encodeJson(modelSelection)}, ${yield* encodeJson(plan.event.provenance)},
          'queued', NULL, ${startedAt}, NULL, ${input.title}, ${chatId}, ${projectId}, NULL, NULL,
          NULL, 'private')
          ON CONFLICT (worker_id) DO NOTHING RETURNING worker_id`;
        if (inserted.length === 0) {
          const [stored] = yield* sql<{ wakeupId: string; startedAt: number }>`SELECT
              wakeup_id AS "wakeupId", started_at AS "startedAt"
            FROM kin_workers WHERE org_id = ${ctx.orgId} AND agent_id = ${ctx.agentId}
              AND worker_id = ${workerId} ORDER BY worker_id`;
          if (stored === undefined || stored.wakeupId !== ctx.wakeupId)
            return yield* denied(LOCAL_DIRECT_ONLY);
          return { startedAt: stored.startedAt, fresh: false };
        }
        const sensitive = yield* workerJobSensitive(ctx.orgId, ctx.wakeupId, job).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.provideService(KinRecords, records),
        );
        yield* sql`INSERT INTO kin_doc_jobs (org_id, worker_id, agent_id, wakeup_id, mode, recipe,
            recipe_commit, entry_record_id, inputs_sha256, number, sensitive, doc_origin,
            worktree_path, branch, chat_id, audience, answered_message_id, answered_author_kind,
            answered_author_id, created_at)
          VALUES (${ctx.orgId}, ${workerId}, ${ctx.agentId}, ${ctx.wakeupId}, ${job.mode},
            ${job.recipeName}, ${job.recipe?.commit ?? ""}, ${job.entry?.recordId ?? null},
            ${job.inputsHash}, ${job.number}, ${sensitive ? 1 : 0}, ${job.docOrigin},
            ${worktreePath}, ${jobBranch(workerId)}, ${chatId}, 'owner_only', ${answered},
            ${answered === null ? null : "person"}, ${answered === null ? null : config.ownerPersonId},
            ${startedAt})`;
        yield* attemptBegun({
          orgId: ctx.orgId,
          workerId,
          startedAt,
          agentId: ctx.agentId,
          sourceEventId: input.sourceEventId,
        }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
        return { startedAt, fresh: true };
      }),
    );
    if (started.fresh) {
      const prepared = yield* workspace.prepare(ctx.orgId, workerId, {}).pipe(
        Effect.tapError(() =>
          Effect.gen(function* () {
            yield* sql`UPDATE kin_workers SET status = 'failed', ended_at = ${yield* Clock.currentTimeMillis}
                WHERE org_id = ${ctx.orgId} AND worker_id = ${workerId} AND status = 'queued'`;
            yield* discardJob;
          }).pipe(Effect.ignore),
        ),
      );
      // The commit the worktree holds: the recipe exactly as the worker ran it.
      yield* sql`UPDATE kin_doc_jobs SET recipe_commit = ${prepared.base}
        WHERE org_id = ${ctx.orgId} AND worker_id = ${workerId}`;
    }
    const launch = launcher
      .launch({
        commandId: CommandId.make(`kin-work:${workerId}`),
        threadId,
        projectId,
        title: input.title,
        modelSelection,
        runtimeMode: "auto-accept-edits",
        interactionMode: "default",
        workspaceStrategy: { type: "existing_worktree", worktreePath, branch: jobBranch(workerId) },
        initialMessage: {
          messageId: MessageId.make(`kin-work-msg:${workerId}`),
          text: docBrief(job, input),
          attachments: [],
        },
        createdBy: "system",
        creationSource: "server",
      })
      .pipe(
        Effect.tapError((cause) =>
          Effect.gen(function* () {
            yield* Effect.logWarning("Kin document worker launch failed", { workerId, cause });
            yield* sql`UPDATE kin_workers SET status = 'failed', ended_at = ${yield* Clock.currentTimeMillis}
              WHERE org_id = ${ctx.orgId} AND worker_id = ${workerId} AND status = 'queued'`;
            yield* discardJob;
          }).pipe(Effect.ignore),
        ),
        Effect.mapError((error) =>
          isChatError(error)
            ? error
            : new KinChatError({ reason: "unavailable", message: LAUNCH_FAILED }),
        ),
      );
    const launched = yield* tracker
      .launch({ orgId: ctx.orgId, workerId, startedAt: started.startedAt }, launch)
      .pipe(
        Effect.mapError((error) =>
          isChatError(error)
            ? error
            : new KinChatError({ reason: "unavailable", message: LAUNCH_FAILED }),
        ),
      );
    if (Option.isNone(launched)) {
      yield* discardJob;
      return yield* denied(STOPPED_BEFORE_START);
    }
    yield* chat
      .createTaskCard({
        orgId: ctx.orgId,
        chatId,
        audience: "owner",
        authorAgentId: ctx.agentId,
        threadId,
        title: input.title,
        model: modelSelection.model,
      })
      .pipe(
        Effect.provideService(OrchestratorV2, orchestrator),
        Effect.provideService(ServerEnvironment, environment),
        Effect.catchCause((cause) =>
          Effect.logWarning("Kin document task card unavailable", { cause }),
        ),
      );
    yield* tracker.track(ctx.orgId, workerId);
    return {
      workerId,
      threadLink: formatThreadLink({
        environmentId: yield* environment.getEnvironmentId,
        threadId,
      }),
      recipe: job.recipeName,
      number: job.number,
      draft: job.draft,
      documents: [],
    };
  });

  return { delegate, document };
});
