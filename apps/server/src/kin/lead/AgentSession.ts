import type { KinAgentId, KinOrgId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
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
import { KinServer } from "../KinServer.ts";
import { KinGitHubLogin } from "../connections/GitHubLogin.ts";
import { aborted, effectiveAudience, SHARED_THREAD_PREFIX } from "./Audience.ts";
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

/**
 * The one switch between Kin's worker path and the T3 path (repos-rethink design, slice 3): the
 * owner's GitHub is connected on this host. Then an agent's owner-only turns get a full session
 * and T3's tools, and `kin_delegate` is no longer offered; otherwise everything is as before.
 */
const githubConnected = KinGitHubLogin.use((login) => login.connected());

/**
 * Whether a lead thread's built-in tools (shell, edits, web, sub-agents) may run now: its running
 * wake-up is owner-only, not aborted for its audience, and has read no outside text. No running
 * wake-up admits nothing, so a run Kin hasn't adopted can't use them.
 */
export const fullSessionAdmitted = Effect.fn("KinAgentSession.fullSessionAdmitted")(
  function* (threadId: ThreadId) {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ orgId: KinOrgId; agentId: KinAgentId; wakeupId: string }>`
      SELECT org_id AS "orgId", agent_id AS "agentId", wakeup_id AS "wakeupId" FROM kin_wakeups
      WHERE thread_id = ${threadId} AND status = 'running'
      ORDER BY started_at, wakeup_id LIMIT 1`;
    if (row === undefined || (yield* aborted(row))) return false;
    if ((yield* effectiveAudience(row)) !== "owner_only") return false;
    return !(yield* outsideRead(row));
  },
  Effect.catchCause((cause) =>
    Effect.logWarning("Kin full-session check failed; refusing", { cause }).pipe(Effect.as(false)),
  ),
);

/**
 * What the Kin endpoint lists and lets a session call. A T3 tool shows only on a thread whose turns
 * only the owner reads, while GitHub is connected; `kin_delegate` shows only while it isn't. The
 * gate (`KinToolGate`) still checks each call against the running turn.
 */
export const visibleOnKinEndpoint = Effect.fn("KinAgentSession.visible")(
  function* (name: string, threadId: ThreadId) {
    const t3 = isT3Tool(name);
    if (!t3 && name !== "kin_delegate") return true;
    if (t3 && (!leadT3Tools.has(name) || threadId.startsWith(SHARED_THREAD_PREFIX))) return false;
    const kin = yield* KinServer;
    if (Option.isNone(kin.services)) return false;
    const connected = yield* githubConnected.pipe(
      Effect.provideService(KinGitHubLogin, Context.get(kin.services.value, KinGitHubLogin)),
    );
    return t3 ? connected : !connected;
  },
  Effect.catchCause((cause) =>
    Effect.logWarning("Kin tool visibility failed; hiding", { cause }).pipe(Effect.as(false)),
  ),
);

export const endpointVisibility = McpHttpServer.toolVisibility((name) =>
  Effect.gen(function* () {
    const scope = yield* Effect.serviceOption(McpInvocationContext);
    if (Option.isNone(scope) || scope.value.thread === undefined) return false;
    return yield* visibleOnKinEndpoint(name, scope.value.thread.threadId);
  }),
);

export const sessionPolicyLayer = Layer.effect(
  KinAgentSessionPolicy,
  Effect.gen(function* () {
    const login = yield* KinGitHubLogin;
    const sql = yield* SqlClient.SqlClient;
    return KinAgentSessionPolicy.of({
      connected: login.connected,
      admitted: Effect.fn("KinAgentSessionPolicy.admitted")((threadId: ThreadId) =>
        fullSessionAdmitted(threadId).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      ),
      ghDirectory: login.ghDirectory,
      agentName: Effect.fn("KinAgentSessionPolicy.agentName")(
        function* (threadId: ThreadId) {
          const [row] = yield* sql<{
            name: string;
          }>`SELECT l.name FROM orchestration_v2_projection_threads t
            JOIN orchestration_v2_projection_threads r ON r.thread_id =
              COALESCE(json_extract(t.payload_json, '$.lineage.rootThreadId'), t.thread_id)
            JOIN kin_leads l ON r.project_id = 'kin:' || l.org_id || ':' || l.agent_id
            WHERE t.thread_id = ${threadId} ORDER BY l.agent_id LIMIT 1`;
          return row?.name;
        },
        Effect.orElseSucceed(() => undefined),
      ),
    });
  }),
);
