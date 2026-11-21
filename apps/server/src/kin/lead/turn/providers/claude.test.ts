import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
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

import * as ServerConfig from "../../../../config.ts";
import * as ClaudeAdapterV2 from "../../../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { hookAllows, kinSecretVariables } from "../../../claudeConfinement.testkit.ts";
import * as DreamIsolation from "../../../dreaming/DreamIsolation.ts";
import { builtinTools, claude, OWNER_SEAT_OFF } from "./claude.ts";
import { kinInstructions, REVIEW_SEAT_INSTRUCTIONS } from "../session.ts";
import { ownerOnlyWakeup, wakeupRun } from "../../Audience.testkit.ts";
import {
  delegatedFromLead,
  fullSessionRefusal,
  leadNameOf,
  webSearchRefusal,
} from "../../AgentSession.ts";
import { SESSION_REFUSAL } from "../../Audience.ts";
import { KinAgentSessionPolicy } from "../../sessionPolicy.ts";
import { KinServer, type Services as KinServices } from "../../../KinServer.ts";
import * as KinPersistence from "../../../persistence/KinPersistence.ts";
import * as Sqlite from "../../../../persistence/Sqlite.ts";

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
  "a confined Kin session loads no settings file, Kin tools up front and none of Claude Code's own (KIN_ENABLED=%s, lead wrapper outside=%s)",
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
      const [leadOpened, otherOpened, dreamOpened, sharedOpened, reviewOpened] = opened;
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
        // Kin's tools load upfront; only those marked deferred wait for ToolSearch.
        tools: ["ToolSearch", "WebSearch"],
        mcpServers: { kin: { type: "http", url: "http://127.0.0.1/kin", alwaysLoad: true } },
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
        },
      });
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
      const { stateDir } = yield* ServerConfig.ServerConfig;
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
          webSearch: (threadId) =>
            webSearchRefusal(threadId).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
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
      const open = (threadId: string, options = lead) =>
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
      // Claude Code's own tools but those that wait on someone at the screen, the pinned gh first.
      assert.strictEqual(full?.tools, lead.tools);
      assert.deepStrictEqual(full?.disallowedTools, [
        ...new Set([...(lead.disallowedTools ?? []), ...OWNER_SEAT_OFF]),
      ]);
      for (const kept of ["Bash", "Read", "Edit", "Write", "WebFetch", "Agent", "TaskStop"])
        assert.notInclude(full?.disallowedTools ?? [], kept);
      // The signing gh first, then the pinned one; Claude Code's own PR footer and trailer off.
      const signing = `${stateDir}/kin/gh-sign`;
      assert.strictEqual(full?.env?.PATH, `${signing}:/kin-home/kin-tools/gh-pinned:/usr/bin`);
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
      assert.isTrue(yield* allows("Edit", { file_path: "/work/x/README.md" }));
      assert.isTrue(yield* allows("WebFetch", { url: "https://example.com" }));
      assert.isTrue(yield* allows("Agent", { prompt: "look" }));
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
      assert.deepStrictEqual(shared?.tools, ["ToolSearch", "WebSearch"]);
      // Its web search runs at Anthropic; the turn reads as outside-read before results arrive.
      yield* sql`UPDATE kin_wakeups SET thread_id = 'kin-shared:tech' WHERE wakeup_id = 'wake-full'`;
      const sharedAllows = (tool: string, input: unknown) =>
        Effect.promise(() => hookAllows(shared, tool, input));
      assert.isFalse(yield* sharedAllows("WebFetch", { url: "https://example.com" }));
      assert.isFalse(yield* sharedAllows("Bash", shell));
      assert.isTrue(yield* sharedAllows("WebSearch", { query: "tile distributors" }));
      assert.deepStrictEqual(
        yield* sql`SELECT source FROM kin_wakeup_outside_reads WHERE wakeup_id = 'wake-full'`,
        [{ source: "web search" }],
      );
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
      yield* link("task-mate", "kin:tech", "run-mate", "child-mate");
      yield* link("task-mate-grand", "child-mate", "run-mate-child", "grandchild-mate");
      const services = Context.make(
        KinAgentSessionPolicy,
        KinAgentSessionPolicy.of({
          refusal: (threadId) =>
            fullSessionRefusal(threadId).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
          webSearch: (threadId) =>
            webSearchRefusal(threadId).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
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
      const open = (threadId: string) =>
        Effect.gen(function* () {
          const runner = yield* ClaudeAdapterV2.ClaudeAgentSdkQueryRunner;
          yield* runner
            .open({
              threadId: ThreadId.make(threadId),
              providerSessionId: ProviderSessionId.make("session"),
              options: task,
            })
            .pipe(Effect.exit);
          return opened.at(-1);
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
      // T3's own prompt and tools, Kin's hook, and the pinned gh first, as the lead's turn has.
      assert.strictEqual(child?.systemPrompt, task.systemPrompt);
      assert.strictEqual(child?.tools, task.tools);
      // The signing gh first, as its lead's: what it posts ends with the lead's name, no footer.
      const { stateDir } = yield* ServerConfig.ServerConfig;
      assert.strictEqual(
        child?.env?.PATH,
        `${stateDir}/kin/gh-sign:/kin-home/kin-tools/gh-pinned:/usr/bin`,
      );
      assert.strictEqual(grandchild?.env?.KIN_AGENT_NAME, "Lead");
      assert.strictEqual(
        typeof child?.settings === "object" && child.settings.includeCoAuthoredBy,
        false,
      );
      assert.deepStrictEqual(child?.settingSources, []);
      for (const session of [child, grandchild]) {
        assert.isUndefined(yield* denial(session, "Bash", shell));
        assert.isUndefined(yield* denial(session, "Agent", { prompt: "look" }));
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
