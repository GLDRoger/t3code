import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ClaudeSettings,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ClaudeAdapterV2 from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { hookAllows, kinSecretVariables } from "../claudeConfinement.testkit.ts";
import * as WorkIsolation from "./WorkIsolation.ts";

// What T3 would hand any Claude thread, with every way to widen it the adapter knows.
const options = ClaudeAdapterV2.makeClaudeQueryOptions({
  modelSelection: {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-sonnet-4-6",
  },
  nativeThreadId: "native",
  resume: false,
  cwd: "/worktree",
  attachmentsDir: "/attachments",
  settings: Schema.decodeSync(ClaudeSettings)({
    launchArgs:
      "--permission-mode bypassPermissions --mcp-config /mcp.json --add-dir /home --allowed-tools Bash",
  }),
  sdkSettings: {
    permissions: { allow: ["Bash(curl:*)", "WebFetch"] },
    alwaysThinkingEnabled: true,
  },
  mcpServers: {
    t3: { type: "http", url: "http://127.0.0.1/mcp" },
    kin: { type: "http", url: "http://127.0.0.1/kin/mcp" },
  },
  allowedTools: ["mcp__t3__delegate_task", "mcp__kin__kin_chat_post"],
  permissionMode: "bypassPermissions",
});

const callerHook: HookCallback = () => Promise.resolve({});

/** Opens one session through the wrapper and returns the options the SDK would get. */
const opened = Effect.fn("WorkIsolationTest.opened")(function* (
  threadId: string,
  overrides: {
    readonly cwd: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly hooks?: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions["hooks"];
  },
) {
  const seen: Array<ClaudeAdapterV2.ClaudeAgentSdkQueryOptions> = [];
  const base = Layer.succeed(
    ClaudeAdapterV2.ClaudeAgentSdkQueryRunner,
    ClaudeAdapterV2.ClaudeAgentSdkQueryRunner.of({
      allocateSessionId: Effect.succeed("session"),
      open: (input) =>
        Effect.sync(() => seen.push(input.options)).pipe(
          Effect.andThen(Effect.die("unused session")),
        ),
      forkSession: () => Effect.die("unused fork"),
      subagentLaunchToolUseId: () => Effect.die("unused lookup"),
      assertComplete: Effect.void,
    }),
  );
  yield* Effect.gen(function* () {
    const runner = yield* ClaudeAdapterV2.ClaudeAgentSdkQueryRunner;
    yield* runner
      .open({
        threadId: ThreadId.make(threadId),
        providerSessionId: ProviderSessionId.make("session"),
        options: {
          ...options,
          cwd: overrides.cwd,
          ...(overrides.env === undefined ? {} : { env: overrides.env }),
          ...(overrides.hooks === undefined ? {} : { hooks: overrides.hooks }),
        },
      })
      .pipe(Effect.exit);
  }).pipe(Effect.provide(WorkIsolation.claudeQueryRunner(base)));
  return seen[0]!;
});

/** A worktree as T3 makes one: `.git` a file naming the main checkout's git directory. */
const worktree = Effect.fn("WorkIsolationTest.worktree")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
  const main = `${root}/main`;
  const tree = `${root}/worktrees/app`;
  yield* fs.makeDirectory(`${main}/.git/hooks`, { recursive: true });
  yield* fs.makeDirectory(`${main}/.git/worktrees/app`, { recursive: true });
  yield* fs.writeFileString(`${main}/.git/config`, "[core]\n");
  yield* fs.makeDirectory(`${tree}/src`, { recursive: true });
  yield* fs.writeFileString(`${tree}/.git`, `gitdir: ${main}/.git/worktrees/app\n`);
  yield* fs.writeFileString(`${tree}/README.md`, "# App\n");
  yield* fs.writeFileString(`${tree}/src/index.ts`, "export {};\n");
  yield* fs.writeFileString(`${root}/outside.md`, "secret\n");
  // A repository can carry links out; the wall follows them to where they really go.
  yield* fs.symlink(root, `${tree}/up`);
  yield* fs.symlink(`${root}/outside.md`, `${tree}/notes.md`);
  yield* fs.symlink(`${main}/.git`, `${tree}/gitdir`);
  return { root, main, tree };
});

