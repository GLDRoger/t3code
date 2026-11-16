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
import { ghSignScript } from "../github/ghSign.ts";
import { KinAgentSessionPolicy } from "./sessionPolicy.ts";
import { KinEnabled, layer as kinEnabledLayer } from "../KinEnabled.ts";
import { threadPrefix as dreamThreadPrefix } from "../dreaming/DreamIsolation.ts";
import { SHARED_THREAD_PREFIX } from "./Audience.ts";
import { instructions } from "./instructions.ts";

/** A lead's only built-in tools. Kin's MCP tools arrive separately, through `mcpServers`. */
export const leadTools = ["Read", "Grep", "Glob"];

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
  return {
    systemPrompt: leadSystemPrompt,
    tools: Array.isArray(tools) ? tools.filter((tool) => allowed.includes(tool)) : allowed,
    disallowedTools: [
      ...new Set([...(options.disallowedTools ?? []), ...denied, ...(shared ? leadTools : [])]),
    ],
    // The user's own MCP servers and plugins could hand a lead a shell again.
    strictMcpConfig: true,
    hooks: withConfinementHook(options.hooks, confinement.hook),
    // Kin tools load upfront: a lead that never searched for `kin_chat_post` could not reply.
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
            env: { ...confinement.auth.env, ...settings?.env, ENABLE_TOOL_SEARCH: "false" },
          },
        }),
    env: {
      ...sessionEnvironment(env ?? confinement.environment),
      ENABLE_TOOL_SEARCH: "false",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    },
  };
};

/**
 * Claude Code's own "Generated with Claude Code" PR footer and co-author trailer stay off in a Kin
 * agent's sessions: what it posts ends with its own signature (`ghSign.ts`), and its commits carry
 * only the `Co-authored-by` line its instructions give.
 */
const NO_PROVIDER_FOOTER = {
  attribution: { commit: "", pr: "", sessionUrl: false },
  includeCoAuthoredBy: false,
} as const;

/** What a Kin agent's session, or a task it delegated, posts with: the signing `gh` and its name. */
const signingPath = (
  environment: NodeJS.ProcessEnv,
  sign: {
    readonly directory: string;
    readonly ghDirectory: string;
    readonly agentName: string | undefined;
  },
) => ({
  PATH: [sign.directory, sign.ghDirectory, environment.PATH].filter(Boolean).join(":"),
  ...(sign.agentName === undefined ? {} : { KIN_AGENT_NAME: sign.agentName }),
});

/**
 * An owner-only turn with GitHub connected (repos-rethink slice 3): Claude Code's own tools, as any
 * T3 thread has, with the pinned `gh` first on PATH. Its hook still asks per call: a turn others
 * can read, one that read outside text, or a run Kin hasn't adopted gets only the confined tools.
 */
const fullOptions = (
  options: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions,
  session: {
    readonly hook: HookCallbackMatcher;
    readonly auth: AuthSettings;
    readonly environment: NodeJS.ProcessEnv;
    readonly ghDirectory: string;
    readonly signDirectory: string;
    readonly agentName: string | undefined;
  },
) => {
  const { settings, env } = options;
  const environment = sessionEnvironment(env ?? session.environment);
  return {
    systemPrompt: leadSystemPrompt,
    strictMcpConfig: true,
    hooks: withConfinementHook(options.hooks, session.hook),
    ...(typeof settings === "string"
      ? {}
      : {
          settings: {
            ...session.auth,
            ...settings,
            ...NO_PROVIDER_FOOTER,
            autoMemoryEnabled: false,
            autoDreamEnabled: false,
            env: { ...session.auth.env, ...settings?.env, ENABLE_TOOL_SEARCH: "false" },
          },
        }),
    env: {
      ...environment,
      ...signingPath(environment, {
        directory: session.signDirectory,
        ghDirectory: session.ghDirectory,
        agentName: session.agentName,
      }),
      ENABLE_TOOL_SEARCH: "false",
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
      // The signing gh, in front of the pinned one; a failed write leaves agents with the plain gh.
      const signDirectory = path.join(kinDirectory, "gh-sign");
      if (Option.isSome(policy))
        yield* Effect.gen(function* () {
          yield* fs.makeDirectory(signDirectory, { recursive: true });
          const shim = path.join(signDirectory, "gh");
          yield* fs.writeFileString(shim, ghSignScript(path.join(policy.value.ghDirectory, "gh")));
          yield* fs.chmod(shim, 0o755);
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Kin couldn't write its signing gh", { cause }),
          ),
        );
      const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
      const run = Effect.runPromiseWith(context);
      /** The full session's hook: built-ins while the turn admits them, else the confined set. */
      const fullHook = (
        threadId: ThreadId,
        confined: FileScope,
        sessions: KinAgentSessionPolicy["Service"],
      ): HookCallbackMatcher => ({
        onFailure: "block",
        hooks: [
          async (input) => {
            if (input.hook_event_name !== "PreToolUse" || input.tool_name.startsWith("mcp__"))
              return {};
            return (await run(sessions.admitted(threadId))) ||
              (await run(permits(confined, input.tool_name, input.tool_input)))
              ? {}
              : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } };
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
          if (!isKin) {
            // A task an agent delegated: its own T3 session, posting as the agent too.
            const agentName = Option.isSome(policy)
              ? yield* policy.value.agentName(input.threadId)
              : undefined;
            if (agentName === undefined || Option.isNone(policy)) return yield* runner.open(input);
            const environment = input.options.env ?? (yield* HostProcess.Environment);
            return yield* runner.open({
              ...input,
              options: {
                ...input.options,
                ...(typeof input.options.settings === "string"
                  ? {}
                  : { settings: { ...input.options.settings, ...NO_PROVIDER_FOOTER } }),
                env: {
                  ...environment,
                  ...signingPath(environment, {
                    directory: signDirectory,
                    ghDirectory: policy.value.ghDirectory,
                    agentName,
                  }),
                },
              },
            });
          }
          // Narrow, never widen: a dream's `[]` stays `[]` whichever wrapper runs first.
          const settingSources: Array<never> = [];
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
                  signDirectory,
                  agentName: yield* policy.value.agentName(input.threadId),
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
