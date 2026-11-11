import type { HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ClaudeAdapterV2 from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import {
  type AuthSettings,
  makeConfiner,
  sessionEnvironment,
  withConfinementHook,
} from "../claudeConfinement.ts";

export const threadPrefix = "kin-dream:";
export const dreamTools = ["Read", "Edit", "Write", "Glob", "Grep"];
const blockedTools = ["Bash", "WebFetch", "WebSearch"];
/** Flags that change who approves a tool call; a dream refuses an instance launched with one. */
export const permissionFlag = /permission|dangerously|^allowed-?tools$/i;
// Flag settings load whatever settingSources says, so only model-selection keys survive.
const keptSettings = new Set([
  "alwaysThinkingEnabled",
  "fastMode",
  "ultracode",
  "showThinkingSummaries",
  "autoCompactWindow",
]);

// Modes that already ask at least as often as acceptEdits; anything wider is narrowed to it.
const narrowModes = new Set<string>(["default", "plan", "dontAsk", "acceptEdits"]);

/**
 * Dream material is untrusted, so a dream query loads no user, project or flag config and no MCP server,
 * apart from the owner's model credentials, and its only tools read and edit the checkout. Approvals for anything else reach DreamSession, which declines.
 */
const isolateClaudeDream = (
  options: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions,
  auth: AuthSettings,
  confinement: HookCallbackMatcher,
  environment: NodeJS.ProcessEnv,
): ClaudeAdapterV2.ClaudeAgentSdkQueryOptions => {
  const {
    mcpServers: _mcpServers,
    allowedTools: _allowedTools,
    additionalDirectories: _additionalDirectories,
    allowDangerouslySkipPermissions: _skip,
    hooks: _hooks,
    plugins: _plugins,
    agents: _agents,
    projectConfigRoot: _projectConfigRoot,
    toolAliases: _toolAliases,
    permissionPromptToolName: _permissionPromptToolName,
    permissionPrompts: _permissionPrompts,
    managedSettings: _managedSettings,
    agent: _agent,
    skills: _skills,
    sandbox: _sandbox,
    pluginDelivery: _pluginDelivery,
    fallbackModel: _fallbackModel,
    executable: _executable,
    spawnClaudeCodeProcess: _spawn,
    forkSession: _forkSession,
    promptSuggestions: _promptSuggestions,
    settings,
    extraArgs,
    permissionMode,
    env,
    ...rest
  } = options;
  const kept: Record<string, unknown> = {
    ...(typeof settings === "object" && settings !== null
      ? Object.fromEntries(Object.entries(settings).filter(([key]) => keptSettings.has(key)))
      : {}),
    ...auth,
  };
  const thinking = extraArgs?.["thinking-display"];
  return {
    ...rest,
    // The prefix is not reserved, so the wrapper may narrow a thread's mode but never widen it.
    permissionMode: narrowModes.has(permissionMode) ? permissionMode : "acceptEdits",
    settingSources: [],
    strictMcpConfig: true,
    tools: dreamTools,
    disallowedTools: blockedTools,
    // Edit and Write are confined like the reads: the real checkout and nothing outside it.
    hooks: withConfinementHook(undefined, confinement),
    env: sessionEnvironment(env ?? environment),
    ...(Object.keys(kept).length === 0 ? {} : { settings: kept }),
    ...(thinking === undefined ? {} : { extraArgs: { "thinking-display": thinking } }),
  };
};

/** Every field a dream query may carry; the test fails if the adapter starts passing anything else. */
export const dreamOptionFields = new Set([
  "model",
  "effort",
  "thinking",
  "includePartialMessages",
  "resume",
  "sessionId",
  "resumeSessionAt",
  "canUseTool",
  "onUserDialog",
  "onElicitation",
  "supportedDialogKinds",
  "pathToClaudeCodeExecutable",
  "env",
  "cwd",
  "systemPrompt",
  "permissionMode",
  "hooks",
  "settingSources",
  "strictMcpConfig",
  "tools",
  "disallowedTools",
  "settings",
  "extraArgs",
]);

/** Wraps the Claude query runner; a no-op for every thread that is not a Kin dream. */
export const claudeQueryRunner = <E, R>(
  base: Layer.Layer<ClaudeAdapterV2.ClaudeAgentSdkQueryRunner, E, R>,
) =>
  Layer.effect(
    ClaudeAdapterV2.ClaudeAgentSdkQueryRunner,
    Effect.gen(function* () {
      const runner = yield* ClaudeAdapterV2.ClaudeAgentSdkQueryRunner;
      const confiner = yield* makeConfiner();
      return ClaudeAdapterV2.ClaudeAgentSdkQueryRunner.of({
        ...runner,
        open: Effect.fn("KinDreamIsolation.open")(function* (input) {
          if (!input.threadId.startsWith(threadPrefix)) return yield* runner.open(input);
          const auth = yield* confiner.ownerAuth(input.options.env);
          const root = yield* confiner.root(input.options.cwd);
          const confinement = confiner.hook({ root, tools: dreamTools });
          const environment = yield* HostProcess.Environment;
          return yield* runner.open({
            ...input,
            options: isolateClaudeDream(input.options, auth, confinement, environment),
          });
        }),
      });
    }),
  ).pipe(Layer.provide(base));
