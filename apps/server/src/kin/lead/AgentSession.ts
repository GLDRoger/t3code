import type { KinAgentId, KinOrgId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import { McpInvocationContext } from "../../mcp/McpInvocationContext.ts";
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
import { ServerConfig } from "../../config.ts";
import { toolDirectories } from "../gendocs/toolchain.ts";
import { KinGitHubLogin } from "../connections/GitHubLogin.ts";
import { aborted, effectiveAudience, SESSION_REFUSAL, SHARED_THREAD_PREFIX } from "./Audience.ts";
import { outsideRead } from "./OutsideContent.ts";
import { KinAgentSessionPolicy } from "./sessionPolicy.ts";
import { LEAD_T3_TOOLS } from "./t3Tools.ts";

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

/** Whether a thread is a task delegated, at any depth, from a Kin lead's thread. */
export const delegatedFromLead = Effect.fn("KinAgentSession.delegatedFromLead")(
  function* (threadId: ThreadId) {
    const { delegated } = yield* governingTurn(threadId);
    return delegated;
  },
  // Unknown lineage still gets Kin's hook, which then admits nothing it can't prove.
  Effect.catchCause((cause) =>
    Effect.logWarning("Kin delegation lineage failed; confining", { cause }).pipe(Effect.as(true)),
  ),
);

/**
 * What the Kin endpoint lists and lets a session call. A T3 tool shows only on a thread whose turns
 * only the owner level reads; `kin_delegate` never shows: longer work is a T3 delegated task. The
 * gate (`KinToolGate`) still checks each call against the running turn.
 */
export const visibleOnKinEndpoint = (name: string, threadId: ThreadId) => {
  if (name === "kin_delegate") return false;
  if (!isT3Tool(name)) return true;
  return leadT3Tools.has(name) && !threadId.startsWith(SHARED_THREAD_PREFIX);
};

export const endpointVisibility = McpHttpServer.toolVisibility((name) =>
  Effect.gen(function* () {
    const scope = yield* Effect.serviceOption(McpInvocationContext);
    if (Option.isNone(scope) || scope.value.thread === undefined) return false;
    return visibleOnKinEndpoint(name, scope.value.thread.threadId);
  }),
);

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
    });
  }),
);
