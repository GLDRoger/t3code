import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ServerConfig } from "../../config.ts";
import * as ClaudeAdapterV2 from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { KinEnabled, layer as kinEnabledLayer } from "../KinEnabled.ts";
import { threadPrefix as dreamThreadPrefix } from "../dreaming/DreamIsolation.ts";

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

/** Read deny rules for host secrets a lead's `Read`, `Grep` and `Glob` could otherwise reach. */
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

const leadOptions = (
  options: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions,
  denied: ReadonlyArray<string>,
) => {
  const { tools, settings, env } = options;
  return {
    tools: Array.isArray(tools) ? tools.filter((tool) => leadTools.includes(tool)) : leadTools,
    disallowedTools: [...new Set([...(options.disallowedTools ?? []), ...denied])],
    // The user's own MCP servers and plugins could hand a lead a shell again.
    strictMcpConfig: true,
    // Kin tools load upfront: a lead that never searched for `kin_chat_post` could not reply.
    // Flag settings env beats a user settings.json env; a settings file path can't take keys.
    ...(typeof settings === "string"
      ? {}
      : { settings: { ...settings, env: { ...settings?.env, ENABLE_TOOL_SEARCH: "false" } } }),
    ...(env === undefined ? {} : { env: { ...env, ENABLE_TOOL_SEARCH: "false" } }),
  };
};

/**
 * A lead runs full-access with Kin's memory checkout as its cwd, so its Claude session loads user
 * settings only: never a project `CLAUDE.md`, `.claude/` or `.mcp.json` that memory might carry.
 * The cwd is the lead project's root, which Kin sets; a match only ever narrows what loads.
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
      const real = (target: string) => fs.realPath(target).pipe(Effect.orElseSucceed(() => target));
      const within = (parent: string, child: string) => {
        const relative = path.relative(parent, child);
        return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
      };
      return ClaudeAdapterV2.ClaudeAgentSdkQueryRunner.of({
        ...runner,
        open: Effect.fn("KinLeadIsolation.open")(function* (input) {
          const cwd = input.options.cwd;
          const isKin =
            cwd !== undefined &&
            (within(kinDirectory, path.resolve(cwd)) ||
              within(yield* real(kinDirectory), yield* real(cwd)));
          const isDream = input.threadId.startsWith(dreamThreadPrefix);
          return yield* runner.open(
            isKin
              ? {
                  ...input,
                  options: {
                    ...input.options,
                    // Narrow, never widen: a dream's `[]` stays `[]` whichever wrapper runs first.
                    settingSources: (
                      input.options.settingSources ?? ["user", "project", "local"]
                    ).filter((source) => source === "user"),
                    // Dreams edit their own checkout and already refuse the shell and the web.
                    ...(isDream ? {} : leadOptions(input.options, denied)),
                  },
                }
              : input,
          );
        }),
      });
    }),
  ).pipe(Layer.provide(Layer.merge(base, kinEnabledLayer)));
