import type { HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ClaudeAdapterV2 from "../../../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import {
  type AuthSettings,
  makeConfiner,
  sessionEnvironment,
  withConfinementHook,
} from "../../../claudeConfinement.ts";
import { type KinSessionPlan, KinSessions } from "../session.ts";
import type { KinProvider } from "./provider.ts";

const DRIVER = "claudeAgent";

/** Claude Code's built-ins by what they do (`claude-agent-sdk`). */
const capabilities = {
  shell: ["Bash", "PowerShell"],
  backgroundShell: ["BashOutput", "KillShell", "KillBash", "Monitor"],
  readFiles: ["Read", "Grep", "Glob"],
  editFiles: ["Edit", "MultiEdit", "Write", "NotebookEdit"],
  webSearch: ["WebSearch"],
  webFetch: ["WebFetch"],
  viewImage: ["Read"],
  subAgents: ["Task", "Agent", "Workflow"],
} as const;

/**
 * All of them, refused by name too in a confined session: its shell would run as the server's OS
 * user, which can mint an owner session. Holds if a later wrapper widens `tools`.
 */
export const builtinTools = [...new Set(Object.values(capabilities).flat())];
/** The one built-in a confined session keeps: it runs at Anthropic and opens nothing from here. */
const CONFINED_SEARCH = "WebSearch";

/**
 * Built-ins an owner turn can't use: they wait for someone at the screen, or Kin does the job
 * itself (kin_ask, kin_defer, kin_schedule). A delegated task keeps them for T3 to answer.
 */
export const OWNER_SEAT_OFF = [
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "EnterWorktree",
  "ExitWorktree",
  "CronCreate",
  "CronDelete",
  "CronList",
  "ScheduleWakeup",
  "PushNotification",
  "RemoteTrigger",
];

/** What it posts ends with its own signature (`ghSign.ts`), not Claude Code's footer. */
const NO_PROVIDER_FOOTER = {
  attribution: { commit: "", pr: "", sessionUrl: false },
  includeCoAuthoredBy: false,
} as const;

type Options = ClaudeAdapterV2.ClaudeAgentSdkQueryOptions;

/**
 * Kin's core carries `anthropic/alwaysLoad` from registration (`deferredTools.ts`) and loads up
 * front; with ToolSearch on, Claude Code holds every other MCP tool back until it is searched for.
 */
const kinTools = (options: Options, plan: KinSessionPlan) =>
  options.mcpServers === undefined || !plan.toolSearch
    ? { search: "false" as const, mcpServers: undefined }
    : { search: "true" as const, mcpServers: options.mcpServers };

/**
 * One Kin session on Claude: no settings file (memory might carry a `CLAUDE.md`, `.mcp.json` or
 * hooks; the user's settings carry plugins and env), only the owner's model credentials, Kin's
 * instructions as the whole system prompt, and a PreToolUse hook that asks the plan per call.
 */
const apply = (
  options: Options,
  plan: KinSessionPlan,
  session: {
    readonly hook: HookCallbackMatcher;
    readonly auth: AuthSettings;
    readonly environment: NodeJS.ProcessEnv;
  },
): Options => {
  // Narrow, never widen: a dream's `[]` stays `[]` whichever wrapper runs first.
  if (plan.seat === "dream") return { ...options, settingSources: [] };
  const { settings, env } = options;
  const environment = sessionEnvironment(env ?? session.environment);
  const loading = kinTools(options, plan);
  const confined = plan.seat === "confined";
  return {
    ...options,
    settingSources: [],
    ...(plan.instructions === undefined
      ? {}
      : { systemPrompt: { type: "custom" as const, prompt: plan.instructions, snapshot: false } }),
    ...(confined
      ? {
          tools: [
            ...(loading.search === "true" ? ["ToolSearch"] : []),
            ...(plan.nativeSearch ? [CONFINED_SEARCH] : []),
          ],
          disallowedTools: [
            ...new Set([
              ...(options.disallowedTools ?? []),
              ...builtinTools.filter((name) => !plan.nativeSearch || name !== CONFINED_SEARCH),
            ]),
          ],
        }
      : plan.seat === "owner"
        ? { disallowedTools: [...new Set([...(options.disallowedTools ?? []), ...OWNER_SEAT_OFF])] }
        : {}),
    ...(loading.mcpServers === undefined ? {} : { mcpServers: loading.mcpServers }),
    // The user's own MCP servers and plugins could hand a lead a shell again.
    strictMcpConfig: true,
    hooks: withConfinementHook(options.hooks, session.hook),
    // A settings file path can't take keys.
    ...(typeof settings === "string"
      ? {}
      : {
          settings: {
            ...session.auth,
            ...settings,
            ...(confined ? {} : NO_PROVIDER_FOOTER),
            // Its folder is named after the host's account: a lead never sees it (G07).
            autoMemoryEnabled: false,
            autoDreamEnabled: false,
            env: { ...session.auth.env, ...settings?.env, ENABLE_TOOL_SEARCH: loading.search },
          },
        }),
    env: {
      ...environment,
      ...(plan.shell === undefined
        ? {}
        : {
            PATH: plan.shell.path,
            ...(plan.shell.agentName === undefined ? {} : { KIN_AGENT_NAME: plan.shell.agentName }),
          }),
      ENABLE_TOOL_SEARCH: loading.search,
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      // Every wake-up is a fresh session: its first request otherwise may go out before Kin's
      // tools are listed, and a different tool block misses the prompt cache.
      ...(plan.seat === "delegated" ? {} : { MCP_CONNECTION_NONBLOCKING: "0" }),
    },
  };
};

