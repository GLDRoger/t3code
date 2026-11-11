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
import * as DreamIsolation from "./DreamIsolation.ts";

const options = ClaudeAdapterV2.makeClaudeQueryOptions({
  modelSelection: {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-sonnet-4-6",
  },
  nativeThreadId: "native",
  resume: false,
  cwd: "/dream",
  attachmentsDir: "/attachments",
  settings: Schema.decodeSync(ClaudeSettings)({
    launchArgs: "--permission-mode bypassPermissions --mcp-config /mcp.json --add-dir /home",
  }),
  sdkSettings: {
    permissions: { allow: ["Bash(curl:*)", "WebFetch"] },
    alwaysThinkingEnabled: true,
  },
  mcpServers: { t3: { type: "http", url: "http://127.0.0.1/mcp" } },
  allowedTools: ["mcp__t3__t3_thread_launch"],
  permissionMode: "acceptEdits",
});

const canUseTool: NonNullable<ClaudeAdapterV2.ClaudeAgentSdkQueryOptions["canUseTool"]> = () =>
  Promise.resolve({ behavior: "deny", message: "declined" });

const callerHook: HookCallback = () => Promise.resolve({});

it.effect(
  "a dream query loads no user config but the owner's model credentials, no MCP or shell",
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
      const dreamDir = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      yield* fs.writeFileString(`${dreamDir}/notes.md`, "x");
      const env = {
        CLAUDE_CONFIG_DIR: configDir,
        PATH: "/usr/bin",
        ...Object.fromEntries(kinSecretVariables.map((name) => [name, "secret"])),
      };
      const opened: Array<ClaudeAdapterV2.ClaudeAgentSdkQueryOptions> = [];
      const base = Layer.succeed(
        ClaudeAdapterV2.ClaudeAgentSdkQueryRunner,
        ClaudeAdapterV2.ClaudeAgentSdkQueryRunner.of({
          allocateSessionId: Effect.succeed("session"),
          open: (input) =>
            Effect.sync(() => opened.push(input.options)).pipe(
              Effect.andThen(Effect.die("unused session")),
            ),
          forkSession: () => Effect.die("unused fork"),
          subagentLaunchToolUseId: () => Effect.die("unused lookup"),
          assertComplete: Effect.void,
        }),
      );
      yield* Effect.gen(function* () {
        const runner = yield* ClaudeAdapterV2.ClaudeAgentSdkQueryRunner;
        const open = (threadId: string) =>
          runner
            .open({
              threadId: ThreadId.make(threadId),
              providerSessionId: ProviderSessionId.make("session"),
              options: { ...options, cwd: dreamDir, env },
            })
            .pipe(Effect.exit);
        yield* open("kin-dream:dream_20261108_fixture:extract");
        yield* open("thread-1");
        // Anyone can name a thread with the prefix, so the wrapper must never widen its mode.
        yield* runner
          .open({
            threadId: ThreadId.make("kin-dream:spoofed"),
            providerSessionId: ProviderSessionId.make("session"),
            options: {
              ...options,
              permissionMode: "default",
              canUseTool,
              hooks: { PreToolUse: [{ hooks: [callerHook] }] },
            },
          })
          .pipe(Effect.exit);
      }).pipe(Effect.provide(DreamIsolation.claudeQueryRunner(base)));

      const [dream, other, spoofed] = opened;
      assert.deepStrictEqual(
        Object.keys(dream ?? {}).filter((key) => !DreamIsolation.dreamOptionFields.has(key)),
        [],
      );
      assert.strictEqual(spoofed?.permissionMode, "default");
      assert.strictEqual(spoofed?.canUseTool, canUseTool);
      // The caller's hooks are dropped; the one left is the confinement hook.
      assert.deepStrictEqual(Object.keys(spoofed?.hooks ?? {}), ["PreToolUse"]);
      assert.notInclude(spoofed?.hooks?.PreToolUse?.[0]?.hooks ?? [], callerHook);
      assert.strictEqual(spoofed?.hooks?.PreToolUse?.length, 1);
      assert.strictEqual(options.permissionMode, "bypassPermissions");
      assert.deepStrictEqual(other?.env, env);
      assert.strictEqual(dream?.permissionMode, "acceptEdits");
      assert.deepStrictEqual(dream?.settingSources, []);
      assert.strictEqual(dream?.strictMcpConfig, true);
      assert.deepStrictEqual(dream?.tools, DreamIsolation.dreamTools);
      assert.deepStrictEqual(dream?.disallowedTools, ["Bash", "WebFetch", "WebSearch"]);
      assert.isUndefined(dream?.mcpServers);
      assert.isUndefined(dream?.allowedTools);
      assert.isUndefined(dream?.additionalDirectories);
      assert.deepStrictEqual(dream?.settings, {
        alwaysThinkingEnabled: true,
        showThinkingSummaries: true,
        apiKeyHelper: "gateway-token",
        env: { ANTHROPIC_BASE_URL: "https://gateway.test" },
      });
      assert.deepStrictEqual(dream?.extraArgs, { "thinking-display": "summarized" });
      assert.strictEqual(dream?.cwd, dreamDir);
      assert.deepStrictEqual(dream?.env, { CLAUDE_CONFIG_DIR: configDir, PATH: "/usr/bin" });
      // Its reads and its edits reach the real checkout and nothing outside it.
      const allows = (tool: string, input: unknown) =>
        Effect.promise(() => hookAllows(dream, tool, input));
      assert.isTrue(
        yield* allows("Edit", { file_path: "notes.md", old_string: "x", new_string: "y" }),
      );
      assert.isTrue(yield* allows("Write", { file_path: `${dreamDir}/new.md`, content: "x" }));
      for (const [tool, input] of [
        ["Read", { file_path: `${configDir}/settings.json` }],
        ["Read", { file_path: "/proc/self/environ" }],
        ["Write", { file_path: "/etc/kin", content: "x" }],
        ["Write", { file_path: "../escape.md", content: "x" }],
        ["Edit", { file_path: "~/.bashrc", old_string: "x", new_string: "y" }],
        ["Grep", { pattern: "x", path: "/" }],
      ] as const)
        assert.isFalse(yield* allows(tool, input), JSON.stringify(input));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
