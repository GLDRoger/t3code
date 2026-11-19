import type { KinAgentId, KinOrgId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import { McpInvocationContext } from "../../mcp/McpInvocationContext.ts";
import * as McpToolExposure from "../../mcp/McpToolExposure.ts";
import { OrchestratorToolkit } from "../../mcp/toolkits/orchestrator/tools.ts";
import { ProjectToolkit } from "../../mcp/toolkits/project/tools.ts";
import { PullRequestsToolkit } from "../../mcp/toolkits/pullRequests/tools.ts";
import { WorktreeToolkit } from "../../mcp/toolkits/worktree/tools.ts";
import { PreviewToolkit } from "../../mcp/toolkits/preview/tools.ts";
import { PreviewControlsToolkit } from "../../mcp/toolkits/previewControls/tools.ts";
import { DeviceToolkit } from "../../mcp/toolkits/device/tools.ts";
import { HtmlToolkit } from "../../mcp/toolkits/html/tools.ts";
import { AttachmentToolkit } from "../../mcp/toolkits/attachment/tools.ts";
import { EnvironmentToolkit } from "../../mcp/toolkits/environment/tools.ts";
import { ThreadToolkit } from "../../mcp/toolkits/thread/tools.ts";
import { IssuesToolkit } from "../../mcp/toolkits/issues/tools.ts";
import { MessageToolkit } from "../../mcp/toolkits/message/tools.ts";
import { ThemeToolkit } from "../../mcp/toolkits/theme/tools.ts";
import { ServerConfig } from "../../config.ts";
import { toolDirectories } from "../gendocs/toolchain.ts";
import { KinGitHubLogin } from "../connections/GitHubLogin.ts";
import { KinServer } from "../KinServer.ts";
import { aborted, effectiveAudience, SESSION_REFUSAL, SHARED_THREAD_PREFIX } from "./Audience.ts";
import { outsideRead } from "./OutsideContent.ts";
import { KinAgentSessionPolicy } from "./sessionPolicy.ts";
import { listedOnSharedThread } from "./SharedTools.ts";
import { LEAD_T3_TOOLS } from "./t3Tools.ts";
import { isSocialTool } from "../social/mcp.ts";
import { socialSeatThread } from "../social/seat.ts";

const leadT3Tools: ReadonlySet<string> = new Set(LEAD_T3_TOOLS);

const T3_TOOLKITS = [
  OrchestratorToolkit,
  ProjectToolkit,
  PullRequestsToolkit,
  WorktreeToolkit,
  PreviewToolkit,
  PreviewControlsToolkit,
  DeviceToolkit,
  HtmlToolkit,
  AttachmentToolkit,
  EnvironmentToolkit,
  ThreadToolkit,
  IssuesToolkit,
  MessageToolkit,
  ThemeToolkit,
];
const t3Tools: ReadonlySet<string> = new Set(
  T3_TOOLKITS.flatMap((toolkit) => Object.keys(toolkit.tools)),
);
/** Every tool T3's own endpoint serves; the Kin endpoint serves them too, mostly hidden. */
const isT3Tool = (name: string) => t3Tools.has(name);

type Turn = { orgId: KinOrgId; agentId: KinAgentId; wakeupId: string };

/** Deeper chains than this are refused: T3 nests delegated tasks only a few levels. */
const MAX_DELEGATION_DEPTH = 8;

/**
 * The Kin turn whose rights a thread's built-in tools follow: the thread's own running wake-up,
 * else, for a task delegated (at any depth) from a lead's run, the wake-up of that run.
 * `delegated` says the thread descends from a lead's thread.
 */
const governingTurn = Effect.fnUntraced(function* (threadId: ThreadId) {
  const sql = yield* SqlClient.SqlClient;
  const [own] = yield* sql<Turn>`
    SELECT org_id AS "orgId", agent_id AS "agentId", wakeup_id AS "wakeupId" FROM kin_wakeups
    WHERE thread_id = ${threadId} AND status = 'running'
    ORDER BY started_at, wakeup_id LIMIT 1`;
  if (own !== undefined) return { turn: own, delegated: false };
  let current: string = threadId;
  for (let depth = 0; depth < MAX_DELEGATION_DEPTH; depth++) {
    const [link] = yield* sql<{ threadId: string; runId: string | null }>`
      SELECT thread_id AS "threadId", run_id AS "runId" FROM orchestration_v2_projection_subagents
      WHERE child_thread_id = ${current} AND origin = 'app_owned' ORDER BY subagent_id LIMIT 1`;
    if (link === undefined) return { turn: undefined, delegated: false };
    const [lead] = yield* sql<Turn & { run: string | null }>`
      SELECT org_id AS "orgId", agent_id AS "agentId", wakeup_id AS "wakeupId", run_id AS run
      FROM kin_wakeups WHERE thread_id = ${link.threadId}
      ORDER BY run_id = ${link.runId} DESC, started_at DESC, wakeup_id LIMIT 1`;
    // A lead's thread: its task follows the turn whose run asked for it, and none other.
    if (lead !== undefined)
      return {
        turn: link.runId !== null && lead.run === link.runId ? lead : undefined,
        delegated: true,
      };
    current = link.threadId;
  }
  // Too deep to trace: treat it as Kin's, so its hook admits nothing.
  return { turn: undefined, delegated: true };
});

/**
 * Why a thread's built-in tools (shell, edits, web, sub-agents) may not run now, or `undefined`
 * when they may: the turn it follows (`governingTurn`) is owner-only, not aborted for its
 * audience, and has read no outside text. No such turn admits nothing, so a run Kin hasn't
 * adopted can't use them. A delegated task keeps them exactly as long as its asking turn would.
 */
export const fullSessionRefusal = Effect.fn("KinAgentSession.fullSessionRefusal")(
  function* (threadId: ThreadId) {
    const { turn } = yield* governingTurn(threadId);
    if (turn === undefined) return SESSION_REFUSAL.none;
    if (yield* aborted(turn)) return SESSION_REFUSAL.aborted;
    if ((yield* effectiveAudience(turn)) !== "owner_only") return SESSION_REFUSAL.shared;
    if (yield* outsideRead(turn)) return SESSION_REFUSAL.outside;
    return undefined;
  },
  Effect.catchCause((cause) =>
    Effect.logWarning("Kin full-session check failed; refusing", { cause }).pipe(
      Effect.as<string | undefined>(SESSION_REFUSAL.none),
    ),
  ),
);

/** Whether a thread is a task delegated, at any depth, from a lead, and the turn it follows. */
export const delegatedTurn = Effect.fn("KinAgentSession.delegatedTurn")(
  (threadId: ThreadId) => governingTurn(threadId),
  // Unknown lineage still gets Kin's hook, which then admits nothing it can't prove.
  Effect.catchCause((cause) =>
    Effect.logWarning("Kin delegation lineage failed; confining", { cause }).pipe(
      Effect.as({ turn: undefined, delegated: true }),
    ),
  ),
);

/** Whether a thread is a task delegated, at any depth, from a Kin lead's thread. */
export const delegatedFromLead = Effect.fn("KinAgentSession.delegatedFromLead")(function* (
  threadId: ThreadId,
) {
  return (yield* delegatedTurn(threadId)).delegated;
});

/** What a task delegated from a lead may reach on T3's own endpoint: its lead's T3 tools. */
export const workerMayReach = (name: string) =>
  leadT3Tools.has(name) || name === McpToolExposure.TOOL_SEARCH;

/** Social's tools show only in the own thread of the lead whose remit is social media. */
const onSocialSeat = Effect.fn("KinAgentSession.onSocialSeat")(
  function* (threadId: ThreadId) {
    // Optional, so the endpoint's list needs no Kin server where Kin is off.
    const services = Option.flatMap(yield* Effect.serviceOption(KinServer), (kin) => kin.services);
    if (Option.isNone(services)) return false;
    return yield* socialSeatThread(threadId).pipe(
      Effect.provideService(SqlClient.SqlClient, Context.get(services.value, SqlClient.SqlClient)),
    );
  },
  Effect.catchCause((cause) =>
    Effect.logWarning("Kin social tool visibility failed; hiding", { cause }).pipe(
      Effect.as(false),
    ),
  ),
);

/** The name of the lead whose thread this is, or whose task it is, up T3's task links. */
export const leadNameOf = Effect.fn("KinAgentSession.leadNameOf")(
  function* (threadId: ThreadId) {
    const sql = yield* SqlClient.SqlClient;
    let current: string = threadId;
    for (let depth = 0; depth <= MAX_DELEGATION_DEPTH; depth++) {
      const [lead] = yield* sql<{ name: string }>`SELECT l.name FROM kin_wakeups w
        JOIN kin_leads l ON l.org_id = w.org_id AND l.agent_id = w.agent_id
        WHERE w.thread_id = ${current} ORDER BY w.started_at DESC LIMIT 1`;
      if (lead !== undefined) return lead.name;
      const [link] = yield* sql<{ threadId: string }>`SELECT thread_id AS "threadId"
        FROM orchestration_v2_projection_subagents
        WHERE child_thread_id = ${current} AND origin = 'app_owned' ORDER BY subagent_id LIMIT 1`;
      if (link === undefined) return undefined;
      current = link.threadId;
    }
    return undefined;
  },
  Effect.orElseSucceed((): string | undefined => undefined),
);

/** Kin's GitHub tools work through the owner's own login, so they show only while it's connected. */
const isKinGitHubTool = (name: string) => name.startsWith("kin_github_");
const LOGIN_GITHUB_TOOLS = new Set(["kin_github_review", "kin_github_watch", "kin_github_link"]);
const loginConnected = Effect.gen(function* () {
  const kin = yield* Effect.serviceOption(KinServer);
  if (Option.isNone(kin) || Option.isNone(kin.value.services)) return false;
  return yield* Context.get(kin.value.services.value, KinGitHubLogin).connected();
});

/**
 * What the Kin endpoint lists, per thread so every turn of it sends the same list (prompt cache).
 * Shared threads list only what shared turns may run; T3 tools show only on an owner-only thread.
 * `KinToolGate` checks each call.
 */
export const visibleOnKinEndpoint = Effect.fn("KinAgentSession.visible")(function* (
  name: string,
  threadId: ThreadId,
) {
  const shared = threadId.startsWith(SHARED_THREAD_PREFIX);
  if (shared && !listedOnSharedThread(name)) return false;
  if (isKinGitHubTool(name)) return LOGIN_GITHUB_TOOLS.has(name) && (yield* loginConnected);
  if (isSocialTool(name)) return yield* onSocialSeat(threadId);
  if (!isT3Tool(name)) return true;
  return leadT3Tools.has(name) && !shared;
});

export const endpointVisibility = McpHttpServer.toolVisibility((name) =>
  Effect.gen(function* () {
    const scope = yield* Effect.serviceOption(McpInvocationContext);
    if (Option.isNone(scope) || scope.value.thread === undefined) return false;
    return yield* visibleOnKinEndpoint(name, scope.value.thread.threadId);
  }),
);

/**
 * T3's tool search, and what T3's own endpoint lists, on a Kin server: a task delegated from a lead
 * lists only `workerMayReach` and its search finds no other; every other thread's are T3's.
 * `KinToolGate.workers` checks the calls.
 */
export const workerListing = (sql: SqlClient.SqlClient) => {
  // Per token: a thread's lineage is written before its session's token is issued.
  const known = new WeakMap<object, boolean>();
  const isWorker = Effect.fnUntraced(function* () {
    const scope = Option.getOrUndefined(yield* Effect.serviceOption(McpInvocationContext));
    if (scope?.thread === undefined) return false;
    const cached = known.get(scope);
    if (cached !== undefined) return cached;
    return yield* governingTurn(scope.thread.threadId).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.map(({ delegated }) => delegated),
      Effect.tap((delegated) => Effect.sync(() => known.set(scope, delegated))),
      Effect.catchCause((cause) =>
        Effect.logWarning("Kin delegation lineage failed; confining", { cause }).pipe(
          Effect.as(true),
        ),
      ),
    );
  });
  const exposure = Layer.effect(
    McpToolExposure.McpToolExposure,
    Effect.gen(function* () {
      const exposure = yield* McpToolExposure.McpToolExposure;
      return McpToolExposure.McpToolExposure.of({
        ...exposure,
        search: Effect.fn("KinAgentSession.workerSearch")(function* (session, query) {
          const found = yield* exposure.search(session, query);
          return (yield* isWorker()) ? found.filter((tool) => leadT3Tools.has(tool.name)) : found;
        }),
      });
    }),
  ).pipe(Layer.provide(McpHttpServer.layerToolExposure));
  return Layer.merge(
    McpHttpServer.toolVisibility((name) =>
      workerMayReach(name) ? Effect.succeed(true) : Effect.map(isWorker(), (worker) => !worker),
    ),
    McpHttpServer.layerToolSearchRegistrations.pipe(Layer.provide(exposure)),
  );
};

export const sessionPolicyLayer = Layer.effect(
  KinAgentSessionPolicy,
  Effect.gen(function* () {
    const login = yield* KinGitHubLogin;
    const sql = yield* SqlClient.SqlClient;
    const config = yield* ServerConfig;
    return KinAgentSessionPolicy.of({
      refusal: Effect.fn("KinAgentSessionPolicy.refusal")((threadId: ThreadId) =>
        fullSessionRefusal(threadId).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      ),
      delegated: Effect.fn("KinAgentSessionPolicy.delegated")((threadId: ThreadId) =>
        delegatedFromLead(threadId).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      ),
      toolDirectories: [login.ghDirectory, ...toolDirectories(config.baseDir)],
      agentName: Effect.fn("KinAgentSessionPolicy.agentName")((threadId: ThreadId) =>
        leadNameOf(threadId).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      ),
    });
  }),
);
