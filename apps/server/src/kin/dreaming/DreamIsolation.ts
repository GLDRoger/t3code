import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ClaudeAdapterV2 from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";

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

/**
 * Dream material is untrusted, so a dream query loads no user, project or flag config and no MCP server,
 * and its only tools read and edit the checkout. Approvals for anything else reach DreamSession, which declines.
 */
const isolateClaudeDream = (
  options: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions,
): ClaudeAdapterV2.ClaudeAgentSdkQueryOptions => {
  const {
    mcpServers: _mcpServers,
    allowedTools: _allowedTools,
    additionalDirectories: _additionalDirectories,
    allowDangerouslySkipPermissions: _skip,
    hooks: _hooks,
    plugins: _plugins,
    agents: _agents,
    settings,
    extraArgs,
    ...rest
  } = options;
  const kept =
    typeof settings === "object" && settings !== null
      ? Object.fromEntries(Object.entries(settings).filter(([key]) => keptSettings.has(key)))
      : {};
  const thinking = extraArgs?.["thinking-display"];
  return {
    ...rest,
    permissionMode: "acceptEdits",
    settingSources: [],
    strictMcpConfig: true,
    tools: dreamTools,
    disallowedTools: blockedTools,
    ...(Object.keys(kept).length === 0 ? {} : { settings: kept }),
    ...(thinking === undefined ? {} : { extraArgs: { "thinking-display": thinking } }),
  };
};

/** Wraps the Claude query runner; a no-op for every thread that is not a Kin dream. */
export const claudeQueryRunner = <E, R>(
  base: Layer.Layer<ClaudeAdapterV2.ClaudeAgentSdkQueryRunner, E, R>,
) =>
  Layer.effect(
    ClaudeAdapterV2.ClaudeAgentSdkQueryRunner,
    Effect.gen(function* () {
      const runner = yield* ClaudeAdapterV2.ClaudeAgentSdkQueryRunner;
      return ClaudeAdapterV2.ClaudeAgentSdkQueryRunner.of({
        ...runner,
        open: Effect.fn("KinDreamIsolation.open")(function* (input) {
          return yield* runner.open(
            input.threadId.startsWith(threadPrefix)
              ? { ...input, options: isolateClaudeDream(input.options) }
              : input,
          );
        }),
      });
    }),
  ).pipe(Layer.provide(base));
