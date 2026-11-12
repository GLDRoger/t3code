import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../config.ts";
import * as ClaudeAdapterV2 from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { hookAllows, kinSecretVariables } from "../claudeConfinement.testkit.ts";
import * as DreamIsolation from "../dreaming/DreamIsolation.ts";
import { instructions } from "./instructions.ts";
import * as LeadIsolation from "./LeadIsolation.ts";

const optionsAt = (cwd: string, environment: NodeJS.ProcessEnv = { PATH: "/usr/bin" }) =>
  ClaudeAdapterV2.makeClaudeQueryOptions({
    modelSelection: {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-sonnet-4-6",
    },
    nativeThreadId: "native",
    resume: false,
    cwd,
    attachmentsDir: "/attachments",
    environment,
    mcpServers: { kin: { type: "http", url: "http://127.0.0.1/kin" } },
  });

it.effect.each([
  [true, true],
  [true, false],
  [false, true],
])(
  "a Kin lead loads no settings file and Kin tools upfront, its file tools confined to its checkout (KIN_ENABLED=%s, lead wrapper outside=%s)",
  ([enabled, leadOutside]) =>
    Effect.gen(function* () {
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const memory = `${stateDir}/kin/demo-a/memory-read`;
      yield* fs.makeDirectory(memory, { recursive: true });
      yield* fs.writeFileString(`${memory}/notes.md`, "x");
      const configDir = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(
        `${configDir}/settings.json`,
        JSON.stringify({
          apiKeyHelper: "gateway-token",
          env: { ANTHROPIC_BASE_URL: "https://gateway.test", GH_TOKEN: "leak" },
          hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "true" }] }] },
          enabledPlugins: { "shell@market": true },
        }),
      );
      const environment = {
        PATH: "/usr/bin",
        HOME: "/home/kin",
        ANTHROPIC_BASE_URL: "https://gateway.test",
        CLAUDE_CONFIG_DIR: configDir,
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
      const lead = optionsAt(memory, environment);
      const other = optionsAt("/work/project", environment);
      const dream = optionsAt(`${stateDir}/kin/demo-a/dreams/fixture`, environment);
      yield* Effect.gen(function* () {
        const runner = yield* ClaudeAdapterV2.ClaudeAgentSdkQueryRunner;
        for (const [threadId, options] of [
          ["kin:lead", lead],
          ["thread-1", other],
          ["kin-dream:fixture:extract", dream],
          ["kin-shared:lead", lead],
        ] as const)
          yield* runner
            .open({
              threadId: ThreadId.make(threadId),
              providerSessionId: ProviderSessionId.make("session"),
              options,
            })
            .pipe(Effect.exit);
      }).pipe(
        Effect.provide(
          (leadOutside
            ? LeadIsolation.claudeQueryRunner(DreamIsolation.claudeQueryRunner(base))
            : DreamIsolation.claudeQueryRunner(LeadIsolation.claudeQueryRunner(base))
          ).pipe(
            Layer.provide(
              ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: enabled })),
            ),
          ),
        ),
      );
      const [leadOpened, otherOpened, dreamOpened, sharedOpened] = opened;
      assert.strictEqual(otherOpened, other);
      assert.deepStrictEqual(dreamOpened?.settingSources, []);
      if (!enabled) {
        assert.strictEqual(leadOpened, lead);
        return;
      }
      const config = yield* ServerConfig.ServerConfig;
      const { hooks: leadHooks, ...leadRest } = leadOpened ?? lead;
      assert.deepStrictEqual(leadRest, {
        ...lead,
        // The instructions alone: no coding-agent preset, no T3 thread guidance.
        systemPrompt: { type: "custom", prompt: instructions, snapshot: false },
        // No settings file: user settings carry hooks, plugins and env a lead must not inherit.
        settingSources: [],
        tools: LeadIsolation.leadTools,
        disallowedTools: [
          ...(lead.disallowedTools ?? []),
          ...LeadIsolation.leadBlockedTools,
          `Read(/${config.secretsDir}/**)`,
          `Read(/${config.baseDir}/service.env)`,
          `Read(/${config.dbPath}*)`,
          "Read(~/.ssh/**)",
          "Read(~/.config/kin/**)",
          "Read(~/.config/gh/**)",
        ],
        strictMcpConfig: true,
        // Only the owner's model credentials come from their settings.
        settings: {
          apiKeyHelper: "gateway-token",
          ...(typeof lead.settings === "object" ? lead.settings : {}),
          env: { ANTHROPIC_BASE_URL: "https://gateway.test", ENABLE_TOOL_SEARCH: "false" },
        },
        env: {
          PATH: "/usr/bin",
          HOME: "/home/kin",
          ANTHROPIC_BASE_URL: "https://gateway.test",
          CLAUDE_CONFIG_DIR: configDir,
          ENABLE_TOOL_SEARCH: "false",
        },
      });
      assert.deepStrictEqual(leadHooks?.PreToolUse?.length, 1);
      for (const name of kinSecretVariables) {
        assert.notProperty(leadOpened?.env ?? {}, name);
        assert.notProperty(dreamOpened?.env ?? {}, name);
        assert.notProperty(sharedOpened?.env ?? {}, name);
      }
      // The confinement hook is what the session runs: its checkout, and nothing else.
      const leadAllows = (tool: string, input: unknown) => hookAllows(leadOpened, tool, input);
      assert.isTrue(yield* Effect.promise(() => leadAllows("Read", { file_path: "notes.md" })));
      assert.isTrue(yield* Effect.promise(() => leadAllows("Glob", { pattern: "**/*.md" })));
      for (const [tool, input] of [
        ["Read", { file_path: "/etc/passwd" }],
        ["Read", { file_path: "/proc/self/environ" }],
        ["Read", { file_path: "~/.local/share/keyrings/login.keyring" }],
        ["Read", { file_path: `${config.baseDir}/service.env` }],
        ["Read", { file_path: "../memory-read-b/notes.md" }],
        ["Grep", { pattern: "token", path: "/home" }],
        ["Glob", { pattern: "/**" }],
      ] as const)
        assert.isFalse(yield* Effect.promise(() => leadAllows(tool, input)), JSON.stringify(input));
      assert.isFalse(
        yield* Effect.promise(() => hookAllows(sharedOpened, "Read", { file_path: "notes.md" })),
      );
      assert.isTrue(
        yield* Effect.promise(() =>
          hookAllows(sharedOpened, "mcp__kin__kin_chat_post", { text: "hi" }),
        ),
      );
      assert.isUndefined(otherOpened?.strictMcpConfig);
      assert.deepStrictEqual(dreamOpened?.systemPrompt, dream.systemPrompt);
      const dreamSettings = dreamOpened?.settings;
      assert.notProperty(
        (typeof dreamSettings === "object" ? dreamSettings.env : undefined) ?? {},
        "ENABLE_TOOL_SEARCH",
      );
      // A dream keeps the edit tools its checkout needs.
      assert.deepStrictEqual(dreamOpened?.tools, DreamIsolation.dreamTools);
      assert.isFalse((dreamOpened?.disallowedTools ?? []).includes("Edit"));
      assert.isDefined(leadOpened?.mcpServers?.kin);
      // A turn someone besides the owner reads can't open the memory checkout it runs in.
      assert.deepStrictEqual(sharedOpened?.tools, []);
      for (const tool of LeadIsolation.leadTools)
        assert.include(sharedOpened?.disallowedTools ?? [], tool);
      assert.isDefined(sharedOpened?.mcpServers?.kin);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "kin-lead-isolation-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);
