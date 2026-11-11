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
import { isWorkThread } from "./workThread.ts";

/**
 * A Kin worker that runs on this server, in the same account as the leads. It reads untrusted
 * repository text, so it gets file tools in its own worktree and nothing else: no shell (a shell
 * here can sign in as the owner), no subagents, no web, no MCP and no settings files.
 */
const workTools = ["Read", "Grep", "Glob", "Edit", "Write"];
/** Dropped by the allowlist already; the deny list holds if a later wrapper widens it. */
const workBlockedTools = [
  "Bash",
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

/** The child's fixed preamble; the brief arrives as its first message. */
export const workPreamble = [
  "You are a Kin worker. Do the task in your first message yourself.",
  "Your only tools are Read, Grep, Glob, Edit and Write, inside this worktree. Paths outside it and anything under .git are refused. You have no shell: you can't run commands, tests, builds or installs, and you can't commit or push.",
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
    permissionMode: "acceptEdits",
    settingSources: [],
    strictMcpConfig: true,
    tools: workTools,
    disallowedTools: workBlockedTools,
    systemPrompt: { type: "preset", preset: "claude_code", append: workPreamble },
    hooks: withConfinementHook(undefined, confinement),
    env: sessionEnvironment(env ?? environment),
    ...(Object.keys(kept).length === 0 ? {} : { settings: kept }),
    ...(thinking === undefined ? {} : { extraArgs: { "thinking-display": thinking } }),
  };
};

/**
 * Wraps the Claude query runner; a no-op for every thread that is not a Kin work thread. Keyed on
 * the thread id Kin gives its worker, never on anything the lead or the brief says. The prefix is
 * not reserved, so another thread that takes it only loses tools.
 */
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
        open: Effect.fn("KinWorkIsolation.open")(function* (input) {
          if (!isWorkThread(input.threadId)) return yield* runner.open(input);
          const auth = yield* confiner.ownerAuth(input.options.env);
          // The worktree's real path; one that doesn't resolve leaves the file tools nothing.
          const root = yield* confiner.root(input.options.cwd);
          const confinement = confiner.hook({ root, tools: workTools, mcp: false });
          const environment = yield* HostProcess.Environment;
          return yield* runner.open({
            ...input,
            options: isolateWork(input.options, auth, confinement, environment),
          });
        }),
      });
    }),
  ).pipe(Layer.provide(base));
