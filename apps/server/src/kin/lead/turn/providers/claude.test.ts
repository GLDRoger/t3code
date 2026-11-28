import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  KinAgentId,
  KinOrgId,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../../../config.ts";
import * as ClaudeAdapterV2 from "../../../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { hookAllows, kinSecretVariables } from "../../../claudeConfinement.testkit.ts";
import * as DreamIsolation from "../../../dreaming/DreamIsolation.ts";
import contextBudget from "../../../mcp/agentContextBudget.json" with { type: "json" };
import {
  builtinTools,
  claude,
  OWNER_SEAT_NATIVE_TOOLS,
  OWNER_SEAT_NO_SUBAGENTS,
  OWNER_SEAT_OFF,
} from "./claude.ts";
import { captureClaudeOptions, FIXTURE_NODE, FIXTURE_NODE_BIN } from "./claude.testkit.ts";
import { BILLS_SEAT_INSTRUCTIONS, kinInstructions, REVIEW_SEAT_INSTRUCTIONS } from "../session.ts";
import { KinShellStartup } from "../shellStartup.ts";
import { KinSessionContext } from "../sessionContext.ts";
import { ownerOnlyWakeup, wakeupRun } from "../../Audience.testkit.ts";
import {
  delegatedFromLead,
  fullSessionRefusal,
  leadNameOf,
  webSearchRefusal,
} from "../../AgentSession.ts";
import { SESSION_REFUSAL } from "../../Audience.ts";
import { BILLS_REFUSAL } from "../../billsOnly.ts";
import { KinAgentSessionPolicy } from "../../sessionPolicy.ts";
import { stampReads } from "../../OutsideContent.ts";
import { KinServer, type Services as KinServices } from "../../../KinServer.ts";
import * as KinPersistence from "../../../persistence/KinPersistence.ts";
import * as Sqlite from "../../../../persistence/Sqlite.ts";
import { ServerSettingsService } from "../../../../serverSettings.ts";

const dietSettings = {
  disableBundledSkills: true,
  disableWorkflows: true,
  disableAgentView: true,
} as const;

const assertNoDietSettings = (options: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions | undefined) => {
  for (const key of Object.keys(dietSettings))
    assert.notProperty(typeof options?.settings === "object" ? options.settings : {}, key);
};

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

const hookBase = {
  session_id: "native",
  transcript_path: "/fake/transcript",
  cwd: "/fake",
};
const hookOutputs = (options: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions, input: HookInput) =>
  Effect.promise(() =>
    Promise.all(
      (options.hooks?.[input.hook_event_name] ?? []).flatMap(({ hooks }) =>
        hooks.map((hook) => hook(input, undefined, { signal: new AbortController().signal })),
      ),
    ),
  );

const withPreparedContext = <A, E>(
  check: (options: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions) => Effect.Effect<A, E>,
  withContext = true,
) =>
  Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig.ServerConfig;
    const threadId = ThreadId.make("kin:tech");
    const policy = KinAgentSessionPolicy.of({
      refusal: () => Effect.undefined,
      webSearch: () => Effect.undefined,
      delegated: () => Effect.succeed(false),
      toolDirectories: [],
      agentName: () => Effect.undefined,
    });
    const services = Context.make(KinAgentSessionPolicy, policy) as Context.Context<KinServices>;
    const opened: Array<ClaudeAdapterV2.ClaudeAgentSdkQueryOptions> = [];
    const base = Layer.succeed(ClaudeAdapterV2.ClaudeAgentSdkQueryRunner, {
      allocateSessionId: Effect.succeed("session"),
      open: (input) =>
        Effect.sync(() => opened.push(input.options)).pipe(
          Effect.andThen(Effect.die("no process in the test")),
        ),
      forkSession: () => Effect.die("unused fork"),
      subagentLaunchToolUseId: () => Effect.die("unused lookup"),
      subagentModel: () => Effect.succeed(null),
      assertComplete: Effect.void,
    });
    return yield* Effect.gen(function* () {
      const runner = yield* ClaudeAdapterV2.ClaudeAgentSdkQueryRunner;
      const context = yield* Effect.serviceOption(KinSessionContext);
      const open = runner
        .open({
          threadId,
          providerSessionId: ProviderSessionId.make("session"),
          options: optionsAt(`${stateDir}/kin/memory-read`, {
            PATH: "/usr/bin",
            HOME: stateDir,
          }),
        })
        .pipe(Effect.exit);
      yield* open;
      if (Option.isSome(context)) {
        yield* context.value.set(threadId, {
          standing: "prepared standing",
          delta: "prepared delta",
        });
        yield* context.value.set(ThreadId.make("kin:other"), { standing: "other", delta: "other" });
      } else {
        yield* open;
        assert.lengthOf(opened, 2);
      }
      const [options] = opened;
      if (options === undefined) return yield* Effect.die("Claude did not open");
      return yield* check(options);
    }).pipe(
      Effect.provide(
        claude.install(base).pipe(
          Layer.provide(
            Layer.succeed(KinServer, {
              taskCardUpdater: Layer.empty,
              services: Option.some(services),
              subscribeForViewer: Option.none(),
            }),
          ),
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
          Layer.provideMerge(withContext ? KinSessionContext.layer : Layer.empty),
          Layer.provide(ServerSettingsService.layerTest({ kinSessionCarry: true })),
          Layer.provide(Layer.succeed(HostProcess.HomeDirectory, stateDir)),
        ),
      ),
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "kin-hook-context-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

// Baseline generated by running this table with Kin’s Claude adapter and session planner at 8a3a53f82ce.
it.effect("every seat's options match Kin byte for byte", () =>
  Effect.gen(function* () {
    const { stateDir, baseDir } = yield* ServerConfig.ServerConfig;
    const memory = `${stateDir}/kin/demo-a/memory-read`;
    const scratch = `${baseDir}/scratch/task`;
    const fs = yield* FileSystem.FileSystem;
    for (const root of [memory, scratch]) yield* fs.makeDirectory(root, { recursive: true });
    const services = Context.make(
      KinAgentSessionPolicy,
      KinAgentSessionPolicy.of({
        refusal: () => Effect.undefined,
        webSearch: () => Effect.undefined,
        delegated: (threadId) => Effect.succeed(threadId === "task-from-lead"),
        toolDirectories: ["/kin-home/kin-tools/gh-pinned"],
        agentName: () => Effect.succeed("Tech lead"),
      }),
    ) as Context.Context<KinServices>;
    for (const [seat, thread, cwd, toolLookup] of [
      ["owner with lookup", "kin:tech", memory, true],
      ["owner without lookup", "kin:tech", memory, false],
      ["shared", "kin-shared:tech", memory, true],
      ["review", "kin-shared:review:tech", memory, true],
      ["triage", "kin-shared:triage:tech", memory, true],
      ["bills", "kin-shared:bills:tech", memory, true],
      ["delegated", "task-from-lead", scratch, true],
      ["shared without lookup", "kin-shared:tech", memory, false],
      ["review without lookup", "kin-shared:review:tech", memory, false],
      ["triage without lookup", "kin-shared:triage:tech", memory, false],
      ["bills without lookup", "kin-shared:bills:tech", memory, false],
      ["delegated without lookup", "task-from-lead", scratch, false],
      ["dream", "kin-dream:fixture:extract", `${stateDir}/kin/demo-a/dreams/fixture`, true],
    ] as const) {
      const { options } = yield* captureClaudeOptions(
        {
          thread,
          cwd,
          model: "claude-sonnet-4-6",
          environment: {
            PATH: "/usr/bin",
            HOME: "/home/kin",
            CLAUDE_CONFIG_DIR: `${stateDir}/claude`,
          },
        },
        toolLookup,
      ).pipe(
        Effect.provideService(KinServer, {
          taskCardUpdater: Layer.empty,
          services: Option.some(services),
          subscribeForViewer: Option.none(),
        }),
      );
      if (seat === "owner with lookup" || seat === "delegated")
        expect(JSON.stringify(options.systemPrompt)).toContain("Your shell runs in a sandbox");
      const bytes = JSON.stringify(options, (_key, value: unknown) => {
        if (typeof value === "string")
          return value
            .replaceAll(stateDir, "<stateDir>")
            .replaceAll(baseDir, "<baseDir>")
            .replace(/(kin-session-tmp[/\\])session-[^/\\]+/g, "$1<session>");
        if (typeof value === "function") return "[Function]";
        return value;
      });
      const hash = yield* Effect.promise(() =>
        crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes)),
      );
      expect(Buffer.from(hash).toString("hex")).toMatchSnapshot(seat);
    }
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "kin-claude-options-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
      ),
    ),
  ),
);

