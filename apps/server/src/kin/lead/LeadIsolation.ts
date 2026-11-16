import type { HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { ServerConfig } from "../../config.ts";
import * as ClaudeAdapterV2 from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import {
  type AuthSettings,
  type FileScope,
  makeConfiner,
  permits,
  sessionEnvironment,
  withConfinementHook,
} from "../claudeConfinement.ts";
import { KinServer } from "../KinServer.ts";
import { KinAgentSessionPolicy } from "./sessionPolicy.ts";
import { KinEnabled, layer as kinEnabledLayer } from "../KinEnabled.ts";
import { threadPrefix as dreamThreadPrefix } from "../dreaming/DreamIsolation.ts";
import { SHARED_THREAD_PREFIX } from "./Audience.ts";
import { instructions } from "./instructions.ts";

/** A lead's only built-in tools. Kin's MCP tools arrive separately, through `mcpServers`. */
export const leadTools = ["Read", "Grep", "Glob"];

/**
 * Kin's tools load upfront: a lead that never searched for `kin_chat_post` could not reply. Only
 * the few a tool marks as deferred (`deferredTools.ts`) wait for ToolSearch, which loads schemas
 * of tools the thread already lists and reads nothing.
 */
const toolLoading = (
  options: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions,
): {
  readonly search: "true" | "false";
  readonly mcpServers?: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions["mcpServers"];
} =>
  options.mcpServers === undefined
    ? { search: "false" }
    : {
        search: "true",
        mcpServers: Object.fromEntries(
          Object.entries(options.mcpServers).map(([name, server]) => [
            name,
            { ...server, alwaysLoad: true },
          ]),
        ),
      };

/**
 * A lead's shell would run as the server's OS user, which can mint an owner session or write an
 * attested approver key into the database. Leads act only through Kin tools and read memory.
 * The `leadTools` allowlist already drops these; the deny list holds if a later wrapper widens it.
 */
export const leadBlockedTools = [
  "Bash",
  "BashOutput",
  "KillShell",
  "KillBash",
  "PowerShell",
  "Monitor",
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Task",
  "Agent",
  "Workflow",
];

/**
 * The confinement hook allows only the lead's real memory checkout; these deny rules are a second
 * wall that holds if the hook is ever lost.
 */
const leadSecretReadRules = (config: {
  readonly baseDir: string;
  readonly secretsDir: string;
  readonly dbPath: string;
}) => [
  `Read(/${config.secretsDir}/**)`,
  `Read(/${config.baseDir}/service.env)`,
  `Read(/${config.dbPath}*)`,
  "Read(~/.ssh/**)",
  // Host operator config: the memory deploy key and server env live here (ops/kin/host).
  "Read(~/.config/kin/**)",
  "Read(~/.config/gh/**)",
];

/**
 * A lead is a colleague in a chat, not a coding agent: the Claude Code preset and T3's thread
 * guidance describe tools it doesn't have and cost about 9k tokens a turn, so its instructions are
 * the whole system prompt. A recorded (`snapshot`) prompt would outlive an instructions change.
 */
const leadSystemPrompt = { type: "custom" as const, prompt: instructions, snapshot: false };

const leadOptions = (
  options: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions,
  denied: ReadonlyArray<string>,
  shared: boolean,
  confinement: {
    readonly hook: HookCallbackMatcher;
    readonly auth: AuthSettings;
    readonly environment: NodeJS.ProcessEnv;
  },
) => {
  const { tools, settings, env } = options;
  // A turn someone besides the owner reads gets no file tools: its cwd is the owner's memory.
  const allowed = shared ? [] : leadTools;
  const loading = toolLoading(options);
  const kept = Array.isArray(tools) ? tools.filter((tool) => allowed.includes(tool)) : allowed;
  return {
    systemPrompt: leadSystemPrompt,
    tools: loading.search === "true" ? [...kept, "ToolSearch"] : kept,
    ...(loading.mcpServers === undefined ? {} : { mcpServers: loading.mcpServers }),
    disallowedTools: [
      ...new Set([...(options.disallowedTools ?? []), ...denied, ...(shared ? leadTools : [])]),
    ],
    // The user's own MCP servers and plugins could hand a lead a shell again.
    strictMcpConfig: true,
    hooks: withConfinementHook(options.hooks, confinement.hook),
    // A settings file path can't take keys.
    ...(typeof settings === "string"
      ? {}
      : {
          settings: {
            ...confinement.auth,
            ...settings,
            // Its folder is named after the host's account: a lead never sees it (G07).
            autoMemoryEnabled: false,
            autoDreamEnabled: false,
            env: { ...confinement.auth.env, ...settings?.env, ENABLE_TOOL_SEARCH: loading.search },
          },
        }),
    env: {
      ...sessionEnvironment(env ?? confinement.environment),
      ENABLE_TOOL_SEARCH: loading.search,
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    },
  };
};

/**
 * An owner-only turn with GitHub connected (repos-rethink slice 3): Claude Code's own tools, as any
 * T3 thread has, with the pinned `gh` first on PATH. Its hook still asks per call: a turn others
 * can read, one that read outside text, or a run Kin hasn't adopted gets only the confined tools.
 * A task the lead delegated (`lead: false`) gets the same, under T3's own system prompt.
 */
const fullOptions = (
  options: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions,
  session: {
    readonly hook: HookCallbackMatcher;
    readonly auth: AuthSettings;
    readonly environment: NodeJS.ProcessEnv;
    readonly ghDirectory: string;
    readonly lead: boolean;
  },
) => {
  const { settings, env } = options;
  const environment = sessionEnvironment(env ?? session.environment);
  const loading = toolLoading(options);
  return {
    ...(session.lead ? { systemPrompt: leadSystemPrompt } : {}),
    strictMcpConfig: true,
    ...(loading.mcpServers === undefined ? {} : { mcpServers: loading.mcpServers }),
    hooks: withConfinementHook(options.hooks, session.hook),
    ...(typeof settings === "string"
      ? {}
      : {
          settings: {
            ...session.auth,
            ...settings,
            autoMemoryEnabled: false,
            autoDreamEnabled: false,
            env: { ...session.auth.env, ...settings?.env, ENABLE_TOOL_SEARCH: loading.search },
          },
        }),
    env: {
      ...environment,
      PATH: [session.ghDirectory, environment.PATH].filter(Boolean).join(":"),
      ENABLE_TOOL_SEARCH: loading.search,
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    },
  };
};

/**
 * A lead runs full-access with Kin's memory checkout as its cwd, so its Claude session loads no
 * settings file: not a project `CLAUDE.md`, `.claude/` or `.mcp.json` that memory might carry, nor
 * the user's hooks, plugins and env. It keeps the owner's model credentials. The cwd is the lead
 * project's root, which Kin sets; a match only ever narrows what loads.
 */
export const claudeQueryRunner = <E, R>(
  base: Layer.Layer<ClaudeAdapterV2.ClaudeAgentSdkQueryRunner, E, R>,
) =>
  Layer.effect(
    ClaudeAdapterV2.ClaudeAgentSdkQueryRunner,
    Effect.gen(function* () {
      const runner = yield* ClaudeAdapterV2.ClaudeAgentSdkQueryRunner;
      if (!(yield* KinEnabled).enabled) return runner;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig;
      const kinDirectory = path.join(config.stateDir, "kin");
      const denied = [...leadBlockedTools, ...leadSecretReadRules(config)];
      const confiner = yield* makeConfiner();
      const real = (target: string) => fs.realPath(target).pipe(Effect.orElseSucceed(() => target));
      const within = (parent: string, child: string) => {
        const relative = path.relative(parent, child);
        return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
      };
      const kin = yield* Effect.serviceOption(KinServer);
      const policy = Option.flatMap(kin, (server) =>
        Option.flatMap(server.services, (services) =>
          Context.getOption(services, KinAgentSessionPolicy),
        ),
      );
      const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
      const run = Effect.runPromiseWith(context);
      /**
       * The full session's hook: built-ins while the turn admits them, else the confined set and a
       * line saying why. A delegated task's MCP tools are T3's, which no Kin gate guards.
       */
      const fullHook = (
        threadId: ThreadId,
        confined: FileScope,
        sessions: KinAgentSessionPolicy["Service"],
      ): HookCallbackMatcher => ({
        onFailure: "block",
        hooks: [
          async (input) => {
            if (input.hook_event_name !== "PreToolUse") return {};
            if (input.tool_name.startsWith("mcp__") && confined.mcp !== false) return {};
            const refusal = await run(sessions.refusal(threadId));
            if (
              refusal === undefined ||
              (await run(permits(confined, input.tool_name, input.tool_input)))
            )
              return {};
            return {
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: refusal,
              },
            };
          },
        ],
      });
      return ClaudeAdapterV2.ClaudeAgentSdkQueryRunner.of({
        ...runner,
        open: Effect.fn("KinLeadIsolation.open")(function* (input) {
          const cwd = input.options.cwd;
          const isKin =
            cwd !== undefined &&
            (within(kinDirectory, path.resolve(cwd)) ||
              within(yield* real(kinDirectory), yield* real(cwd)));
          const isDream = input.threadId.startsWith(dreamThreadPrefix);
          // A lead's delegated task runs wherever T3 put it, usually a Scratch folder.
          const delegated =
            !isDream && Option.isSome(policy) && (yield* policy.value.delegated(input.threadId));
          if (!isKin && !delegated) return yield* runner.open(input);
          // Narrow, never widen: a dream's `[]` stays `[]` whichever wrapper runs first.
          const settingSources: Array<never> = [];
          if (delegated && Option.isSome(policy)) {
            const root = yield* confiner.root(cwd);
            return yield* runner.open({
              ...input,
              options: {
                ...input.options,
                settingSources,
                ...fullOptions(input.options, {
                  hook: fullHook(
                    input.threadId,
                    { root, tools: leadTools, mcp: false },
                    policy.value,
                  ),
                  auth: yield* confiner.ownerAuth(input.options.env),
                  environment: yield* HostProcess.Environment,
                  ghDirectory: policy.value.ghDirectory,
                  lead: false,
                }),
              },
            });
          }
          // Dreams edit their own checkout; DreamIsolation confines them.
          if (isDream)
            return yield* runner.open({ ...input, options: { ...input.options, settingSources } });
          const shared = input.threadId.startsWith(SHARED_THREAD_PREFIX);
          const root = shared ? undefined : yield* confiner.root(cwd);
          const attachments = yield* confiner.root(config.attachmentsDir);
          if (!shared && Option.isSome(policy) && (yield* policy.value.connected()))
            return yield* runner.open({
              ...input,
              options: {
                ...input.options,
                settingSources,
                ...fullOptions(input.options, {
                  hook: fullHook(
                    input.threadId,
                    {
                      root,
                      tools: leadTools,
                      ...(attachments === undefined ? {} : { attachments }),
                    },
                    policy.value,
                  ),
                  auth: yield* confiner.ownerAuth(input.options.env),
                  environment: yield* HostProcess.Environment,
                  ghDirectory: policy.value.ghDirectory,
                  lead: true,
                }),
              },
            });
          return yield* runner.open({
            ...input,
            options: {
              ...input.options,
              settingSources,
              ...leadOptions(input.options, denied, shared, {
                hook: confiner.hook({
                  root,
                  tools: shared ? [] : leadTools,
                  ...(attachments === undefined ? {} : { attachments }),
                }),
                auth: yield* confiner.ownerAuth(input.options.env),
                environment: yield* HostProcess.Environment,
              }),
            },
          });
        }),
      });
    }),
  ).pipe(Layer.provide(Layer.merge(base, kinEnabledLayer)));
