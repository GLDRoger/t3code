import type { HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ClaudeAdapterV2 from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import {
  type AuthSettings,
  makeConfiner,
  sessionEnvironment,
  withConfinementHook,
} from "../claudeConfinement.ts";
import * as WorkSandbox from "./workSandbox.ts";
import { isWorkThread } from "./workThread.ts";

/**
 * A Kin worker that runs on this server, in the same account as the leads. It reads untrusted
 * repository text, so it gets file tools in its own worktree and nothing else: no subagents, no
 * web, no MCP and no settings files. A shell runs as the server's user, so a worker gets one only
 * when `KinWorkSandbox` proves Claude Code's OS sandbox holds here, and then it gets that alone.
 */
const workTools = ["Read", "Grep", "Glob", "Edit", "Write"];
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

// Model-selection keys only; a settings object also carries hooks, permissions and env.
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

const isolateWork = (
  options: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions,
  auth: AuthSettings,
  confinement: HookCallbackMatcher,
  environment: NodeJS.ProcessEnv,
  shell: Extract<WorkSandbox.Prepared, { _tag: "shell" }> | undefined,
): ClaudeAdapterV2.ClaudeAgentSdkQueryOptions => {
  const passed = Object.fromEntries(
    Object.entries(options).filter(([key]) => workOptionFields.has(key)),
  );
  const { settings, extraArgs, env } = options;
  const kept: Record<string, unknown> = {
    ...(typeof settings === "object" && settings !== null
      ? Object.fromEntries(Object.entries(settings).filter(([key]) => keptSettings.has(key)))
      : {}),
    ...auth,
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
    tools: shell === undefined ? workTools : WorkSandbox.shellTools,
    disallowedTools: shell === undefined ? workBlockedTools : shellBlockedTools,
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: shell === undefined ? workPreamble : shellPreamble,
    },
    hooks: withConfinementHook(undefined, confinement),
    env: shell === undefined ? sessionEnvironment(env ?? environment) : shell.env,
    ...(shell === undefined
      ? {}
      : { sandbox: WorkSandbox.denyVariables(shell.sandbox, Object.keys(auth.env ?? {})) }),
    ...(Object.keys(kept).length === 0 ? {} : { settings: kept }),
    ...(thinking === undefined ? {} : { extraArgs: { "thinking-display": thinking } }),
  };
};

/**
 * Wraps the Claude query runner; a no-op for every thread that is not a Kin work thread. Keyed on
 * the thread id Kin gives its worker, never on anything the lead or the brief says. The prefix is
 * not reserved, so another thread that takes it only loses tools.
 */
export const claudeQueryRunnerWith = <E, R, E2, R2>(
  base: Layer.Layer<ClaudeAdapterV2.ClaudeAgentSdkQueryRunner, E, R>,
  sandbox: Layer.Layer<WorkSandbox.KinWorkSandbox, E2, R2>,
) =>
  Layer.effect(
    ClaudeAdapterV2.ClaudeAgentSdkQueryRunner,
    Effect.gen(function* () {
      const runner = yield* ClaudeAdapterV2.ClaudeAgentSdkQueryRunner;
      const sandboxes = yield* WorkSandbox.KinWorkSandbox;
      const confiner = yield* makeConfiner();
      return ClaudeAdapterV2.ClaudeAgentSdkQueryRunner.of({
        ...runner,
        open: Effect.fn("KinWorkIsolation.open")(function* (input) {
          if (!isWorkThread(input.threadId)) return yield* runner.open(input);
          const auth = yield* confiner.ownerAuth(input.options.env);
          // The worktree's real path; one that doesn't resolve leaves the file tools nothing.
          const root = yield* confiner.root(input.options.cwd);
          const environment = yield* HostProcess.Environment;
          const prepared =
            root === undefined
              ? undefined
              : yield* sandboxes.prepare({ worktree: root, options: input.options });
          const shell = prepared?._tag === "shell" ? prepared : undefined;
          const confinement = confiner.hook({
            root,
            tools: shell === undefined ? workTools : WorkSandbox.shellTools,
            mcp: false,
          });
          const session = yield* runner
            .open({
              ...input,
              options: isolateWork(input.options, auth, confinement, environment, shell),
            })
            .pipe(Effect.onError(() => shell?.release ?? Effect.void));
          return shell === undefined
            ? session
            : { ...session, close: session.close.pipe(Effect.ensuring(shell.release)) };
        }),
      });
    }),
  ).pipe(Layer.provide(base), Layer.provide(sandbox));

export const claudeQueryRunner = <E, R>(
  base: Layer.Layer<ClaudeAdapterV2.ClaudeAgentSdkQueryRunner, E, R>,
) => claudeQueryRunnerWith(base, WorkSandbox.layer);
