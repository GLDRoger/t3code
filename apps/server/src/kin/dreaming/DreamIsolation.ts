import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ClaudeAdapterV2 from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { resolveClaudeHomePath } from "../../provider/Drivers/ClaudeHome.ts";

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

// How Claude reaches its model (a gateway, Bedrock, Vertex). Read from the owner's user settings
// only, never the dream checkout's project settings.
const authEnv = /^(ANTHROPIC_|CLAUDE_CODE_USE_|CLOUD_ML_REGION$|AWS_|VERTEX_REGION)/;
const UserAuthSettings = Schema.fromJsonString(
  Schema.Struct({
    apiKeyHelper: Schema.optional(Schema.String),
    env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  }),
);
type AuthSettings = { apiKeyHelper?: string; env?: Record<string, string> };

// Modes that already ask at least as often as acceptEdits; anything wider is narrowed to it.
const narrowModes = new Set<string>(["default", "plan", "dontAsk", "acceptEdits"]);

/**
 * Dream material is untrusted, so a dream query loads no user, project or flag config and no MCP server,
 * apart from the owner's model credentials, and its only tools read and edit the checkout. Approvals for anything else reach DreamSession, which declines.
 */
const isolateClaudeDream = (
  options: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions,
  auth: AuthSettings,
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
    settings,
    extraArgs,
    permissionMode,
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
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const readAuth = Effect.fn("KinDreamIsolation.readAuth")(function* (
        env: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions["env"],
      ) {
        const home = yield* resolveClaudeHomePath({ homePath: "" }, env ?? process.env).pipe(
          Effect.provideService(Path.Path, path),
        );
        const parsed = yield* fs.readFileString(path.join(home, "settings.json")).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(UserAuthSettings)),
          Effect.orElseSucceed(() => ({}) as AuthSettings),
        );
        const authOnly = Object.entries(parsed.env ?? {}).filter(([key]) => authEnv.test(key));
        const auth: AuthSettings = {
          ...(parsed.apiKeyHelper === undefined ? {} : { apiKeyHelper: parsed.apiKeyHelper }),
          ...(authOnly.length === 0 ? {} : { env: Object.fromEntries(authOnly) }),
        };
        return auth;
      });
      return ClaudeAdapterV2.ClaudeAgentSdkQueryRunner.of({
        ...runner,
        open: Effect.fn("KinDreamIsolation.open")(function* (input) {
          if (!input.threadId.startsWith(threadPrefix)) return yield* runner.open(input);
          const auth = yield* readAuth(input.options.env);
          return yield* runner.open({ ...input, options: isolateClaudeDream(input.options, auth) });
        }),
      });
    }),
  ).pipe(Layer.provide(base));
