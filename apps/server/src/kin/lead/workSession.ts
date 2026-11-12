import type { HookCallbackMatcher, SandboxSettings } from "@anthropic-ai/claude-agent-sdk";

import type * as ClaudeAdapterV2 from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import {
  type SessionCredentials,
  sessionEnvironment,
  withConfinementHook,
} from "../claudeConfinement.ts";

/** A file-only worker's tools; Claude's file tools run outside the OS sandbox. */
export const workTools = ["Read", "Grep", "Glob", "Edit", "Write"];
/**
 * A shell worker's only tool. Beside a shell, a link swapped between the hook's check and a file
 * tool's open would reach outside the worktree.
 */
export const shellTools = ["Bash"];
/** Dropped by the allowlist already; the deny list holds if a later wrapper widens it. */
const alwaysBlocked = [
  "BashOutput",
  "KillShell",
  "KillBash",
  "PowerShell",
  "Monitor",
  "MultiEdit",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Task",
  "Agent",
  "Workflow",
];
const workBlockedTools = ["Bash", ...alwaysBlocked];
const shellBlockedTools = [...workTools, ...alwaysBlocked];

/** The child's fixed preamble; the brief arrives as its first message. */
export const workPreamble = [
  "You are a Kin worker. Do the task in your first message yourself.",
  "Your only tools are Read, Grep, Glob, Edit and Write, inside this worktree. Paths outside it and anything under .git are refused. You have no shell: you can't run commands, tests, builds or installs, and you can't commit or push.",
  "When your run ends, Kin commits your changes in this worktree and opens a draft pull request. Changes under .github are never published.",
].join("\n\n");

export const shellPreamble = [
  "You are a Kin worker. Do the task in your first message yourself.",
  "Your only tool is Bash, which runs in an OS sandbox: it writes only this worktree and its temp directory, reads nothing else of this machine's private data, and reaches only the network hosts the owner allowed, often none. Read and change files with shell commands. Commands time out after 10 minutes at most and can't run in the background. git can't read this worktree's history, and you can't commit or push.",
  "When your run ends, Kin commits your changes in this worktree and opens a draft pull request. Changes under .github are never published.",
].join("\n\n");

// Model-selection keys only; a settings object also carries hooks, helpers, plugins and env.
const keptSettings = new Set([
  "alwaysThinkingEnabled",
  "fastMode",
  "ultracode",
  "showThinkingSummaries",
  "autoCompactWindow",
]);

/** Every adapter field a work session keeps; anything new the adapter passes is dropped. */
export const workOptionFields = new Set([
  "model",
  "title",
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
  "cwd",
]);

/** Claude Code runs, sources or loads what these name, outside the sandbox or before each command. */
const loaderVariables = new Set([
  "CLAUDE_CODE_SHELL_PREFIX",
  "CLAUDE_CODE_PROCESS_WRAPPER",
  "CLAUDE_CODE_SHELL",
  "CLAUDE_CODE_GIT_BASH_PATH",
  "CLAUDE_ENV_FILE",
  "CLAUDE_CODE_PLUGIN_DIRS",
  "CLAUDE_CODE_PLUGIN_SEED_DIR",
  "CLAUDE_CODE_PLUGIN_CACHE_DIR",
]);
// A file or directory the CLI or a credential SDK opens; relative, it would be the worktree's.
const pathVariable = /(?:DIR|_FILE|_PATH|_CERTS?|_CREDENTIALS|^CLAUDE_CODE_CLIENT_KEY)$/;

/** Drops the variables above, and a relative path in a path variable. */
const pinnedEnvironment = <A extends string | undefined>(
  env: Readonly<Record<string, A>>,
): Record<string, A> =>
  Object.fromEntries(
    Object.entries(env).filter(
      ([name, value]) =>
        !loaderVariables.has(name) &&
        !(pathVariable.test(name) && value !== undefined && !value.startsWith("/")),
    ),
  );

/** Also keeps only absolute `PATH` entries, which Claude Code's own `git` and `rg` lookups use. */
const processEnvironment = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const pinned = pinnedEnvironment(env);
  return pinned.PATH === undefined
    ? pinned
    : {
        ...pinned,
        PATH: pinned.PATH.split(":")
          .filter((entry) => entry.startsWith("/"))
          .join(":"),
      };
};

/** Also unsets `names` for every command: settings `env` reaches Claude Code's environment too. */
const denyVariables = (sandbox: SandboxSettings, names: ReadonlyArray<string>): SandboxSettings => {
  const listed = sandbox.credentials?.envVars ?? [];
  const added = names
    .filter((name) => !listed.some((entry) => entry.name === name))
    .map((name) => ({ name, mode: "deny" as const }));
  return { ...sandbox, credentials: { ...sandbox.credentials, envVars: [...listed, ...added] } };
};

export interface WorkSession {
  /** What the adapter would hand any Claude thread. */
  readonly options: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions;
  readonly credentials: SessionCredentials;
  readonly confinement: HookCallbackMatcher;
  /** The server's environment, for a session the adapter gave none. */
  readonly environment: NodeJS.ProcessEnv;
  readonly shell?:
    | { readonly sandbox: SandboxSettings; readonly env: NodeJS.ProcessEnv }
    | undefined;
}

/** The only place a work session's options are made; the sandbox check runs the same ones. */
export const workSessionOptions = (
  session: WorkSession,
): ClaudeAdapterV2.ClaudeAgentSdkQueryOptions => {
  const { options, credentials, confinement, environment, shell } = session;
  const passed = Object.fromEntries(
    Object.entries(options).filter(([key]) => workOptionFields.has(key)),
  );
  const { settings, extraArgs, env } = options;
  const credentialEnv = pinnedEnvironment(credentials.env ?? {});
  const kept: Record<string, unknown> = {
    ...(typeof settings === "object" && settings !== null
      ? Object.fromEntries(Object.entries(settings).filter(([key]) => keptSettings.has(key)))
      : {}),
    ...(Object.keys(credentialEnv).length === 0 ? {} : { env: credentialEnv }),
  };
  const thinking = extraArgs?.["thinking-display"];
  return {
    // The thread identity (`sessionId` or `resume`) and model arrive in `passed`.
    ...(passed as ClaudeAdapterV2.ClaudeAgentSdkQueryOptions),
    // Approvals reach no one; edits inside the worktree go through and the hook refuses the rest.
    // A shell's commands are judged by the sandbox, which no permission mode lifts.
    ...(shell === undefined
      ? { permissionMode: "acceptEdits" as const }
      : { permissionMode: "bypassPermissions" as const, allowDangerouslySkipPermissions: true }),
    settingSources: [],
    strictMcpConfig: true,
    tools: shell === undefined ? workTools : shellTools,
    disallowedTools: shell === undefined ? workBlockedTools : shellBlockedTools,
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: shell === undefined ? workPreamble : shellPreamble,
    },
    hooks: withConfinementHook(undefined, confinement),
    env: processEnvironment(
      shell === undefined ? sessionEnvironment(env ?? environment) : shell.env,
    ),
    ...(shell === undefined
      ? {}
      : { sandbox: denyVariables(shell.sandbox, Object.keys(credentialEnv)) }),
    ...(Object.keys(kept).length === 0 ? {} : { settings: kept }),
    ...(thinking === undefined ? {} : { extraArgs: { "thinking-display": thinking } }),
  };
};
