import type { KinAgentId, KinOrgId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as KinShell from "../shell/KinShell.ts";
import { sectionOfTool } from "../shell/sections.ts";
import * as McpToolPolicy from "../mcp/toolPolicy.ts";
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
import { KinIdentity } from "../chat/KinIdentity.ts";
import { KinServer } from "../KinServer.ts";
import { approvalOf } from "../questions/approval.ts";
import { aborted, effectiveAudience, SESSION_REFUSAL, SHARED_THREAD_PREFIX } from "./Audience.ts";
import { markOutside, outsideRead } from "./OutsideContent.ts";
import { KinAgentSessionPolicy } from "./sessionPolicy.ts";
import { listedOnSharedThread } from "./SharedTools.ts";
import { REVIEW_THREAD_PREFIX, REVIEW_TOOLS } from "./outsideReview.ts";
import { CODING_T3_TOOLS, isEngineeringDomain, LEAD_T3_TOOLS } from "./t3Tools.ts";
import { wakeupOfRuns } from "../chat/wakeupRuns.ts";
import { isSocialTool } from "../social/mcp.ts";
import { socialSeatThread } from "../social/seat.ts";
import { seatOf } from "./characterDefaults.ts";

const leadT3Tools: ReadonlySet<string> = new Set(LEAD_T3_TOOLS);
const codingT3Tools: ReadonlySet<string> = new Set(CODING_T3_TOOLS);

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

/**
 * Where a thread's task links lead, and the Kin turn its built-in tools follow: its own running
 * wake-up (`lead`), a plain T3 tree (`ordinary`), a task under a lead's thread at any depth (`kin`,
 * the wake-up of the run that asked for its first link), or links that never reach a root.
 */
const governingTurn = Effect.fnUntraced(function* (threadId: ThreadId) {
  const sql = yield* SqlClient.SqlClient;
  const [own] = yield* sql<Turn>`
    SELECT org_id AS "orgId", agent_id AS "agentId", wakeup_id AS "wakeupId" FROM kin_wakeups
    WHERE thread_id = ${threadId} AND status = 'running'
    ORDER BY started_at, wakeup_id LIMIT 1`;
  if (own !== undefined) return { lineage: "lead", delegated: false, turn: own } as const;
  const seen = new Set<string>([threadId]);
  let current: string = threadId;
  for (;;) {
    const [link] = yield* sql<{ threadId: string; runId: string | null; lead: number }>`
      SELECT s.thread_id AS "threadId", s.run_id AS "runId",
        EXISTS (SELECT 1 FROM kin_wakeups w WHERE w.thread_id = s.thread_id) AS lead
      FROM orchestration_v2_projection_subagents s
      WHERE s.child_thread_id = ${current} AND s.origin = 'app_owned' ORDER BY s.subagent_id LIMIT 1`;
    if (link === undefined)
      return { lineage: "ordinary", delegated: false, turn: undefined } as const;
    if (link.lead === 1) {
      const [turn] =
        link.runId === null
          ? []
          : yield* wakeupOfRuns(
              sql,
              sql`SELECT run_id, thread_id, ordinal, payload_json FROM orchestration_v2_projection_runs
                WHERE run_id = ${link.runId} AND thread_id = ${link.threadId}`,
              sql`w.thread_id = ${link.threadId}`,
            );
      return {
        lineage: "kin",
        delegated: true,
        turn,
      } as const;
    }
    if (seen.has(link.threadId))
      return { lineage: "unresolved", delegated: true, turn: undefined } as const;
    seen.add(link.threadId);
    current = link.threadId;
  }
});

/**
 * Why a thread's built-in tools (shell, edits, web, sub-agents) may not run now, or `undefined`
 * when they may: the turn it follows (`governingTurn`) is owner-only, not aborted for its
 * audience, has read no outside text, and is no approved draft's (`approvalOf`), whose content a
 * teammate's turn wrote. No such turn admits nothing. A delegated task follows its asking turn.
 */
export const fullSessionRefusal = Effect.fn("KinAgentSession.fullSessionRefusal")(
  function* (threadId: ThreadId) {
    const { turn } = yield* governingTurn(threadId);
    if (turn === undefined) return SESSION_REFUSAL.none;
    if ((yield* approvalOf(turn))._tag !== "none") return SESSION_REFUSAL.approved;
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

/**
 * A session's own web search or page fetch: its results are outside text, so the turn it follows
 * is marked before they reach the model, by the page's host when it has one. No such turn, or a
 * failed mark, refuses it.
 */
export const webSearchRefusal = Effect.fn("KinAgentSession.webSearchRefusal")(
  function* (threadId: ThreadId, host?: string) {
    const { turn } = yield* governingTurn(threadId);
    if (turn === undefined) return SESSION_REFUSAL.none;
    if (yield* aborted(turn)) return SESSION_REFUSAL.aborted;
    yield* markOutside(turn, host === undefined ? "web search" : `web:${host.slice(0, 120)}`);
    return undefined;
  },
  Effect.catchCause((cause) =>
    Effect.logWarning("Kin web search check failed; refusing", { cause }).pipe(
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
      Effect.as({ lineage: "unresolved", delegated: true, turn: undefined } as const),
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

/** The remit of the lead whose live own thread this is, and those of its org's other live leads. */
const threadSeat = Effect.fn("KinAgentSession.threadSeat")(
  function* (threadId: ThreadId) {
    const services = Option.flatMap(yield* Effect.serviceOption(KinServer), (kin) => kin.services);
    if (Option.isNone(services)) return undefined;
    const sql = Context.get(services.value, SqlClient.SqlClient);
    // A thread id is unique across orgs; the joins keep every lead in the thread's own org.
    const leads = yield* sql<{ domain: string; own: number }>`SELECT l.domain,
        l.agent_id = t.agent_id AS own FROM kin_agent_threads t
      JOIN kin_leads l ON l.org_id = t.org_id
      JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id AND a.retired_at IS NULL
      WHERE t.thread_id = ${threadId} AND t.ended_at IS NULL ORDER BY own DESC, l.agent_id`;
    const own = leads[0];
    if (own === undefined || own.own !== 1) return undefined;
    const seat = isEngineeringDomain(own.domain) ? "engineering" : seatOf(own.domain);
    return { seat, others: leads.slice(1).map((lead) => seatOf(lead.domain)) };
  },
  Effect.catchCause((cause) =>
    Effect.logWarning("Kin seat tool visibility failed", { cause }).pipe(Effect.as(undefined)),
  ),
);

/**
 * Money and pipeline tools an engineering or social lead leaves to the seat they belong to, once
 * the company has a lead in it; with none, every lead keeps them.
 */
const SEAT_HOME: Readonly<Record<string, string>> = {
  statement_read: "finance",
  statement_rows: "finance",
  bills_add: "finance",
  bill_read: "finance",
  money_query: "finance",
  money_summary: "finance",
  payment_record: "finance",
  budget_set: "finance",
  kin_receipt: "finance",
  pipeline_read: "growth",
  deal_stages: "growth",
};
const LEAVES_TO_HOME: ReadonlySet<string> = new Set(["engineering", "social"]);

/** The name of the lead whose thread this is, or whose turn delegated this task. */
export const leadNameOf = Effect.fn("KinAgentSession.leadNameOf")(
  function* (threadId: ThreadId) {
    const sql = yield* SqlClient.SqlClient;
    const [own] = yield* sql<{ name: string }>`SELECT l.name FROM kin_wakeups w
      JOIN kin_leads l ON l.org_id = w.org_id AND l.agent_id = w.agent_id
      WHERE w.thread_id = ${threadId} ORDER BY w.started_at DESC, w.wakeup_id LIMIT 1`;
    if (own !== undefined) return own.name;
    const { turn } = yield* governingTurn(threadId);
    if (turn === undefined) return undefined;
    const [lead] = yield* sql<{ name: string }>`SELECT name FROM kin_leads
      WHERE org_id = ${turn.orgId} AND agent_id = ${turn.agentId} ORDER BY agent_id`;
    return lead?.name;
  },
  Effect.orElseSucceed((): string | undefined => undefined),
);

/** Kin's GitHub tools work through the owner's own login, so they show only while it's connected. */
const isKinGitHubTool = (name: string) => name.startsWith("kin_github_");
const LOGIN_GITHUB_TOOLS = new Set([
  "kin_github_review",
  "kin_github_review_ask",
  "kin_github_watch",
  "kin_github_link",
]);
const loginConnected = Effect.gen(function* () {
  const kin = yield* Effect.serviceOption(KinServer);
  if (Option.isNone(kin) || Option.isNone(kin.value.services)) return false;
  return yield* Context.get(kin.value.services.value, KinGitHubLogin).connected();
});

/**
 * What the Kin endpoint lists, per thread so every turn of it sends the same list (prompt cache).
 * Shared threads list only what shared turns may run, an outside review's only `REVIEW_TOOLS`; T3
 * tools only an owner-only thread, its coding ones only an engineering lead's (`SEAT_HOME`'s).
 * `KinToolGate` checks each call.
 */
export const visibleOnKinEndpoint = Effect.fn("KinAgentSession.visible")(function* (
  name: string,
  threadId: ThreadId,
) {
  const shared = threadId.startsWith(SHARED_THREAD_PREFIX);
  if (
    threadId.startsWith(REVIEW_THREAD_PREFIX)
      ? !REVIEW_TOOLS.has(name)
      : shared && !listedOnSharedThread(name)
  )
    return false;
  if (isKinGitHubTool(name)) return LOGIN_GITHUB_TOOLS.has(name) && (yield* loginConnected);
  if (isSocialTool(name)) return yield* onSocialSeat(threadId);
  const home = Object.hasOwn(SEAT_HOME, name) ? SEAT_HOME[name] : undefined;
  if (home !== undefined) {
    const lead = yield* threadSeat(threadId);
    return lead === undefined || !LEAVES_TO_HOME.has(lead.seat) || !lead.others.includes(home);
  }
  if (!isT3Tool(name)) return true;
  if (!leadT3Tools.has(name) || shared) return false;
  return !codingT3Tools.has(name) || (yield* threadSeat(threadId))?.seat === "engineering";
});

export const endpointVisibility = McpToolPolicy.toolVisibility((name, method) =>
  Effect.gen(function* () {
    const scope = yield* Effect.serviceOption(McpInvocationContext);
    if (Option.isNone(scope) || scope.value.thread === undefined) return false;
    const section = sectionOfTool(name);
    // Only the list hides a section; the call gate returns the refusal on tools/call.
    if (method === "tools/list" && section !== null) {
      const kin = yield* Effect.serviceOption(KinServer);
      const services = Option.flatMap(kin, (entry) => entry.services);
      if (Option.isNone(services)) return false;
      const { owner } = Context.get(services.value, KinIdentity);
      if (
        !(yield* KinShell.sectionOnFor(owner.orgId, section).pipe(
          Effect.provideContext(services.value),
          Effect.orElseSucceed(() => false),
        ))
      )
        return false;
    }
    return yield* visibleOnKinEndpoint(name, scope.value.thread.threadId);
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
      webSearch: Effect.fn("KinAgentSessionPolicy.webSearch")((threadId: ThreadId, host?: string) =>
        webSearchRefusal(threadId, host).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
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