it.effect(
  "a work session has file tools in its worktree and no shell, subagent, web, MCP or settings file",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const configDir = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(
        `${configDir}/settings.json`,
        JSON.stringify({
          apiKeyHelper: "gateway-token",
          env: { ANTHROPIC_BASE_URL: "https://gateway.test", NODE_OPTIONS: "--require /evil.js" },
          hooks: { PreToolUse: [] },
          permissions: { allow: ["Bash"] },
        }),
      );
      const { tree } = yield* worktree();
      const env = {
        CLAUDE_CONFIG_DIR: configDir,
        PATH: "/usr/bin",
        ...Object.fromEntries(kinSecretVariables.map((name) => [name, "secret"])),
      };
      const work = yield* opened("kin-work:wk-fixture", {
        cwd: tree,
        env,
        hooks: { PreToolUse: [{ hooks: [callerHook] }] },
      });
      const other = yield* opened("thread-1", { cwd: tree, env });

      const setByWrapper = new Set([
        "permissionMode",
        "settingSources",
        "strictMcpConfig",
        "tools",
        "disallowedTools",
        "systemPrompt",
        "hooks",
        "env",
        "settings",
        "extraArgs",
      ]);
      assert.deepStrictEqual(
        Object.keys(work).filter(
          (key) => !WorkIsolation.workOptionFields.has(key) && !setByWrapper.has(key),
        ),
        [],
      );
      assert.deepStrictEqual(work.tools, ["Read", "Grep", "Glob", "Edit", "Write"]);
      for (const tool of ["Bash", "Task", "Agent", "Workflow", "WebFetch", "WebSearch"])
        assert.include(work.disallowedTools ?? [], tool);
      assert.isUndefined(work.mcpServers);
      assert.isUndefined(work.allowedTools);
      assert.isUndefined(work.additionalDirectories);
      assert.isUndefined(work.allowDangerouslySkipPermissions);
      assert.strictEqual(work.strictMcpConfig, true);
      assert.deepStrictEqual(work.settingSources, []);
      assert.strictEqual(work.permissionMode, "acceptEdits");
      assert.deepStrictEqual(work.systemPrompt, {
        type: "preset",
        preset: "claude_code",
        append: WorkIsolation.workPreamble,
      });
      // The owner's model credentials only; no hooks, permissions or env from any settings file.
      assert.deepStrictEqual(work.settings, {
        alwaysThinkingEnabled: true,
        showThinkingSummaries: true,
        apiKeyHelper: "gateway-token",
        env: { ANTHROPIC_BASE_URL: "https://gateway.test" },
      });
      assert.deepStrictEqual(work.env, { CLAUDE_CONFIG_DIR: configDir, PATH: "/usr/bin" });
      // The caller's hooks are dropped; the one left is the confinement hook, which blocks on error.
      assert.deepStrictEqual(Object.keys(work.hooks ?? {}), ["PreToolUse"]);
      assert.strictEqual(work.hooks?.PreToolUse?.length, 1);
      assert.notInclude(work.hooks?.PreToolUse?.[0]?.hooks ?? [], callerHook);
      assert.strictEqual(work.hooks?.PreToolUse?.[0]?.onFailure, "block");
      // Any other thread is untouched.
      assert.deepStrictEqual(other.mcpServers, options.mcpServers);
      assert.strictEqual(other.permissionMode, "bypassPermissions");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a work session's file tools reach its worktree's real files and nothing else", () =>
  Effect.gen(function* () {
    const { root, main, tree } = yield* worktree();
    const work = yield* opened("kin-work:wk-fixture", { cwd: tree });
    const allows = (tool: string, input: unknown) =>
      Effect.promise(() => hookAllows(work, tool, input));
    for (const [tool, input] of [
      ["Read", { file_path: "README.md" }],
      ["Read", { file_path: `${tree}/src/index.ts` }],
      ["Edit", { file_path: "README.md", old_string: "# App", new_string: "# Acme" }],
      ["Write", { file_path: "src/new.ts", content: "export {};\n" }],
      ["Write", { file_path: ".github/workflows/ci.yml", content: "on: push\n" }],
      ["Grep", { pattern: "App" }],
      ["Grep", { pattern: "App", path: "src", glob: "*.ts" }],
      ["Glob", { pattern: "**/*.md" }],
    ] as const)
      assert.isTrue(yield* allows(tool, input), `${tool} ${JSON.stringify(input)}`);

    const escapes = [
      "../outside.md",
      "src/../../outside.md",
      `${root}/outside.md`,
      "/etc/passwd",
      "~/.ssh/id_ed25519",
      "file:///etc/passwd",
      "notes.md",
      "up/outside.md",
      ".git",
      `${main}/.git/config`,
      `${main}/.git/hooks/pre-commit`,
      "gitdir/config",
      "gitdir/hooks/pre-commit",
    ];
    for (const path of escapes) {
      assert.isFalse(yield* allows("Read", { file_path: path }), `Read ${path}`);
      assert.isFalse(
        yield* allows("Edit", { file_path: path, old_string: "a", new_string: "b" }),
        `Edit ${path}`,
      );
      assert.isFalse(yield* allows("Write", { file_path: path, content: "x" }), `Write ${path}`);
      assert.isFalse(yield* allows("Grep", { pattern: "x", path }), `Grep ${path}`);
      assert.isFalse(yield* allows("Glob", { pattern: "*", path }), `Glob ${path}`);
    }
    for (const [tool, input] of [
      ["Glob", { pattern: "../*" }],
      ["Glob", { pattern: "/etc/*" }],
      ["Glob", { pattern: ".git/**" }],
      ["Grep", { pattern: "x", glob: "../**" }],
      ["Grep", { pattern: "x", glob: "{src,/etc}/*" }],
      // No other tool, whatever it is called, and no MCP tool of any server.
      ["Bash", { command: "cat ~/.t3/userdata/secrets" }],
      ["NotebookEdit", { notebook_path: "a.ipynb", new_source: "x" }],
      ["Task", { prompt: "x" }],
      ["WebFetch", { url: "https://example.com" }],
      ["mcp__t3__delegate_task", { task: "x" }],
      ["mcp__kin__kin_chat_post", { chatId: "c", body: "x" }],
    ] as const)
      assert.isFalse(yield* allows(tool, input), `${tool} ${JSON.stringify(input)}`);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
