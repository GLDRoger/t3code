import type { HookCallbackMatcher, SandboxSettings } from "@anthropic-ai/claude-agent-sdk";

import type * as ClaudeAdapterV2 from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { type SessionCredentials, withConfinementHook } from "../claudeConfinement.ts";

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

/** Copied from the server's environment when set; nothing else of it reaches a worker. */
const keptVariables = [
  "USER",
  "LOGNAME",
  "LANG",
  "LANGUAGE",
  "TZ",
  "TERM",
  "CLAUDE_CODE_ENTRYPOINT",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
];
/** Copied only as absolute paths; relative, each would name a file in the worktree. */
const keptPaths = ["SHELL", "TMPDIR", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"];
/** What a shell's commands still see; Claude Code sets their proxy variables and TMPDIR itself. */
const commandVariables = new Set(["PATH", "HOME", ...keptVariables, ...keptPaths]);
const commandSees = (name: string) =>
  name.startsWith("LC_") || (commandVariables.has(name) && name !== "CLAUDE_CODE_ENTRYPOINT");

/** Per command and per task; Claude Code enforces the first two, `WorkerTracker` the last. */
export const commandLimits = {
  BASH_DEFAULT_TIMEOUT_MS: "120000",
  BASH_MAX_TIMEOUT_MS: "600000",
  BASH_MAX_OUTPUT_LENGTH: "30000",
  // No `run_in_background`: a command ends before its tool call returns.
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
};

/** Where a worker's Claude Code keeps its state; neither is readable to a shell's commands. */
export interface WorkerPlace {
  /** An empty directory only Kin's server writes, or the real home where the login needs it. */
  readonly home: string;
  /** The provider's Claude home, absolute, holding the owner's login; unset for the default. */
  readonly configDir: string | undefined;
}

/**
 * A worker's whole environment, built from nothing: absolute `PATH` entries, a private `HOME`,
 * locale, terminal and proxy basics, and Claude Code's own settings. Credentials travel in the
 * session's settings `env`, never here.
 */
const workerEnvironment = (
  server: NodeJS.ProcessEnv,
  place: WorkerPlace,
  shell?: { readonly tmp: string; readonly bins: ReadonlyArray<string> },
): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(server))
    if (value !== undefined && (keptVariables.includes(name) || name.startsWith("LC_")))
      env[name] = value;
  for (const name of keptPaths) {
    const value = server[name];
    if (value?.startsWith("/") === true) env[name] = value;
  }
  const path = (server.PATH ?? "").split(":").filter((entry) => entry.startsWith("/"));
  path.unshift(...(shell?.bins ?? []));
  return {
    ...env,
    PATH: path.join(":"),
    HOME: place.home,
    // No CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: it also refuses any command with a variable or loop.
    ...(place.configDir === undefined ? {} : { CLAUDE_CONFIG_DIR: place.configDir }),
    ...(shell === undefined ? {} : { ...commandLimits, CLAUDE_CODE_TMPDIR: shell.tmp }),
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
  /** The server's environment, for a session the adapter gave none; only `workerEnvironment` reads it. */
  readonly environment: NodeJS.ProcessEnv;
  readonly place: WorkerPlace;
  readonly shell?:
    | {
        readonly sandbox: SandboxSettings;
        readonly tmp: string;
        /** Put first on `PATH`: the server's Node and Kin's tools. */
        readonly bins: ReadonlyArray<string>;
      }
    | undefined;
}

/** The only place a work session's options are made; the sandbox check runs the same ones. */
export const workSessionOptions = (
  session: WorkSession,
): ClaudeAdapterV2.ClaudeAgentSdkQueryOptions => {
  const { options, credentials, confinement, environment, place, shell } = session;
  const passed = Object.fromEntries(
    Object.entries(options).filter(([key]) => workOptionFields.has(key)),
  );
  const { settings, extraArgs } = options;
  const credentialEnv = credentials.env ?? {};
  const kept: Record<string, unknown> = {
    ...(typeof settings === "object" && settings !== null
      ? Object.fromEntries(Object.entries(settings).filter(([key]) => keptSettings.has(key)))
      : {}),
    ...(Object.keys(credentialEnv).length === 0 ? {} : { env: credentialEnv }),
  };
  const thinking = extraArgs?.["thinking-display"];
  const env = workerEnvironment(options.env ?? environment, place, shell);
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
    env,
    ...(shell === undefined
      ? {}
      : {
          sandbox: denyVariables(shell.sandbox, [
            ...Object.keys(env)
              .filter((name) => !commandSees(name))
              .toSorted(),
            ...Object.keys(credentialEnv),
          ]),
        }),
    ...(Object.keys(kept).length === 0 ? {} : { settings: kept }),
    ...(thinking === undefined ? {} : { extraArgs: { "thinking-display": thinking } }),
  };
};