const refused = (reason?: string) => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse" as const,
    permissionDecision: "deny" as const,
    ...(reason === undefined ? {} : { permissionDecisionReason: reason }),
  },
});

/**
 * The plan's decision as a PreToolUse hook. It runs in this process before Claude Code's
 * permission modes, so its deny holds under bypassPermissions too; `block` refuses the call if the
 * hook throws or times out. Kin's own tools answer to Kin's gates, except in a delegated task, whose
 * MCP tools are T3's.
 */
const decisionHook = (plan: KinSessionPlan): HookCallbackMatcher => ({
  onFailure: "block",
  hooks: [
    async (input) => {
      if (input.hook_event_name !== "PreToolUse") return {};
      const kinTool = input.tool_name.startsWith("mcp__") || input.tool_name === "ToolSearch";
      if (plan.seat === "confined") {
        if (kinTool) return {};
        if (input.tool_name !== CONFINED_SEARCH) return refused();
        const reason = await Effect.runPromise(plan.webSearch);
        return reason === undefined ? {} : refused(reason);
      }
      if (kinTool && plan.seat !== "delegated") return {};
      const reason = await Effect.runPromise(plan.refusal);
      return reason === undefined ? {} : refused(reason);
    },
  ],
});

const install = <E, R>(base: Layer.Layer<ClaudeAdapterV2.ClaudeAgentSdkQueryRunner, E, R>) =>
  Layer.effect(
    ClaudeAdapterV2.ClaudeAgentSdkQueryRunner,
    Effect.gen(function* () {
      const runner = yield* ClaudeAdapterV2.ClaudeAgentSdkQueryRunner;
      const sessions = yield* KinSessions;
      if (!sessions.enabled) return runner;
      const confiner = yield* makeConfiner();
      return ClaudeAdapterV2.ClaudeAgentSdkQueryRunner.of({
        ...runner,
        open: Effect.fn("KinClaude.open")(function* (input) {
          const environment = yield* HostProcess.Environment;
          const plan = yield* sessions.plan({
            threadId: input.threadId,
            cwd: input.options.cwd,
            driver: DRIVER,
            path: (input.options.env ?? environment).PATH,
            // Claude Code turns its ToolSearch off for a model without tool_reference blocks and
            // then lists every tool up front, so a deferred tool stays reachable on any model.
            toolLookup: true,
          });
          if (plan === undefined) return yield* runner.open(input);
          return yield* runner.open({
            ...input,
            options: apply(input.options, plan, {
              hook: decisionHook(plan),
              auth: yield* confiner.ownerAuth(input.options.env),
              environment,
            }),
          });
        }),
      });
    }),
  ).pipe(Layer.provide(Layer.merge(base, KinSessions.layer)));

export const claude = {
  driver: DRIVER,
  capabilities,
  install,
} satisfies KinProvider<ClaudeAdapterV2.ClaudeAgentSdkQueryRunner>;
