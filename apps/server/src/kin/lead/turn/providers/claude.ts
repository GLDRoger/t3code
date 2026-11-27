import type { HookCallback, HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ClaudeAdapterV2 from "../../../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { ServerSettingsService } from "../../../../serverSettings.ts";
import {
  type AuthSettings,
  makeConfiner,
  sessionEnvironment,
  withConfinementHook,
} from "../../../claudeConfinement.ts";
import { type KinSessionPlan, KinSessions } from "../session.ts";
import * as SessionContext from "../sessionContext.ts";
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

export const OWNER_SEAT_NATIVE_TOOLS = ["Bash", "Read", "Edit", "Write", "WebSearch"] as const;

export const OWNER_SEAT_NO_SUBAGENTS = [
  "Agent",
  "Task",
  "Workflow",
  "ListAgents",
  "ReportFindings",
  "SendMessage",
  "TaskStop",
  "DesignSync",
  "Skill",
] as const;

/** What it posts ends with its own signature (`ghSign.ts`), not Claude Code's footer. */
const NO_PROVIDER_FOOTER = {
  attribution: { commit: "", pr: "", sessionUrl: false },
  includeCoAuthoredBy: false,
} as const;

type Options = ClaudeAdapterV2.ClaudeAgentSdkQueryOptions;

/**
 * With ToolSearch on, Claude Code defers MCP tools without `anthropic/alwaysLoad`;
 * Kin's registration controls those markers independently of mounting the server.
 */
const kinTools = (options: Options, plan: KinSessionPlan) =>
  options.mcpServers === undefined || !plan.toolSearch
    ? { search: "false" as const, mcpServers: undefined }
    : { search: "true" as const, mcpServers: options.mcpServers };

const nativeTools = (plan: KinSessionPlan, search: boolean) => {
  if (plan.seat === "delegated") return undefined;
  const lookup = search ? ["ToolSearch"] : [];
  switch (plan.abilities) {
    case "shellAndFiles":
      return [...OWNER_SEAT_NATIVE_TOOLS, ...lookup];
    case "lookup":
      return [...lookup, CONFINED_SEARCH];
    case "none":
      return lookup;
  }
};

const ownerContextHooks = (
  hooks: NonNullable<Options["hooks"]>,
  prepared: () => ReturnType<SessionContext.KinSessionContext["Service"]["forThread"]>,
  take: () => string | undefined,
  logCompaction: (summaryLength: number) => Promise<void>,
): NonNullable<Options["hooks"]> => {
  const append = (
    event: "SessionStart" | "UserPromptSubmit" | "PreCompact" | "PostCompact",
    hook: HookCallback,
  ): HookCallbackMatcher[] => [...(hooks[event] ?? []), { onFailure: "continue", hooks: [hook] }];
  return {
    ...hooks,
    SessionStart: append("SessionStart", async (input) => {
      if (
        input.hook_event_name !== "SessionStart" ||
        (input.source !== "startup" && input.source !== "compact")
      )
        return {};
      const standing = prepared()?.standing;
      return standing
        ? { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: standing } }
        : {};
    }),
    UserPromptSubmit: append("UserPromptSubmit", async (input) => {
      if (input.hook_event_name !== "UserPromptSubmit") return {};
      const delta = take();
      return delta
        ? { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: delta } }
        : {};
    }),
    PreCompact: append("PreCompact", async () => ({})),
    PostCompact: append("PostCompact", async (input) => {
      if (input.hook_event_name === "PostCompact")
        await logCompaction(input.compact_summary.length);
      return {};
    }),
  };
};

/**
 * One Kin session on Claude: no settings file (memory might carry a `CLAUDE.md`, `.mcp.json` or
 * hooks; the user's settings carry plugins and env), only the owner's model credentials, Kin's
 * instructions as the whole system prompt, and a PreToolUse hook that asks the plan per call.
 */