it.effect("an enabled owner seat without KinSessionContext logs one error and still opens", () => {
  const errors: string[] = [];
  return withPreparedContext(
    (options) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(
          yield* hookOutputs(options, {
            ...hookBase,
            hook_event_name: "UserPromptSubmit",
            prompt: "Question",
          }),
          [{}],
        );
        assert.lengthOf(errors, 1);
        assert.include(errors[0], "KinSessionContext");
      }),
    false,
  ).pipe(
    Effect.provide(
      Logger.layer([
        Logger.make(({ logLevel, message }) => {
          if (logLevel === "Error") errors.push(String(message));
        }),
      ]),
    ),
  );
});

it.effect("an unavailable sandbox opens a Claude session with Bash withheld", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const cwd = `${config.stateDir}/kin/demo/memory-read`;
    yield* fs.makeDirectory(cwd, { recursive: true });
    const services = Context.make(KinAgentSessionPolicy, {
      refusal: () => Effect.undefined,
      webSearch: () => Effect.undefined,
      delegated: () => Effect.succeed(false),
      toolDirectories: ["/fixtures/gh"],
      agentName: () => Effect.succeed("Lead"),
    }) as Context.Context<KinServices>;
    const { options } = yield* captureClaudeOptions({
      thread: "kin:tech",
      cwd,
      model: "claude-sonnet-4-6",
      environment: { PATH: "/usr/bin", HOME: "/home/kin" },
    }).pipe(
      Effect.provideService(KinServer, {
        taskCardUpdater: Layer.empty,
        services: Option.some(services),
        subscribeForViewer: Option.none(),
      }),
    );
    if (!Array.isArray(options.tools)) return assert.fail("Expected a list of native tools");
    assert.notInclude(options.tools, "Bash");
    assert.include(options.disallowedTools ?? [], "Bash");
    assert.isUndefined(typeof options.settings === "object" && options.settings.sandbox);
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "kin-claude-unavailable-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
      ),
    ),
    Effect.provideService(KinShellStartup, { available: false }),
  ),
);

it.effect("SessionStart adds the standing context only on startup and compact", () =>
  withPreparedContext((options) =>
    Effect.gen(function* () {
      for (const source of ["startup", "compact", "resume", "clear", "fork"] as const) {
        const output = yield* hookOutputs(options, {
          ...hookBase,
          hook_event_name: "SessionStart",
          source,
        });
        assert.deepStrictEqual(
          output,
          source === "startup" || source === "compact"
            ? [
                {
                  hookSpecificOutput: {
                    hookEventName: "SessionStart",
                    additionalContext: "prepared standing",
                  },
                },
              ]
            : [{}],
          source,
        );
      }
    }),
  ),
);

it.effect("the prompt hook returns prepared text without reading the database", () =>
  withPreparedContext((options) =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* hookOutputs(options, {
          ...hookBase,
          hook_event_name: "UserPromptSubmit",
          prompt: "original wake-up",
        }),
        [
          {
            hookSpecificOutput: {
              hookEventName: "UserPromptSubmit",
              additionalContext: "prepared delta",
            },
          },
        ],
      );
    }),
  ),
);

it.effect("a second Claude prompt cannot read the same turn context", () =>
  withPreparedContext((options) =>
    Effect.gen(function* () {
      const prompt = {
        ...hookBase,
        hook_event_name: "UserPromptSubmit" as const,
        prompt: "original wake-up",
      };
      const [first] = yield* hookOutputs(options, prompt);
      assert.isTrue(first !== undefined && "hookSpecificOutput" in first);
      assert.deepStrictEqual(yield* hookOutputs(options, prompt), [{}]);
    }),
  ),
);

