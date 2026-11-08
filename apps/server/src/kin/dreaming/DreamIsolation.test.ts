import { assert, it } from "@effect/vitest";
import {
  ClaudeSettings,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ClaudeAdapterV2 from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
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

it.effect("a dream query loads no user config, MCP or shell and edits only its checkout", () =>
  Effect.gen(function* () {
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
            options,
          })
          .pipe(Effect.exit);
      yield* open("kin-dream:dream_20261108_fixture:extract");
      yield* open("thread-1");
    }).pipe(Effect.provide(DreamIsolation.claudeQueryRunner(base)));

    const [dream, other] = opened;
    assert.strictEqual(options.permissionMode, "bypassPermissions");
    assert.strictEqual(other, options);
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
    });
    assert.deepStrictEqual(dream?.extraArgs, { "thinking-display": "summarized" });
    assert.strictEqual(dream?.cwd, "/dream");
  }),
);
