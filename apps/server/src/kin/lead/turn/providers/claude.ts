import { KinShellStartup } from "../shellStartup.ts";
import { resolveCommandPath } from "@t3tools/shared/shell";
import { WorkspaceHostAccess } from "../../../../workspace/WorkspaceHostAccess.ts";
import { KinSessionFolders, sessionFolderKey } from "../sessionFolders.ts";
import type { HookCallback, HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ClaudeAdapterV2 from "../../../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { ServerConfig } from "../../../../config.ts";
import { ServerSettingsService } from "../../../../serverSettings.ts";
import {
  type AuthSettings,
  type FileScope,
  makeConfiner,
  sessionEnvironment,
  shellSandbox,
  shellSharedTempRoots,
  withConfinementHook,
} from "../../../claudeConfinement.ts";
import {
  claudeSandboxNote,
  kinInstructions,
  type KinSessionPlan,
  KinSessions,
} from "../session.ts";
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
const FILE_TOOLS = [...capabilities.readFiles, "Edit", "Write", "NotebookEdit"];
const SHELL_OFF = "This session has no shell because Kin couldn't secure it.";
const SHELL_FILE_REFUSAL = "Use your shell for files in your working folder.";
const FILE_REFUSAL =
  "This file tool can use only your working folder and can read only the attachments given to this turn.";

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

const nativeTools = (plan: KinSessionPlan, search: boolean, bash: boolean) => {
  if (plan.seat === "delegated") return undefined;
  const lookup = search ? ["ToolSearch"] : [];
  switch (plan.abilities) {
    case "shellAndFiles":
      return [...OWNER_SEAT_NATIVE_TOOLS.filter((tool) => tool !== "Bash" || bash), ...lookup];
    case "lookup":
      return [...lookup, CONFINED_SEARCH];
    case "none":
      return lookup;
  }
};

const appendSandboxNote = (prompt: NonNullable<Options["systemPrompt"]>, note: string) => {
  if (typeof prompt === "string") return `${prompt}\n\n${note}`;
  if (Array.isArray(prompt)) return [...prompt, note];
  if (prompt.type === "preset")
    return { ...prompt, append: [prompt.append, note].filter(Boolean).join("\n\n") };
  return {
    ...prompt,
    prompt: Array.isArray(prompt.prompt) ? [...prompt.prompt, note] : `${prompt.prompt}\n\n${note}`,
  };
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
    readonly scope: FileScope | undefined;
    readonly temp: { readonly path: string; readonly npmCache: string } | undefined;
    readonly sandbox: ReturnType<typeof shellSandbox> | undefined;
    readonly environment: NodeJS.ProcessEnv;
    readonly context: SessionContext.KinSessionContext["Service"] | undefined;
    readonly logCompaction: (summaryLength: number) => Promise<void>;
  },
): Options => {
  // Narrow, never widen: a dream's `[]` stays `[]` whichever wrapper runs first.
  if (plan.seat === "dream") return { ...options, settingSources: [] };
  const { settings, env } = options;
  const fenced = session.scope !== undefined;
  const {
    additionalDirectories: _additionalDirectories,
    extraArgs: _extraArgs,
    plugins: _plugins,
    ...noLocalSettings
  } = options;
  const shell = session.sandbox === undefined ? undefined : plan.shell;
  const environment = sessionEnvironment(env ?? session.environment);
  const loading = kinTools(options, plan);
  const tools = nativeTools(plan, loading.search === "true", shell !== undefined);
  const prompt =
    plan.seat === "owner"
      ? kinInstructions("owner", DRIVER, undefined, shell !== undefined)
      : plan.instructions;
  const delegatedNote =
    plan.seat === "delegated" && shell !== undefined ? claudeSandboxNote(false) : undefined;
  const systemPrompt =
    options.systemPrompt !== undefined && delegatedNote !== undefined
      ? appendSandboxNote(options.systemPrompt, delegatedNote)
      : undefined;
  const confined = plan.seat === "confined";
  const hooks =
    session.hook === undefined ? undefined : withConfinementHook(options.hooks, session.hook);
  return {
    ...(fenced ? noLocalSettings : options),
    ...(session.scope?.root === undefined ? {} : { cwd: session.scope.root }),
    settingSources: [],
    ...(prompt === undefined
      ? systemPrompt === undefined
        ? {}
        : { systemPrompt }
      : { systemPrompt: { type: "custom" as const, prompt, snapshot: false } }),
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
      : {
          disallowedTools: [
            ...new Set([
              ...(options.disallowedTools ?? []),
              ...OWNER_SEAT_OFF,
              ...OWNER_SEAT_NO_SUBAGENTS,
              "PowerShell",
              ...(shell === undefined ? ["Bash", ...capabilities.backgroundShell] : []),
            ]),
          ],
        }),
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
    ...(typeof settings === "string" && !fenced
      ? {}
      : {
          settings: {
            ...session.auth,
            ...(typeof settings !== "object"
              ? {}
              : !fenced
                ? settings
                : settings.showThinkingSummaries === undefined
                  ? {}
                  : { showThinkingSummaries: settings.showThinkingSummaries }),
            ...(confined ? {} : NO_PROVIDER_FOOTER),
            ...(session.sandbox === undefined ? {} : { sandbox: session.sandbox }),
            ...(session.scope === undefined
              ? {}
              : {
                  permissions: {
                    blockWritesOutsideWorkingDirectories: true,
                    workingDirectoriesAsGiven:
                      session.scope.root === undefined ? [] : [session.scope.root],
                  },
                }),

            ...(fenced
              ? { disableBundledSkills: true, disableWorkflows: true, disableAgentView: true }
              : {}),
            // Its folder is named after the host's account: a lead never sees it (G07).
            autoMemoryEnabled: false,
            autoDreamEnabled: false,
            ...(plan.seat === "owner" ? { idleCompaction: false } : {}),
            env: {
              ...session.auth.env,
              ...(typeof settings === "object" ? settings.env : undefined),
              ENABLE_TOOL_SEARCH: loading.search,
              ...(session.temp === undefined
                ? {}
                : { TMPDIR: session.temp.path, npm_config_cache: session.temp.npmCache }),
            },
          },
        }),
    env: {
      ...environment,
      ...(shell === undefined
        ? {}
        : {
            PATH: shell.path,
            ...(session.temp === undefined
              ? {}
              : {
                  TMPDIR: session.temp.path,
                  // Claude Code's sandbox gives its commands this as TMPDIR and keeps it open
                  // through the read deny; unset, it is /tmp/claude, which every session shares.
                  CLAUDE_CODE_TMPDIR: session.temp.path,
                  npm_config_cache: session.temp.npmCache,
                }),
            ...(shell.agentName === undefined ? {} : { KIN_AGENT_NAME: shell.agentName }),
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
const decisionHook = (
  plan: KinSessionPlan,
  files: (tool: string, input: unknown) => Promise<boolean>,
  prepareShell: Effect.Effect<boolean>,
  fileRefusal: string,
): HookCallbackMatcher => ({
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
      if (kinTool || input.tool_name === "TodoWrite") return {};
      if (
        input.tool_name === "Bash" ||
        capabilities.backgroundShell.some((tool) => tool === input.tool_name)
      ) {
        return (await Effect.runPromise(prepareShell)) ? {} : refused(SHELL_OFF);
      }
      if (!WEB_READS.has(input.tool_name))
        return (await files(input.tool_name, input.tool_input)) ? {} : refused(fileRefusal);
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
      const config = yield* ServerConfig;
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const folders = yield* KinSessionFolders;
      const workspaceAccess = yield* WorkspaceHostAccess;
      const startup = yield* KinShellStartup;
      const relative = (parent: string, child: string) => {
        const result = path.relative(parent, child);
        return !path.isAbsolute(result) && result.split(path.sep)[0] !== ".." ? result : undefined;
      };
      const literal = (name: string) => !/[?*[\]{}\r\n]/.test(name);
      const stateDir = (yield* confiner.root(config.stateDir)) ?? config.stateDir;
      const baseDir = (yield* confiner.root(config.baseDir)) ?? config.baseDir;
      const attachmentsDir = (yield* confiner.root(config.attachmentsDir)) ?? config.attachmentsDir;
      const tempParent = path.join(stateDir, "kin-session-tmp");
      const homeDirectory = yield* HostProcess.HomeDirectory;
      const serviceHome = (yield* confiner.root(homeDirectory)) ?? homeDirectory;
      const nodePaths = Effect.fnUntraced(function* (node: string) {
        const resolved = yield* confiner.root(node);
        if (resolved === undefined) return [];
        const bin = path.dirname(resolved);
        const packages = path.join(path.dirname(bin), "lib", "node_modules");
        // The folder, not its entries: the sandbox binds a granted link as its target file, so
        // bin/npm (a link to ../lib/node_modules/npm/bin/npm-cli.js) would lose its ../lib.
        return [
          node,
          resolved,
          bin,
          path.join(packages, "npm"),
          path.join(packages, "corepack"),
          path.join(packages, "pnpm"),
        ].filter(literal);
      });
      const context = Option.getOrUndefined(
        yield* Effect.serviceOption(SessionContext.KinSessionContext),
      );
      const settings = yield* Effect.serviceOption(ServerSettingsService);
      let reportedMissingContext = false;
      const runHook = Effect.runPromiseWith(yield* Effect.context<never>());
      return ClaudeAdapterV2.ClaudeAgentSdkQueryRunner.of({
        ...runner,
        scopeAttachments: Effect.fn("KinClaude.scopeAttachments")(function* (threadId, cwd) {
          const plan = yield* sessions.plan({
            threadId,
            cwd,
            driver: DRIVER,
            path: undefined,
            toolLookup: false,
          });
          return plan?.seat === "owner" || plan?.seat === "delegated";
        }),
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
          const fenced = plan.seat === "owner" || plan.seat === "delegated";
          const auth = yield* confiner.ownerAuth(input.options.env);
          let scope: FileScope | undefined;
          let sandbox: ReturnType<typeof shellSandbox> | undefined;
          if (fenced) {
            const env = input.options.env ?? environment;
            const resolveHome =
              env.HOME ?? environment.HOME ?? env.USERPROFILE ?? environment.USERPROFILE;
            const home =
              resolveHome && path.isAbsolute(resolveHome)
                ? ((yield* confiner.root(resolveHome)) ?? resolveHome)
                : undefined;
            const original = input.options.cwd;
            let root = yield* confiner.root(original);
            // In a lead seat the only allowed opening in state is the lead's actual checkout.
            // A delegated target can use its own Scratch folder or an explicit project, never state.
            const kinRoot = path.join(stateDir, "kin");
            const scratch = path.join(baseDir, "scratch");
            if (
              root !== undefined &&
              (!literal(root) ||
                (plan.seat === "owner"
                  ? !relative(kinRoot, root) ||
                    (original !== undefined &&
                      relative(path.join(config.stateDir, "kin"), original) !== undefined &&
                      path.join(kinRoot, relative(path.join(config.stateDir, "kin"), original)!) !==
                        root) ||
                    ["gh-sign", "gh-app"].some(
                      (folder) => relative(path.join(kinRoot, folder), root!) !== undefined,
                    )
                  : relative(root, baseDir) !== undefined ||
                    (relative(baseDir, root) !== undefined && !relative(scratch, root)) ||
                    relative(stateDir, root) !== undefined))
            )
              root = undefined;
            const attachments = (yield* Effect.forEach(input.attachmentPaths ?? [], (file) =>
              fs.lstat(file).pipe(
                Effect.flatMap((info) =>
                  info.type === "File" ? confiner.root(file) : Effect.undefined,
                ),
                Effect.orElseSucceed(() => undefined),
                Effect.map((real) =>
                  real === path.join(attachmentsDir, path.basename(file)) && literal(real)
                    ? real
                    : undefined,
                ),
              ),
            )).filter((file) => file !== undefined);
            const shellEnvironment = {
              ...environment,
              ...env,
              ...auth.env,
              ...(typeof input.options.settings === "object" ? input.options.settings.env : {}),
            };
            if (root !== undefined && home !== undefined) {
              const settings = shellSandbox(
                {
                  root,
                  home,
                  serviceHome,
                  baseDir,
                  stateDir,
                  attachments,
                  readPaths:
                    plan.shell === undefined
                      ? []
                      : [...plan.shell.readPaths, ...(yield* nodePaths(plan.shell.node))],
                  logPaths: plan.shell?.logPaths ?? [],
                  environment: shellEnvironment,
                },
                path,
              );
              const allowedRoot = root;
              const unsafe = settings.filesystem.denyRead.some(
                (deny) =>
                  relative(allowedRoot, deny) !== undefined ||
                  (relative(deny, allowedRoot) !== undefined &&
                    deny !== baseDir &&
                    deny !== stateDir &&
                    deny !== home &&
                    deny !== serviceHome &&
                    !shellSharedTempRoots.includes(deny) &&
                    deny !== shellEnvironment.TMPDIR &&
                    deny !== path.join(home, ".t3")),
              );
              if (unsafe) root = undefined;
              else if (plan.shell !== undefined) {
                const checked = startup.executables;
                const binary =
                  checked === undefined
                    ? undefined
                    : ((yield* resolveCommandPath(
                        input.options.pathToClaudeCodeExecutable ?? "claude",
                        {
                          env,
                        },
                      ).pipe(
                        Effect.provideService(FileSystem.FileSystem, fs),
                        Effect.provideService(Path.Path, path),
                        Effect.orElseSucceed(() => null),
                      )) ?? undefined);
                const resolved = yield* confiner.root(binary);
                if (checked === undefined || (resolved !== undefined && checked.has(resolved)))
                  sandbox = settings;
              }
            } else root = undefined;
            if (
              root !== undefined &&
              !input.refresh &&
              !(yield* workspaceAccess.register(root, input.threadId))
            ) {
              root = undefined;
              sandbox = undefined;
            }
            // With no shell, there is no sandboxed process racing these checkout path checks.
            scope = {
              root,
              tools: FILE_TOOLS,
              attachmentPaths: attachments,
              attachmentsOnly: sandbox !== undefined,
            };
          }
          const temp =
            sandbox === undefined || input.refresh
              ? undefined
              : yield* fs.makeDirectory(tempParent, { recursive: true, mode: 0o700 }).pipe(
                  Effect.andThen(
                    fs.makeTempDirectory({ directory: tempParent, prefix: "session-" }),
                  ),
                  Effect.orElseSucceed(() => undefined),
                );
          if (sandbox !== undefined && !input.refresh) {
            if (temp === undefined) {
              sandbox = undefined;
              if (scope !== undefined) scope = { ...scope, attachmentsOnly: false };
            } else {
              sandbox.filesystem.allowRead.push(temp);
              sandbox.filesystem.allowWrite.push(temp);
            }
          }
          const cleanup =
            temp === undefined
              ? Effect.void
              : fs.remove(temp, { recursive: true, force: true }).pipe(Effect.ignore);
          const opened = yield* runner
            .open({
              ...input,
              options: apply(input.options, plan, {
                // The refresh already denies all tools; the normal policy hook could mark a wake-up.
                hook: input.refresh
                  ? undefined
                  : decisionHook(
                      plan,
                      (tool, args) =>
                        scope === undefined
                          ? Promise.resolve(false)
                          : confiner.permits(scope, tool, args),
                      sandbox === undefined ? Effect.succeed(false) : plan.shell!.prepareLogs,
                      sandbox === undefined ? FILE_REFUSAL : SHELL_FILE_REFUSAL,
                    ),
                auth,
                scope,
                temp:
                  temp === undefined
                    ? undefined
                    : { path: temp, npmCache: path.join(temp, "npm-cache") },
                sandbox,
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
            })
            .pipe(Effect.onExit((exit) => (exit._tag === "Failure" ? cleanup : Effect.void)));
          if (scope?.root === undefined || input.refresh) return opened;
          const key = sessionFolderKey(input);
          const roots = temp === undefined ? [scope.root] : [scope.root, temp];
          folders.set(key, roots);
          return {
            ...opened,
            close: opened.close.pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  if (folders.get(key) === roots) folders.delete(key);
                }).pipe(Effect.andThen(cleanup)),
              ),
            ),
          };
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