it.effect.each([
  [true, true],
  [true, false],
  [false, true],
])(
  "a confined Kin session loads no settings file, Kin's core up front and none of Claude Code's own (KIN_ENABLED=%s, lead wrapper outside=%s)",
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
          subagentModel: () => Effect.succeed(null),
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
          ["kin-shared:review:lead", lead],
          ["kin-shared:bills:lead", lead],
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
            ? claude.install(DreamIsolation.claudeQueryRunner(base))
            : DreamIsolation.claudeQueryRunner(claude.install(base))
          ).pipe(
            Layer.provide(
              ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: enabled })),
            ),
          ),
        ),
      );
      const [leadOpened, otherOpened, dreamOpened, sharedOpened, reviewOpened, billsOpened] =
        opened;
      assert.strictEqual(otherOpened, other);
      assert.deepStrictEqual(dreamOpened?.settingSources, []);
      if (!enabled) {
        assert.strictEqual(leadOpened, lead);
        return;
      }
      const config = yield* ServerConfig.ServerConfig;
      const { hooks: leadHooks, ...leadRest } = leadOpened ?? lead;
      const confinedBaseline = {
        ...lead,
        // The instructions alone: no coding-agent preset, no T3 thread guidance.
        systemPrompt: {
          type: "custom",
          prompt: kinInstructions("confined", "claudeAgent"),
          snapshot: false,
        },
        // No settings file: user settings carry hooks, plugins and env a lead must not inherit.
        settingSources: [],
        // Every built-in but the provider's own web search, which the hook asks the turn about.
        disallowedTools: [
          ...(lead.disallowedTools ?? []),
          ...builtinTools.filter((tool) => tool !== "WebSearch"),
        ],
        strictMcpConfig: true,
        // Kin's core loads up front by its own marks; every other tool waits for ToolSearch.
        tools: ["ToolSearch", "WebSearch"],
        mcpServers: { kin: { type: "http", url: "http://127.0.0.1/kin" } },
        // Only the owner's model credentials come from their settings.
        settings: {
          apiKeyHelper: "gateway-token",
          ...(typeof lead.settings === "object" ? lead.settings : {}),
          // G07: auto-memory's folder, under the host's home, named the account to a teammate.
          autoMemoryEnabled: false,
          autoDreamEnabled: false,
          env: { ANTHROPIC_BASE_URL: "https://gateway.test", ENABLE_TOOL_SEARCH: "true" },
        },
        env: {
          PATH: "/usr/bin",
          HOME: "/home/kin",
          ANTHROPIC_BASE_URL: "https://gateway.test",
          CLAUDE_CONFIG_DIR: configDir,
          ENABLE_TOOL_SEARCH: "true",
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
          MCP_CONNECTION_NONBLOCKING: "0",
        },
      } satisfies typeof leadRest;
      assert.deepStrictEqual(leadRest, confinedBaseline);
      const { hooks: sharedHooks, ...sharedRest } = sharedOpened ?? lead;
      assert.deepStrictEqual(sharedRest, confinedBaseline);
      for (const [seat, expectedPrompt] of [
        [reviewOpened, REVIEW_SEAT_INSTRUCTIONS],
        [billsOpened, BILLS_SEAT_INSTRUCTIONS],
      ] as const) {
        const { hooks, ...rest } = seat ?? lead;
        assert.deepStrictEqual(rest, {
          ...confinedBaseline,
          systemPrompt: { type: "custom", prompt: expectedPrompt, snapshot: false },
          tools: ["ToolSearch"],
          disallowedTools: [...(lead.disallowedTools ?? []), ...builtinTools],
        });
        assert.deepStrictEqual(Object.keys(hooks ?? {}), ["PreToolUse"]);
      }
      assert.deepStrictEqual(Object.keys(sharedHooks ?? {}), ["PreToolUse"]);
      assert.notProperty(dreamOpened?.env ?? {}, "CLAUDE_CODE_PROMPT_CACHE_TTL");
      assert.notProperty(
        typeof dreamOpened?.settings === "object" ? dreamOpened.settings : {},
        "idleCompaction",
      );
      assert.deepStrictEqual(leadHooks?.PreToolUse?.length, 1);
      for (const name of kinSecretVariables) {
        assert.notProperty(leadOpened?.env ?? {}, name);
        assert.notProperty(dreamOpened?.env ?? {}, name);
        assert.notProperty(sharedOpened?.env ?? {}, name);
      }
      // The confinement hook is what the session runs: Kin's tools, and nothing else.
      const leadAllows = (tool: string, input: unknown) => hookAllows(leadOpened, tool, input);
      assert.isTrue(yield* Effect.promise(() => leadAllows("ToolSearch", { query: "chart" })));
      for (const [tool, input] of [
        ["Read", { file_path: "notes.md" }],
        ["Glob", { pattern: "**/*.md" }],
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
      assertNoDietSettings(dreamOpened);
      assert.isFalse((dreamOpened?.disallowedTools ?? []).includes("Edit"));
      assert.isDefined(leadOpened?.mcpServers?.kin);
      // A turn someone besides the owner reads can't open the memory checkout it runs in.
      assert.deepStrictEqual(sharedOpened?.tools, ["ToolSearch", "WebSearch"]);
      assert.isTrue(
        yield* Effect.promise(() => hookAllows(sharedOpened, "ToolSearch", { query: "chart" })),
      );
      for (const tool of builtinTools.filter((name) => name !== "WebSearch"))
        assert.include(sharedOpened?.disallowedTools ?? [], tool);
      // No Kin turn behind the session to mark: its web search is refused too.
      assert.strictEqual(
        yield* Effect.promise(() => hookDenial(sharedOpened, "WebSearch", { query: "tiles" })),
        SESSION_REFUSAL.none,
      );
      assert.isDefined(sharedOpened?.mcpServers?.kin);
      // An outsider's pull request's review: its own short system prompt, and no web search.
      assert.deepStrictEqual(reviewOpened?.systemPrompt, {
        type: "custom",
        prompt: REVIEW_SEAT_INSTRUCTIONS,
        snapshot: false,
      });
      assert.deepStrictEqual(reviewOpened?.tools, ["ToolSearch"]);
      for (const tool of builtinTools) assert.include(reviewOpened?.disallowedTools ?? [], tool);
      assert.strictEqual(
        yield* Effect.promise(() => hookDenial(reviewOpened, "WebSearch", { query: "tiles" })),
        "This review has no web search.",
      );
      // Bills from outside: the bills seat's own short instructions, and no built-in.
      assert.deepStrictEqual(billsOpened?.systemPrompt, {
        type: "custom",
        prompt: BILLS_SEAT_INSTRUCTIONS,
        snapshot: false,
      });
      assert.deepStrictEqual(billsOpened?.tools, ["ToolSearch"]);
      for (const tool of builtinTools) assert.include(billsOpened?.disallowedTools ?? [], tool);
      assert.strictEqual(
        yield* Effect.promise(() => hookDenial(billsOpened, "WebSearch", { query: "tiles" })),
        BILLS_REFUSAL,
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "kin-lead-isolation-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);

it.effect(
  "the owner's own turns get Claude Code's tools while the turn admits them, GitHub or not",
  () =>
    Effect.gen(function* () {
      const { stateDir, attachmentsDir } = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const memory = `${stateDir}/kin/demo-a/memory-read`;
      yield* fs.makeDirectory(memory, { recursive: true });
      yield* fs.writeFileString(`${memory}/notes.md`, "x");
      const sql = yield* SqlClient.SqlClient;
      const orgId = KinOrgId.make("org-full");
      const agentId = KinAgentId.make("tech");
      yield* ownerOnlyWakeup({ orgId, agentId, wakeupId: "wake-full" });
      // The policy Kin builds (`AgentSession.sessionPolicyLayer`), with its tool folders stood in.
      const services = Context.make(
        KinAgentSessionPolicy,
        KinAgentSessionPolicy.of({
          refusal: (threadId) =>
            fullSessionRefusal(threadId).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
          webSearch: (threadId, host) =>
            webSearchRefusal(threadId, host).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
          delegated: (threadId) =>
            delegatedFromLead(threadId).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
          toolDirectories: ["/kin-home/kin-tools/gh-pinned"],
          agentName: (threadId) =>
            Effect.succeed(threadId === "kin:tech" ? "Tech lead" : undefined),
        }),
      ) as Context.Context<KinServices>;
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
          subagentModel: () => Effect.succeed(null),
          assertComplete: Effect.void,
        }),
      );
      const lead = optionsAt(memory, { PATH: "/usr/bin", HOME: "/home/kin" });
      const given = `${attachmentsDir}/given.txt`;
      const notGiven = `${attachmentsDir}/not-given.txt`;
      for (const file of [given, notGiven]) yield* fs.writeFileString(file, "fixture");
      const open = (
        threadId: string,
        options: ClaudeAdapterV2.ClaudeAgentSdkQueryOpenInput["options"] = lead,
        refresh?: true,
      ) =>
        Effect.gen(function* () {
          const runner = yield* ClaudeAdapterV2.ClaudeAgentSdkQueryRunner;
          yield* runner
            .open({
              threadId: ThreadId.make(threadId),
              providerSessionId: ProviderSessionId.make("session"),
              attachmentPaths: [given],
              options,
              ...(refresh === undefined ? {} : { refresh }),
            })
            .pipe(Effect.exit);
          return opened.at(-1);
        }).pipe(
          Effect.provide(
            claude.install(base).pipe(
              Layer.provide(Layer.succeed(HostProcess.HomeDirectory, stateDir)),
              Layer.provide(Layer.succeed(HostProcess.ExecutablePath, FIXTURE_NODE)),
              Layer.provide(
                Layer.succeed(KinServer, {
                  taskCardUpdater: Layer.empty,
                  services: Option.some(services),
                  subscribeForViewer: Option.none(),
                }),
              ),
              Layer.provide(
                ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true })),
              ),
            ),
          ),
        );
      const full = yield* open("kin:tech");
      assert.deepStrictEqual(
        [...OWNER_SEAT_NO_SUBAGENTS],
        [
          "Agent",
          "Task",
          "Workflow",
          "ListAgents",
          "ReportFindings",
          "SendMessage",
          "TaskStop",
          "DesignSync",
          "Skill",
        ],
      );
      assert.includeMembers(contextBudget.kinLeadOwnerNativeTools, [...OWNER_SEAT_NATIVE_TOOLS]);
      assert.isDefined(full);
      if (full === undefined) return;
      assert.notProperty(full, "maxTurns");
      const { hooks: fullHooks, env: fullEnv, settings: fullSettings, ...fullRequest } = full;
      const {
        env: _env,
        settings: leadSettings,
        additionalDirectories: _dirs,
        extraArgs: _args,
        ...leadRequest
      } = lead;
      assert.deepStrictEqual(fullRequest, {
        ...leadRequest,
        systemPrompt: {
          type: "custom",
          prompt: kinInstructions("owner", "claudeAgent"),
          snapshot: false,
        },
        settingSources: [],
        tools: [...OWNER_SEAT_NATIVE_TOOLS, "ToolSearch"],
        disallowedTools: [
          ...new Set([
            ...(lead.disallowedTools ?? []),
            ...OWNER_SEAT_OFF,
            ...OWNER_SEAT_NO_SUBAGENTS,
            "PowerShell",
          ]),
        ],
        strictMcpConfig: true,
      });
      assert.match(fullEnv?.TMPDIR ?? "", /kin-session-tmp[/\\]session-/);
      assert.deepStrictEqual(fullEnv, {
        TMPDIR: fullEnv?.TMPDIR,
        // The sandbox hands its commands this as TMPDIR; unset, every session shares one.
        CLAUDE_CODE_TMPDIR: fullEnv?.TMPDIR,
        npm_config_cache: `${fullEnv?.TMPDIR}/npm-cache`,
        PATH: `${stateDir}/kin/gh-sign:/kin-home/kin-tools/gh-pinned:${FIXTURE_NODE_BIN}:/usr/bin`,
        HOME: "/home/kin",
        KIN_AGENT_NAME: "Tech lead",
        ENABLE_TOOL_SEARCH: "true",
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
        MCP_CONNECTION_NONBLOCKING: "0",
        CLAUDE_CODE_PROMPT_CACHE_TTL: "1h",
      });
      const {
        sandbox: _sandbox,
        permissions,
        ...rest
      } = typeof fullSettings === "object" ? fullSettings : {};
      assert.deepStrictEqual(permissions, {
        blockWritesOutsideWorkingDirectories: true,
        workingDirectoriesAsGiven: [memory],
      });
      assert.deepStrictEqual(rest, {
        ...(typeof leadSettings === "object" ? leadSettings : {}),
        attribution: { commit: "", pr: "", sessionUrl: false },
        includeCoAuthoredBy: false,
        autoMemoryEnabled: false,
        autoDreamEnabled: false,
        env: {
          ENABLE_TOOL_SEARCH: "true",
          TMPDIR: fullEnv?.TMPDIR ?? "",
          npm_config_cache: fullEnv?.npm_config_cache ?? "",
        },
        idleCompaction: false,
        ...dietSettings,
      });
      const preconfigured = yield* open("kin:tech", {
        ...lead,
        env: { ...lead.env, CLAUDE_CODE_PROMPT_CACHE_TTL: "5m" },
      });
      assert.notStrictEqual(preconfigured?.env?.TMPDIR, fullEnv?.TMPDIR);
      assert.deepStrictEqual(preconfigured?.env, {
        ...fullEnv,
        TMPDIR: preconfigured?.env?.TMPDIR,
        CLAUDE_CODE_TMPDIR: preconfigured?.env?.TMPDIR,
        npm_config_cache: `${preconfigured?.env?.TMPDIR}/npm-cache`,
        CLAUDE_CODE_PROMPT_CACHE_TTL: "5m",
      });
      assert.sameMembers(Object.keys(fullHooks ?? {}), [
        "PreToolUse",
        "SessionStart",
        "UserPromptSubmit",
        "PreCompact",
        "PostCompact",
      ]);
      for (const hook of [
        { ...hookBase, hook_event_name: "SessionStart", source: "startup" },
        { ...hookBase, hook_event_name: "SessionStart", source: "resume" },
        { ...hookBase, hook_event_name: "SessionStart", source: "compact" },
        { ...hookBase, hook_event_name: "UserPromptSubmit", prompt: "original wake-up" },
        {
          ...hookBase,
          hook_event_name: "PreCompact",
          trigger: "manual",
          custom_instructions: null,
        },
        {
          ...hookBase,
          hook_event_name: "PostCompact",
          trigger: "manual",
          compact_summary: "fixture",
        },
      ] satisfies ReadonlyArray<HookInput>) {
        assert.deepStrictEqual(yield* hookOutputs(full, hook), [{}]);
      }
      const { mcpServers: _mcpServers, ...withoutMcp } = lead;
      const withoutSearch = yield* open("kin:tech", withoutMcp);
      assert.deepStrictEqual(withoutSearch?.tools, [...OWNER_SEAT_NATIVE_TOOLS]);
      assert.strictEqual(withoutSearch?.env?.ENABLE_TOOL_SEARCH, "false");
      assert.notProperty(full, "skills");
      // The signing gh first, then the pinned one; Claude Code's own PR footer and trailer off.
      const signing = `${stateDir}/kin/gh-sign`;
      assert.strictEqual(
        full?.env?.PATH,
        `${signing}:/kin-home/kin-tools/gh-pinned:${FIXTURE_NODE_BIN}:/usr/bin`,
      );
      assert.strictEqual(full?.env?.KIN_AGENT_NAME, "Tech lead");
      assert.strictEqual(full?.env?.ENABLE_TOOL_SEARCH, "true");
      assert.include(
        yield* fs.readFileString(`${signing}/gh-policy.mjs`),
        'const REAL = "/kin-home/kin-tools/gh-pinned/gh";',
      );
      // git and the owner switch beside it, reading the App's files from Kin's own folder.
      for (const name of ["git", "git-credential-kin", "kin-as-owner"])
        assert.include(
          yield* fs.readFileString(`${signing}/${name}`),
          `APP='${stateDir}/kin/gh-app'`,
        );
      const footerOff = (options: typeof full) =>
        typeof options?.settings === "object" &&
        options.settings.includeCoAuthoredBy === false &&
        JSON.stringify(options.settings.attribution) ===
          JSON.stringify({ commit: "", pr: "", sessionUrl: false });
      assert.isTrue(footerOff(full));
      // Any other T3 thread is left exactly as it was.
      const work = optionsAt("/work/acme/app", { PATH: "/usr/bin" });
      assert.strictEqual(yield* open("someone-elses-thread", work), work);
      assert.deepStrictEqual(full?.settingSources, []);
      assert.deepStrictEqual(full?.systemPrompt, {
        type: "custom",
        prompt: kinInstructions("owner", "claudeAgent"),
        snapshot: false,
      });
      const allows = (tool: string, input: unknown) =>
        Effect.promise(() => hookAllows(full, tool, input));
      const shell = { command: "gh pr list" };
      // No running turn on the thread, such as a run Kin hasn't adopted: Kin's tools only.
      assert.isFalse(yield* allows("Bash", shell));
      assert.isFalse(yield* allows("Read", { file_path: "notes.md" }));
      assert.isTrue(yield* allows("mcp__kin__memory_read", { id: "M-1" }));
      yield* sql`UPDATE kin_wakeups SET status = 'running', thread_id = 'kin:tech',
        audience = 'owner_only' WHERE wakeup_id = 'wake-full'`;
      assert.isTrue(yield* allows("Bash", shell));
      const outside = [
        `${stateDir}/secrets/fixture.bin`,
        `${stateDir}/statev2.sqlite`,
        `${stateDir}/kin/another-person/private.md`,
      ];
      yield* fs.makeDirectory(`${stateDir}/secrets`, { recursive: true });
      yield* fs.writeFileString(outside[0]!, "fixture");
      yield* fs.symlink(outside[0]!, `${memory}/linked-secret`);
      for (const tool of ["Read", "Edit", "Write"]) {
        for (const file_path of [...outside, `${memory}/linked-secret`])
          assert.isFalse(yield* allows(tool, { file_path }), `${tool}: ${file_path}`);
        assert.isFalse(yield* allows(tool, { file_path: `${memory}/notes.md` }));
      }
      assert.isTrue(yield* allows("Read", { file_path: given }));
      assert.isFalse(yield* allows("Read", { file_path: notGiven }));
      assert.isFalse(yield* allows("Write", { file_path: given }));
      assert.isFalse(yield* allows("NotebookEdit", { notebook_path: outside[0] }));
      assert.isFalse(yield* allows("Glob", { path: attachmentsDir, pattern: "*" }));
      assert.isFalse(yield* allows("MultiEdit", { file_path: `${memory}/notes.md` }));
      const sandbox = typeof full?.settings === "object" && full.settings.sandbox;
      assert.isObject(sandbox);
      assert.deepInclude(sandbox, {
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
      });
      if (sandbox) {
        assert.include(sandbox.filesystem?.denyRead ?? [], stateDir);
        assert.include(sandbox.filesystem?.allowRead ?? [], given);
        assert.notInclude(sandbox.filesystem?.allowRead ?? [], attachmentsDir);
      }
      // Its own page fetch or web search is outside text: the turn is marked before it runs, by
      // the page's host, and reads on as any outside-read turn does.
      const read = Effect.gen(function* () {
        const [row] = yield* sql<{ source: string }>`SELECT source FROM kin_wakeup_outside_reads
          WHERE wakeup_id = 'wake-full'`;
        yield* sql`DELETE FROM kin_wakeup_outside_reads WHERE wakeup_id = 'wake-full'`;
        return row === undefined ? undefined : stampReads(row.source);
      });
      const refresh = yield* open(
        "kin:tech",
        {
          ...lead,
          hooks: {
            PreToolUse: [
              {
                onFailure: "block",
                hooks: [
                  async () => ({
                    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
                  }),
                ],
              },
            ],
          },
        },
        true,
      );
      assert.isDefined(refresh);
      if (refresh === undefined) return;
      const decisions = yield* hookOutputs(refresh, {
        ...hookBase,
        hook_event_name: "PreToolUse",
        tool_name: "WebSearch",
        tool_input: { query: "invented vendor" },
        tool_use_id: "refresh-tool",
      });
      assert.isUndefined(yield* read, "a refused refresh tool must not mark a wake-up");
      assert.deepStrictEqual(decisions, [
        { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } },
      ]);
      assert.isTrue(yield* allows("WebFetch", { url: "https://example.com/pricing?x=1" }));
      assert.isFalse(yield* allows("Bash", shell));
      assert.deepStrictEqual(yield* read, [{ k: "web", host: "example.com" }]);
      assert.isTrue(yield* allows("WebSearch", { query: "invented vendor" }));
      assert.deepStrictEqual(yield* read, [{ k: "web" }]);
      // Once the turn read a connected service's text, Claude Code's own tools are gone for the
      // rest of it, as on every provider; memory stays open through Kin's memory tools.
      yield* sql`INSERT INTO kin_wakeup_outside_reads (org_id, wakeup_id, read_at, source)
        VALUES (${orgId}, 'wake-full', 0, 'conn_mail')`;
      assert.isFalse(yield* allows("Bash", shell));
      assert.isFalse(yield* allows("Read", { file_path: "/etc/passwd" }));
      assert.isFalse(yield* allows("Read", { file_path: "notes.md" }));
      assert.isTrue(yield* allows("mcp__kin__memory_read", { id: "M-1" }));
      yield* sql`DELETE FROM kin_wakeup_outside_reads WHERE wakeup_id = 'wake-full'`;
      // Someone else joined the chat it answers: aborted, and nothing more runs.
      yield* sql`UPDATE kin_wakeups SET aborted_at = 1 WHERE wakeup_id = 'wake-full'`;
      assert.isFalse(yield* allows("Bash", shell));
      yield* sql`UPDATE kin_wakeups SET aborted_at = NULL, audience = 'shared'
        WHERE wakeup_id = 'wake-full'`;
      assert.isFalse(yield* allows("Bash", shell));
      // A turn others read never gets the full session.
      const shared = yield* open("kin-shared:tech");
      assert.deepStrictEqual(Object.keys(shared?.hooks ?? {}), ["PreToolUse"]);
      assert.deepStrictEqual(shared?.tools, ["ToolSearch", "WebSearch"]);
      // Its web search runs at Anthropic; the turn reads as outside-read before results arrive.
      yield* sql`UPDATE kin_wakeups SET thread_id = 'kin-shared:tech' WHERE wakeup_id = 'wake-full'`;
      const sharedAllows = (tool: string, input: unknown) =>
        Effect.promise(() => hookAllows(shared, tool, input));
      assert.isFalse(yield* sharedAllows("WebFetch", { url: "https://example.com" }));
      assert.isFalse(yield* sharedAllows("Bash", shell));
      assert.isTrue(yield* sharedAllows("WebSearch", { query: "tile distributors" }));
      const [searched] = yield* sql<{ source: string }>`SELECT source
        FROM kin_wakeup_outside_reads WHERE wakeup_id = 'wake-full'`;
      assert.deepStrictEqual(stampReads(searched?.source ?? ""), [{ k: "web" }]);
      // A turn stopped because someone joined searches nothing more.
      yield* sql`UPDATE kin_wakeups SET aborted_at = 1 WHERE wakeup_id = 'wake-full'`;
      assert.isFalse(yield* sharedAllows("WebSearch", { query: "tile distributors" }));
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          ServerConfig.layerTest(process.cwd(), { prefix: "kin-lead-full-" }),
          KinPersistence.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    ),
);

