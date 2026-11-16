import {
  CommandId,
  type KinChatId,
  KinChatError,
  type KinEvent,
  type KinMemoryItemId,
  KinWorkerId,
  MessageId,
  type ModelSelection,
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
import { buildBrief, type PullRequestWork } from "./workerBrief.ts";
import { PreviewBrowser } from "../../preview/PreviewBrowser.ts";
import { GitVcsDriver } from "../../vcs/GitVcsDriver.ts";
import { NOT_CONNECTED } from "../github/KinRepoReads.ts";
import { KinPullRequestCare } from "../github/PullRequestCare.ts";
import { labelOf, resolveProject, type Checkout, type HostProject } from "./workerProjects.ts";
import { workerBrowser } from "./workerBrowser.ts";
import { workerHosts } from "./workerNetwork.ts";
import { publishBranch } from "./workerPublish.ts";
import { grantHosts } from "./workNetwork.ts";
import type { DelegateInput } from "./Workers.ts";
import { STOPPED_BEFORE_START, WorkerTracker } from "./WorkerTracker.ts";
import { localThreadId } from "./workThread.ts";
import { KinRecords } from "../work/KinRecords.ts";
import { attemptBegun, noteSensitivity } from "../work/workerAttempts.ts";
import { WORK_NOT_YOURS, workMayStart, workerStarted } from "../work/workerEntries.ts";
import { isOwnerHimself } from "../people/KinAccess.ts";

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
export const LOCAL_BUILD_ONLY = `On this host, workers do build tasks and reviews of a pull request (pullRequest), started from your direct chat with the owner or, for PR work, an owner-only check-in: no research, review of another worker or follow-up yet. ${STILL}`;
export const LOCAL_DIRECT_ONLY = `On this host, work starts only from your direct chat with the owner, when only the owner is in the turn. If this came from somewhere else, say you'll pick it up there with the owner. ${STILL}`;
const NOT_CLAUDE = `Workers on this host run on Claude only, which has the file wall they need. ${STILL}`;
const FORK_PR = `That PR's branch is in another repository, so Kin can't push to it. Review it instead, or tell its author what to change. ${STILL}`;
const NOT_GITHUB = `That project isn't a GitHub repository, so it has no pull requests here. ${STILL}`;
const PR_UNREADABLE = `Kin couldn't fetch that PR's head on this host. ${STILL}`;
const UI_TEST_NEEDS_PR = `A UI test runs on an open pull request: call again with kind review, pullRequest and uiTest. ${STILL}`;
/** PR care runs from check-ins and GitHub's own news, not only from the owner's chat. */
const PR_CARE_EVENTS: ReadonlySet<string> = new Set(["pulse", "github", "worker.report"]);
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
  const { stateDir } = serverConfig;
  const projects = yield* ProjectService.ProjectService;
  const kinDirectory = path.join(stateDir, "kin");
  const fs = yield* FileSystem.FileSystem;
  // Optional so runtimes built without GitHub or T3's git (most lead tests) still start.
  const care = yield* Effect.serviceOption(KinPullRequestCare);
  const git = yield* Effect.serviceOption(GitVcsDriver);
  const browser = yield* Effect.serviceOption(PreviewBrowser);

  /**
   * From stored rows only: the host owner's own lead, the turn owner-only, its event the owner's in
   * the lead's direct chat with them, and nothing in the turn from another chat or another lead.
   */
  const ownersDirectChat = Effect.fn("KinLocalWorkers.ownersDirectChat")(
    function* (ctx: Lead, config: Config, event: KinEvent, prCare = false) {
      const { owner } = identity;
      if (
        ctx.orgId !== owner.orgId ||
        config.ownerPersonId !== owner.personId ||
        (config.createdBy !== null && !isOwnerHimself(owner, config.createdBy))
      )
        return false;
      // Work the owner gave the lead counts as asked in its direct chat: the stored assigner
      // is the owner, and the turn answers there (`turnChat`). Their taking it back never does.
      const ownerAssigned =
        event._tag === "record.changed" &&
        event.reason === "assigned" &&
        event.provenance._tag === "human" &&
        isOwnerHimself(owner, event.provenance.personId);
      const checkIn =
        prCare && PR_CARE_EVENTS.has(event._tag) && event.provenance._tag === "system";
      if (
        !ownerAssigned &&
        !checkIn &&
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

  /**
   * An open PR in the checkout's repository, fetched at its head into the project's clone with
   * T3's git, and its diff from GitHub. A fix needs the PR's branch in that same repository.
   */
  const pullRequestAt = Effect.fn("KinLocalWorkers.pullRequestAt")(function* (
    target: Checkout,
    number: number,
    kind: Input["kind"],
    uiTest: boolean,
  ) {
    if (target.slug === undefined) return yield* denied(NOT_GITHUB);
    if (Option.isNone(care) || Option.isNone(git))
      return yield* new KinChatError({ reason: "unavailable", message: NOT_CONNECTED });
    const pull = yield* care.value.pull(target.slug, number);
    if (kind === "build" && !pull.sameRepo) return yield* denied(FORK_PR);
    const project = Option.getOrUndefined(
      yield* projects.getById(target.projectId).pipe(Effect.orElseSucceed(() => Option.none())),
    );
    if (project === undefined)
      return yield* new KinChatError({ reason: "unavailable", message: PR_UNREADABLE });
    const fetched = yield* git.value
      .fetchRefCommit({ cwd: project.workspaceRoot, ref: `refs/pull/${number}/head` })
      .pipe(
        Effect.mapError(() => new KinChatError({ reason: "unavailable", message: PR_UNREADABLE })),
      );
    return {
      task:
        kind === "build" ? ("fix" as const) : uiTest ? ("ui_test" as const) : ("review" as const),
      repo: pull.repo,
      number,
      title: pull.title,
      headSha: fetched.commitSha,
      headRef: pull.headRef,
      baseRef: pull.baseRef,
      diff: pull.diff,
      ...(uiTest ? { browser: yield* workerBrowser(browser) } : {}),
    } satisfies PullRequestWork;
  });

  const delegate = Effect.fn("KinLocalWorkers.delegate")(function* (
    scope: McpInvocationScope,
    input: Input,
  ) {
    const ctx = yield* shared.lead(scope);
    // Default-deny for everything this slice doesn't do, before anything is read.
    const prNumber = input.pullRequest;
    if (
      input.kind === "research" ||
      input.reviewOf !== undefined ||
      (input.kind === "review" && prNumber === undefined)
    )
      return yield* denied(LOCAL_BUILD_ONLY);
    const uiTest = input.uiTest === true;
    if (uiTest && (input.kind !== "review" || prNumber === undefined))
      return yield* denied(UI_TEST_NEEDS_PR);
    const prCare = prNumber !== undefined;
    const plan = yield* sql.withTransaction(
      Effect.gen(function* () {
        const config = yield* shared.leadConfig(ctx);
        const event = yield* shared.sourceEvent(ctx, input.sourceEventId);
        if (!(yield* ownersDirectChat(ctx, config, event, prCare)))
          return yield* denied(LOCAL_DIRECT_ONLY);
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
    const pullRequest =
      prNumber === undefined
        ? undefined
        : yield* pullRequestAt(target, prNumber, input.kind, uiTest);
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
          !(yield* ownersDirectChat(ctx, config, plan.event, prCare))
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
          VALUES (${workerId}, ${ctx.orgId}, ${ctx.agentId}, ${ctx.wakeupId}, ${input.kind},
          ${threadId}, NULL, ${yield* encodeJson(modelSelection)},
          ${yield* encodeJson(plan.event.provenance)}, 'queued', NULL, ${startedAt}, NULL,
          ${input.title}, ${chatId}, ${target.projectId}, NULL, NULL, ${target.repositoryKey},
          'private')
          ON CONFLICT (worker_id) DO NOTHING RETURNING worker_id`;
        if (inserted.length > 0 && pullRequest !== undefined)
          yield* sql`UPDATE kin_workers SET target_pr = ${pullRequest.number},
              target_branch = ${pullRequest.task === "fix" ? pullRequest.headRef : null}
            WHERE org_id = ${ctx.orgId} AND worker_id = ${workerId}`;
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
      ...(pullRequest === undefined ? {} : { pullRequest }),
    });
    const baseRef =
      pullRequest?.headSha ??
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
        workspaceStrategy: {
          type: "worktree",
          baseRef,
          branch,
          startFromOrigin: pullRequest === undefined,
        },
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

  return { delegate };
});