const apply = (
  options: Options,
  plan: KinSessionPlan,
  session: {
    readonly hook: HookCallbackMatcher | undefined;
    readonly auth: AuthSettings;
    readonly environment: NodeJS.ProcessEnv;
    readonly context: SessionContext.KinSessionContext["Service"] | undefined;
    readonly logCompaction: (summaryLength: number) => Promise<void>;
  },
): Options => {
  // Narrow, never widen: a dream's `[]` stays `[]` whichever wrapper runs first.
  if (plan.seat === "dream") return { ...options, settingSources: [] };
  const { settings, env } = options;
  const environment = sessionEnvironment(env ?? session.environment);
  const loading = kinTools(options, plan);
  const tools = nativeTools(plan, loading.search === "true");
  const confined = plan.seat === "confined";
  const owner = plan.seat === "owner";
  const hooks =
    session.hook === undefined ? undefined : withConfinementHook(options.hooks, session.hook);
  return {
    ...options,
    settingSources: [],
    ...(plan.instructions === undefined
      ? {}
      : { systemPrompt: { type: "custom" as const, prompt: plan.instructions, snapshot: false } }),
    ...(tools === undefined ? {} : { tools }),
    ...(confined
      ? {
          disallowedTools: [
            ...new Set([
              ...(options.disallowedTools ?? []),
              ...builtinTools.filter((name) => !plan.nativeSearch || name !== CONFINED_SEARCH),
            ]),
          ],
        }
      : owner
        ? {
            disallowedTools: [
              ...new Set([
                ...(options.disallowedTools ?? []),
                ...OWNER_SEAT_OFF,
                ...OWNER_SEAT_NO_SUBAGENTS,
              ]),
            ],
          }
        : {}),
    ...(loading.mcpServers === undefined ? {} : { mcpServers: loading.mcpServers }),
    // The user's own MCP servers and plugins could hand a lead a shell again.
    strictMcpConfig: true,
    ...(hooks === undefined
      ? {}
      : {
          hooks:
            plan.seat === "owner"
              ? ownerContextHooks(
                  hooks,
                  () => session.context?.forThread(plan.thread),
                  () => session.context?.take(plan.thread),
                  session.logCompaction,
                )
              : hooks,
        }),
    // A settings file path can't take keys.
    ...(typeof settings === "string"
      ? {}
      : {
          settings: {
            ...session.auth,
            ...settings,
            ...(confined ? {} : NO_PROVIDER_FOOTER),
            ...(owner
              ? { disableBundledSkills: true, disableWorkflows: true, disableAgentView: true }
              : {}),
            // Its folder is named after the host's account: a lead never sees it (G07).
            autoMemoryEnabled: false,
            autoDreamEnabled: false,
            ...(plan.seat === "owner" ? { idleCompaction: false } : {}),
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
      ...(plan.seat === "owner" && environment.CLAUDE_CODE_PROMPT_CACHE_TTL === undefined
        ? { CLAUDE_CODE_PROMPT_CACHE_TTL: "1h" }
        : {}),
      // Wait for Kin's tools before the first request; a different tool block misses the cache.
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

const WEB_READS: ReadonlySet<string> = new Set([
  ...capabilities.webSearch,
  ...capabilities.webFetch,
]);
/** The host of a page fetch's `url`; a search has none. */
const hostOf = (input: unknown) => {
  const url =
    typeof input === "object" && input !== null ? (input as { url?: unknown }).url : undefined;
  return typeof url === "string" && URL.canParse(url) ? new URL(url).hostname : undefined;
};

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
      if (reason !== undefined) return refused(reason);
      if (!WEB_READS.has(input.tool_name)) return {};
      // What it reads is outside text: the turn is marked before the result reaches the model.
      const marked = await Effect.runPromise(plan.webRead(hostOf(input.tool_input)));
      return marked === undefined ? {} : refused(marked);
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
      const context = Option.getOrUndefined(
        yield* Effect.serviceOption(SessionContext.KinSessionContext),
      );
      const settings = yield* Effect.serviceOption(ServerSettingsService);
      let reportedMissingContext = false;
      const runHook = Effect.runPromiseWith(yield* Effect.context<never>());
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
          if (
            plan.seat === "owner" &&
            !input.refresh &&
            context === undefined &&
            !reportedMissingContext &&
            Option.isSome(settings)
          ) {
            const carryEnabled = yield* settings.value.getSettings.pipe(
              Effect.map(({ kinSessionCarry }) => kinSessionCarry),
              Effect.orElseSucceed(() => false),
            );
            if (carryEnabled && !reportedMissingContext) {
              reportedMissingContext = true;
              yield* Effect.logError("Kin Claude owner seat is missing KinSessionContext");
            }
          }
          return yield* runner.open({
            ...input,
            options: apply(input.options, plan, {
              // The refresh already denies all tools; the normal policy hook could mark a wake-up.
              hook: input.refresh ? undefined : decisionHook(plan),
              auth: yield* confiner.ownerAuth(input.options.env),
              environment,
              context,
              logCompaction: (summaryLength) =>
                runHook(
                  Effect.logDebug("kin.claude.compact_summary", {
                    threadId: plan.thread,
                    summaryLength,
                  }),
                ),
            }),
          });
        }),
      });
    }),
  ).pipe(Layer.provide(Layer.merge(base, KinSessions.layer)));

export const claude = {
  driver: DRIVER,
  lookup: "provider",
  turnContextBeside: true,
  capabilities,
  install,
} satisfies KinProvider<ClaudeAdapterV2.ClaudeAgentSdkQueryRunner>;