it.effect(
  "two wake-ups of one agent open the same system prompt, tools and servers: the prompt cache's prefix",
  () =>
    Effect.gen(function* () {
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const sql = yield* SqlClient.SqlClient;
      const memory = `${stateDir}/kin/demo-a/memory-read`;
      yield* fs.makeDirectory(memory, { recursive: true });
      const orgId = KinOrgId.make("org-prefix");
      const agentId = KinAgentId.make("tech");
      const services = Context.make(
        KinAgentSessionPolicy,
        KinAgentSessionPolicy.of({
          refusal: (threadId) =>
            fullSessionRefusal(threadId).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
          webSearch: (threadId, host) =>
            webSearchRefusal(threadId, host).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
          delegated: (threadId) =>
            delegatedFromLead(threadId).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
          toolDirectories: ["/kin-home/kin-tools/gh-pinned"],
          agentName: (threadId) =>
            leadNameOf(threadId).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
        }),
      ) as Context.Context<KinServices>;
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
          subagentModel: () => Effect.succeed(null),
          assertComplete: Effect.void,
        }),
      );
      // One wake-up: its own provider session, MCP address and token, at the clock's now.
      const wakeUp = (threadId: string, wakeup: string) =>
        Effect.gen(function* () {
          const runner = yield* ClaudeAdapterV2.ClaudeAgentSdkQueryRunner;
          yield* runner
            .open({
              threadId: ThreadId.make(threadId),
              providerSessionId: ProviderSessionId.make(`session-${wakeup}`),
              options: ClaudeAdapterV2.makeClaudeQueryOptions({
                modelSelection: {
                  instanceId: ProviderInstanceId.make("claudeAgent"),
                  model: "claude-sonnet-4-6",
                },
                nativeThreadId: `native-${wakeup}`,
                resume: false,
                cwd: memory,
                attachmentsDir: "/attachments",
                environment: { PATH: "/usr/bin", HOME: "/home/kin" },
                mcpServers: {
                  kin: {
                    type: "http",
                    url: `http://127.0.0.1:${wakeup.length}/kin/mcp?session=${wakeup}`,
                    headers: { Authorization: `Bearer token-${wakeup}` },
                  },
                },
              }),
            })
            .pipe(Effect.exit);
          return opened.at(-1);
        }).pipe(
          Effect.provide(
            claude.install(base).pipe(
              Layer.provide(Layer.succeed(HostProcess.HomeDirectory, stateDir)),
              Layer.provide(
                Layer.succeed(KinServer, {
                  taskCardUpdater: Layer.empty,
                  services: Option.some(services),
                  subscribeForViewer: Option.none(),
                }),
              ),
              Layer.provide(
                ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true })),
              ),
            ),
          ),
        );
      const prefix = (options: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions | undefined) =>
        JSON.stringify({
          systemPrompt: options?.systemPrompt,
          tools: options?.tools,
          disallowedTools: options?.disallowedTools,
          mcpServers: Object.entries(options?.mcpServers ?? {}).map(([name, server]) => {
            const {
              url: _url,
              headers: _headers,
              ...rest
            } = server as {
              url?: string;
              headers?: Record<string, string>;
            };
            return [name, rest];
          }),
        });
      const prompts: Array<string> = [];
      for (const threadId of [`kin:${agentId}`, `kin-shared:${agentId}`]) {
        yield* ownerOnlyWakeup({ orgId, agentId, wakeupId: `${threadId}:first` });
        yield* fs.writeFileString(`${memory}/notes.md`, "Ambermill invoices go out on the 1st.");
        const first = yield* wakeUp(threadId, `first-${threadId}`);
        // Minutes later, with new memory and new events between them.
        yield* TestClock.adjust("3 minutes");
        yield* fs.writeFileString(`${memory}/notes.md`, "Rhea moved invoicing to the 5th.");
        yield* fs.writeFileString(`${memory}/clients.md`, "Orbit Dental pays late.");
        yield* ownerOnlyWakeup({ orgId, agentId, wakeupId: `${threadId}:second` });
        const second = yield* wakeUp(threadId, `second-${threadId}`);
        assert.isDefined(first?.systemPrompt, threadId);
        assert.strictEqual(prefix(second), prefix(first), threadId);
        // Kin's tools are listed before the first request goes out (ClaudeAdapterV2 does this for
        // resumed sessions only).
        assert.strictEqual(first?.env?.MCP_CONNECTION_NONBLOCKING, "0", threadId);
        const system = first?.systemPrompt;
        prompts.push(
          typeof system === "object" && "prompt" in system ? [system.prompt].flat().join("") : "",
        );
      }
      assert.deepStrictEqual(prompts, [
        kinInstructions("owner", "claudeAgent"),
        kinInstructions("confined", "claudeAgent"),
      ]);
      // The instructions name no time, id or path: they are the same for every agent and wake-up.
      for (const [index, text] of prompts.entries()) {
        const seat = index === 0 ? "owner" : "confined";
        for (const pattern of [
          /\d{4}-\d{2}-\d{2}/,
          /T\d{2}:\d{2}/,
          /\d{9,}/,
          /[0-9a-f]{8}-[0-9a-f]{4}-/i,
          /\b[0-9A-HJKMNP-TV-Z]{26}\b/,
          /\b[0-9a-f]{12,}\b/,
          /(?:^|[\s"'`(])~?\/[\w.-]+\//m,
        ])
          assert.notMatch(text, pattern, seat);
        for (const fact of [agentId, orgId, stateDir, memory, "session-", "native-", "token-"])
          assert.notInclude(text, fact, seat);
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          ServerConfig.layerTest(process.cwd(), { prefix: "kin-lead-prefix-" }),
          KinPersistence.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    ),
);

/** The reason the session's PreToolUse hooks deny a call with, or `undefined` when none does. */
const hookDenial = async (
  options: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions | undefined,
  tool_name: string,
  tool_input: unknown,
) => {
  for (const matcher of options?.hooks?.PreToolUse ?? [])
    for (const hook of matcher.hooks) {
      const output = await hook(
        {
          hook_event_name: "PreToolUse",
          session_id: "session",
          transcript_path: "",
          cwd: options?.cwd ?? "",
          tool_name,
          tool_input,
          tool_use_id: "tool",
        },
        "tool",
        { signal: new AbortController().signal },
      );
      if (
        "hookSpecificOutput" in output &&
        output.hookSpecificOutput?.hookEventName === "PreToolUse" &&
        output.hookSpecificOutput.permissionDecision === "deny"
      )
        return output.hookSpecificOutput.permissionDecisionReason ?? "denied";
    }
  return undefined;
};

it.effect(
  "a task delegated from the owner's turn has a shell exactly while that turn would; one from a teammate's turn never does",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sql = yield* SqlClient.SqlClient;
      // T3's Scratch folder for the task: outside Kin's state, so only its lineage marks it Kin's.
      const scratch = yield* fs.makeTempDirectoryScoped();
      const orgId = KinOrgId.make("org-delegated");
      const agentId = KinAgentId.make("tech");
      yield* ownerOnlyWakeup({ orgId, agentId, wakeupId: "wake-owner" });
      yield* ownerOnlyWakeup({ orgId, agentId, wakeupId: "wake-mate" });
      // The owner's turn delegated and is still waiting; a teammate's earlier turn did too.
      yield* sql`UPDATE kin_wakeups SET thread_id = 'kin:tech', audience = 'owner_only',
        run_id = 'run-owner', status = 'running' WHERE wakeup_id = 'wake-owner'`;
      yield* sql`UPDATE kin_wakeups SET thread_id = 'kin:tech', audience = 'shared',
        run_id = 'run-mate', started_at = -1 WHERE wakeup_id = 'wake-mate'`;
      yield* wakeupRun({
        threadId: "kin:tech",
        runId: "run-mate",
        ordinal: 1,
        wakeupId: "wake-mate",
      });
      yield* wakeupRun({
        threadId: "kin:tech",
        runId: "run-owner",
        ordinal: 2,
        wakeupId: "wake-owner",
      });
      const link = (id: string, parent: string, run: string, child: string) =>
        sql`INSERT INTO orchestration_v2_projection_subagents (subagent_id, thread_id, run_id,
          parent_node_id, provider, child_thread_id, origin, status, updated_at, payload_json)
          VALUES (${id}, ${parent}, ${run}, 'node', 'claudeAgent', ${child}, 'app_owned',
            'running', '', '{}')`;
      yield* link("task-owner", "kin:tech", "run-owner", "child-owner");
      yield* link("task-grand", "child-owner", "run-child", "grandchild-owner");
      let parent = "grandchild-owner";
      for (let depth = 3; depth <= 9; depth++) {
        const child = `nested-owner-${depth}`;
        yield* link(child, parent, "run-child", child);
        parent = child;
      }
      yield* link("task-mate", "kin:tech", "run-mate", "child-mate");
      yield* link("task-mate-grand", "child-mate", "run-mate-child", "grandchild-mate");
      const services = Context.make(
        KinAgentSessionPolicy,
        KinAgentSessionPolicy.of({
          refusal: (threadId) =>
            fullSessionRefusal(threadId).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
          webSearch: (threadId, host) =>
            webSearchRefusal(threadId, host).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
          delegated: (threadId) =>
            delegatedFromLead(threadId).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
          toolDirectories: ["/kin-home/kin-tools/gh-pinned"],
          agentName: (threadId) =>
            leadNameOf(threadId).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
        }),
      ) as Context.Context<KinServices>;
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
          subagentModel: () => Effect.succeed(null),
          assertComplete: Effect.void,
        }),
      );
      const task = optionsAt(scratch, { PATH: "/usr/bin", HOME: "/home/kin" });
      const open = (threadId: string, options = task) =>
        Effect.gen(function* () {
          const runner = yield* ClaudeAdapterV2.ClaudeAgentSdkQueryRunner;
          yield* runner
            .open({
              threadId: ThreadId.make(threadId),
              providerSessionId: ProviderSessionId.make("session"),
              options,
            })
            .pipe(Effect.exit);
          return opened.at(-1);
        }).pipe(
          Effect.provide(
            claude.install(base).pipe(
              Layer.provide(Layer.succeed(HostProcess.HomeDirectory, `${scratch}-host-home`)),
              Layer.provide(Layer.succeed(HostProcess.ExecutablePath, FIXTURE_NODE)),
              Layer.provide(
                Layer.succeed(KinServer, {
                  taskCardUpdater: Layer.empty,
                  services: Option.some(services),
                  subscribeForViewer: Option.none(),
                }),
              ),
              Layer.provide(
                ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true })),
              ),
            ),
          ),
        );
      const denial = (options: typeof task | undefined, tool: string, input: unknown) =>
        Effect.promise(() => hookDenial(options, tool, input));
      const shell = { command: "git clone https://github.com/invented/site && gh pr create" };

      // Any other T3 thread opens untouched.
      assert.strictEqual(yield* open("plain-thread"), task);

      const child = yield* open("child-owner");
      const grandchild = yield* open("grandchild-owner");
      const prompt = JSON.stringify(child?.systemPrompt) ?? "";
      assert.include(prompt, "Your shell runs in a sandbox");
      assert.notInclude(prompt, "use web_page to read other public pages");
      assert.strictEqual(child?.tools, task.tools);
      assert.includeMembers(child?.disallowedTools ?? [], ["PowerShell", "Agent", "EnterWorktree"]);
      assert.strictEqual(child?.skills, task.skills);
      assert.notProperty(child, "additionalDirectories");
      const { stateDir } = yield* ServerConfig.ServerConfig;
      assert.strictEqual(
        child?.env?.PATH,
        `${stateDir}/kin/gh-sign:/kin-home/kin-tools/gh-pinned:${FIXTURE_NODE_BIN}:/usr/bin`,
      );
      assert.deepStrictEqual(child?.settingSources, []);
      assert.isTrue(child?.strictMcpConfig);
      const childHooks = child?.hooks;
      assert.match(child?.env?.TMPDIR ?? "", /kin-session-tmp[/\\]session-/);
      assert.notStrictEqual(child?.env?.TMPDIR, grandchild?.env?.TMPDIR);
      assert.deepStrictEqual(child?.env, {
        TMPDIR: child?.env?.TMPDIR,
        CLAUDE_CODE_TMPDIR: child?.env?.TMPDIR,
        npm_config_cache: `${child?.env?.TMPDIR}/npm-cache`,
        PATH: `${stateDir}/kin/gh-sign:/kin-home/kin-tools/gh-pinned:${FIXTURE_NODE_BIN}:/usr/bin`,
        HOME: "/home/kin",
        KIN_AGENT_NAME: "Lead",
        ENABLE_TOOL_SEARCH: "true",
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      });
      assert.deepStrictEqual(Object.keys(childHooks ?? {}), ["PreToolUse"]);
      yield* fs.makeDirectory(`${stateDir}/kin/memory-read`, { recursive: true });
      const own = yield* open("kin:tech", optionsAt(`${stateDir}/kin/memory-read`, task.env));
      assert.strictEqual(own?.env?.KIN_AGENT_NAME, "Lead");
      for (const worker of [child, grandchild, yield* open(parent)]) {
        assert.deepStrictEqual(
          { name: worker?.env?.KIN_AGENT_NAME, path: worker?.env?.PATH },
          { name: own?.env?.KIN_AGENT_NAME, path: own?.env?.PATH },
        );
      }
      assert.strictEqual(
        typeof child?.settings === "object" && child.settings.includeCoAuthoredBy,
        false,
      );
      assert.deepStrictEqual(child?.settingSources, []);
      const secret = `${stateDir}/secrets/fixture.bin`;
      yield* fs.makeDirectory(`${stateDir}/secrets`, { recursive: true });
      yield* fs.writeFileString(secret, "fixture");
      yield* fs.symlink(secret, `${scratch}/linked-secret`);
      yield* fs.writeFileString(`${scratch}/notes.md`, "fixture");
      for (const session of [child, grandchild]) {
        for (const tool of ["Read", "Edit", "Write"]) {
          for (const file_path of [
            secret,
            `${stateDir}/statev2.sqlite`,
            `${stateDir}/kin/another-person/private.md`,
            `${scratch}/linked-secret`,
          ])
            assert.isString(yield* denial(session, tool, { file_path }), `${tool}: ${file_path}`);
          assert.strictEqual(
            yield* denial(session, tool, { file_path: `${scratch}/notes.md` }),
            "Use your shell for files in your working folder.",
          );
        }
        const sandbox = typeof session?.settings === "object" && session.settings.sandbox;
        assert.isObject(sandbox);
        assert.deepInclude(sandbox, {
          enabled: true,
          failIfUnavailable: true,
          allowUnsandboxedCommands: false,
        });
        if (sandbox) assert.include(sandbox.filesystem?.denyRead ?? [], stateDir);
        assert.isUndefined(yield* denial(session, "Bash", shell));
        assert.isString(yield* denial(session, "Agent", { prompt: "look" }));
        assert.isUndefined(yield* denial(session, "mcp__t3__delegate_task", { task: "x" }));
      }
      // The asking turn finished: an owner-only turn's rule still holds for its task.
      yield* sql`UPDATE kin_wakeups SET status = 'completed' WHERE wakeup_id = 'wake-owner'`;
      assert.isUndefined(yield* denial(child, "Bash", shell));
      // The turn read outside text: its tasks lose the shell and T3's tools with it.
      yield* sql`INSERT INTO kin_wakeup_outside_reads (org_id, wakeup_id, read_at, source)
        VALUES (${orgId}, 'wake-owner', 0, 'conn_mail')`;
      for (const session of [child, grandchild]) {
        assert.strictEqual(yield* denial(session, "Bash", shell), SESSION_REFUSAL.outside);
        assert.strictEqual(
          yield* denial(session, "mcp__t3__delegate_task", { task: "x" }),
          SESSION_REFUSAL.outside,
        );
      }
      yield* sql`DELETE FROM kin_wakeup_outside_reads WHERE wakeup_id = 'wake-owner'`;
      // Someone else joined the chat: the turn is shared now, and so are its tasks.
      yield* sql`UPDATE kin_wakeups SET aborted_at = 1 WHERE wakeup_id = 'wake-owner'`;
      assert.strictEqual(yield* denial(grandchild, "Bash", shell), SESSION_REFUSAL.aborted);

      // A teammate's turn: no child or grandchild ever gets a shell or T3's tools.
      for (const threadId of ["child-mate", "grandchild-mate"]) {
        const session = yield* open(threadId);
        assert.strictEqual(yield* denial(session, "Bash", shell), SESSION_REFUSAL.shared);
        assert.strictEqual(
          yield* denial(session, "Edit", { file_path: "x" }),
          SESSION_REFUSAL.shared,
        );
        assert.strictEqual(
          yield* denial(session, "mcp__t3__t3_thread_launch", {}),
          SESSION_REFUSAL.shared,
        );
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          ServerConfig.layerTest(process.cwd(), { prefix: "kin-lead-delegated-" }),
          KinPersistence.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    ),
);
