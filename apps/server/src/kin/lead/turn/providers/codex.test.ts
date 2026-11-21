import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  KinAgentId,
  KinOrgId,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import type * as CodexClient from "effect-codex-app-server/client";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { fullSessionRefusal } from "../../AgentSession.ts";
import * as ServerConfig from "../../../../config.ts";
import * as CodexAdapterV2 from "../../../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Codex from "./codex.ts";
import { kinInstructions } from "../session.ts";
import { ownerOnlyWakeup } from "../../Audience.testkit.ts";
import { SESSION_REFUSAL } from "../../Audience.ts";
import { KIN_DEFERRED_TOOLS } from "../../deferredTools.ts";
import { KinAgentSessionPolicy } from "../../sessionPolicy.ts";
import { KinServer, type Services as KinServices } from "../../../KinServer.ts";
import * as KinPersistence from "../../../persistence/KinPersistence.ts";
import * as Sqlite from "../../../../persistence/Sqlite.ts";

type Sent = { readonly method: string; readonly params: Record<string, unknown> };

/** Codex's catalog in these tests: it knows 6.1 Sol and no later model. */
const catalog = {
  data: [{ model: "gpt-6.1-sol" }],
  nextCursor: null,
};

/** A Codex client that records what reaches the app-server and answers config/read and model/list. */
const recordingClient = (sent: Array<Sent>) =>
  ({
    raw: {
      request: (method: string, params: Record<string, unknown>) =>
        Effect.sync(() => {
          sent.push({ method, params });
          return method === "config/read"
            ? {
                config: {
                  mcp_servers: { chrome: {}, sentry: {}, "t3-code": {} },
                  model_provider: "gateway",
                },
              }
            : {};
        }),
    },
    request: (method: string, params: Record<string, unknown>) =>
      Effect.sync(() => {
        if (method === "model/list") return catalog;
        sent.push({ method: `typed:${method}`, params });
        return {};
      }),
    handleServerNotification: () => Effect.void,
  }) as unknown as CodexClient.CodexAppServerClient["Service"];

const kinServer = Layer.succeed(KinServer, {
  taskCardUpdater: Layer.empty,
  services: Option.some(
    Context.make(
      KinAgentSessionPolicy,
      KinAgentSessionPolicy.of({
        refusal: () => Effect.undefined,
        webSearch: () => Effect.undefined,
        delegated: (threadId) => Effect.succeed(threadId === "task-from-lead"),
        toolDirectories: ["/kin-home/kin-tools/gh-pinned"],
        agentName: () => Effect.succeed("Tech lead"),
      }),
    ) as Context.Context<KinServices>,
  ),
  subscribeForViewer: Option.none(),
});

// What T3's Codex adapter sends for a Kin agent's thread: full access and T3's MCP servers.
const t3ThreadStart = {
  model: "gpt-6.1-sol",
  cwd: "",
  sandbox: "workspace-write",
  config: {
    "mcp_servers.t3-code": {
      url: "http://127.0.0.1:3773/kin/mcp",
      http_headers: { Authorization: "Bearer issued" },
      disabled_tools: ["t3_thread_wait"],
    },
    "mcp_servers.t3-code-direct": { url: "http://127.0.0.1:3773/kin/mcp" },
  },
};
const t3TurnStart = {
  threadId: "native",
  input: [{ type: "text", text: "Run ls for me" }],
  approvalPolicy: "never",
  sandboxPolicy: { type: "dangerFullAccess" },
  additionalContext: { t3_code_orchestration_01: { kind: "application", value: "Subagents…" } },
};

const guidance = {
  type: "message",
  role: "developer",
  content: [
    { type: "input_text", text: "<t3_code_orchestration_01>Subagents…</t3_code_orchestration_01>" },
  ],
};

const session = (
  threadId: string,
  cwd: string,
  enabled = true,
  input: ReadonlyArray<unknown> = t3TurnStart.input,
  model = t3ThreadStart.model,
) =>
  Effect.gen(function* () {
    const sent: Array<Sent> = [];
    const base = Layer.succeed(
      CodexAdapterV2.CodexAppServerClientFactory,
      CodexAdapterV2.CodexAppServerClientFactory.of({
        open: () => Effect.succeed(recordingClient(sent)),
      }),
    );
    yield* Effect.gen(function* () {
      const factory = yield* CodexAdapterV2.CodexAppServerClientFactory;
      const client = yield* factory.open({
        instanceId: ProviderInstanceId.make("codex"),
        threadId: ThreadId.make(threadId),
        providerSessionId: ProviderSessionId.make("session"),
        runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd },
        settings: {} as never,
        environment: { PATH: "/usr/bin" },
      });
      const thread = { ...t3ThreadStart, model, cwd };
      yield* client.request("thread/start", thread as never).pipe(Effect.exit);
      yield* client.raw.request("thread/resume", { threadId: "native", ...thread });
      yield* client.request("turn/start", { ...t3TurnStart, input } as never).pipe(Effect.exit);
      yield* client
        .request("thread/inject_items", {
          threadId: "native",
          items: [
            guidance,
            { type: "message", role: "user", content: [{ type: "input_text", text: "kept" }] },
          ],
        } as never)
        .pipe(Effect.exit);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Codex.codex
          .install(base)
          .pipe(
            Layer.provide(kinServer),
            Layer.provide(
              ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: enabled })),
            ),
          ),
      ),
    );
    return sent;
  });

it.effect(
  "a Kin agent's turn others read runs on Codex with no environment, no network and only Kin's MCP endpoint",
  () =>
    Effect.gen(function* () {
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const memory = `${stateDir}/kin/demo-a/memory-read`;
      // A model Codex's catalog lacks has no tool search, so it gets every Kin tool up front.
      for (const [model, rare] of [
        ["gpt-6.1-sol", [...KIN_DEFERRED_TOOLS]],
        ["gpt-unlisted-1", []],
      ] as const) {
        const sent = yield* session("kin-shared:finance", memory, true, t3TurnStart.input, model);
        const [read, start, resume, turn] = sent;
        assert.deepStrictEqual(read, { method: "config/read", params: { cwd: memory } });
        for (const thread of [start, resume]) {
          const params = thread!.params;
          // Raw, so `environments` survives the stable schema.
          assert.oneOf(thread!.method, ["thread/start", "thread/resume"]);
          assert.deepStrictEqual(params.environments, []);
          assert.strictEqual(params.sandbox, "read-only");
          assert.strictEqual(params.approvalPolicy, "never");
          assert.strictEqual(params.baseInstructions, kinInstructions("confined", "codex"));
          const config = params.config as Record<string, unknown>;
          for (const [key, value] of Object.entries(Codex.CONFINED_CONFIG))
            assert.deepStrictEqual(config[key], value, key);
          // The user's own servers are off by name; T3's keep Kin's endpoint, calls approved.
          assert.strictEqual(config["mcp_servers.chrome.enabled"], false);
          assert.strictEqual(config["mcp_servers.sentry.enabled"], false);
          assert.notProperty(config, "mcp_servers.t3-code.enabled");
          // Kin's tools up front as a Claude lead gets them, the rare ones deferred on a second mount.
          const { disabled_tools: _, ...endpoint } = t3ThreadStart.config["mcp_servers.t3-code"];
          assert.deepStrictEqual(config["mcp_servers.t3-code"], {
            ...endpoint,
            disabled_tools: ["t3_thread_wait", ...rare],
            omit_tools_from: ["deferred"],
            default_tools_approval_mode: "approve",
          });
          assert.deepStrictEqual(
            config[`mcp_servers.${Codex.KIN_RARE_SERVER}`],
            rare.length === 0
              ? undefined
              : {
                  ...endpoint,
                  enabled_tools: rare,
                  default_tools_approval_mode: "approve",
                },
          );
          // No skills: Claude's Kin sessions load no setting sources.
          assert.strictEqual(config["skills.include_instructions"], false);
          const servers = Object.entries(config).filter(
            ([key, value]) =>
              key.startsWith("mcp_servers.") && typeof value === "object" && value !== null,
          );
          for (const [, value] of servers)
            assert.match((value as { url: string }).url, /\/kin\/mcp$/);
        }
        // T3 asks for full access on every turn; the turn keeps the thread's confinement.
        assert.deepStrictEqual(turn, {
          method: "turn/start",
          params: {
            threadId: "native",
            input: t3TurnStart.input,
            environments: [],
            approvalPolicy: "never",
            sandboxPolicy: { type: "readOnly", networkAccess: false },
          },
        });
        // T3 puts its guidance back after a compaction; a Kin thread keeps only the rest.
        assert.deepStrictEqual(sent[4]?.params.items, [
          { type: "message", role: "user", content: [{ type: "input_text", text: "kept" }] },
        ]);
        assert.lengthOf(sent, 5);
      }
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "kin-codex-isolation-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);

it.effect(
  "a Codex task a lead delegated posts on GitHub through the signing gh and asks Kin before each command, as a Claude task does; other Codex threads, and Kin off, are untouched",
  () =>
    Effect.gen(function* () {
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const [, delegated] = yield* session("task-from-lead", "/work/scratch");
      assert.deepInclude(delegated?.params.config, {
        ...t3ThreadStart.config,
        "shell_environment_policy.inherit": "all",
        "shell_environment_policy.set.PATH": `${stateDir}/kin/gh-sign:/kin-home/kin-tools/gh-pinned:/usr/bin`,
        "shell_environment_policy.set.KIN_AGENT_NAME": "Tech lead",
      });
      assert.deepInclude(delegated?.params, {
        approvalPolicy: "untrusted",
        approvalsReviewer: "user",
      });
      // Its sandbox stays T3's.
      assert.strictEqual(delegated?.params.sandbox, "workspace-write");
      assert.notProperty(delegated?.params ?? {}, "environments");
      const plain = yield* session("thread-1", "/work/project");
      assert.deepStrictEqual(
        plain.map(({ method }) => method),
        ["typed:thread/start", "thread/resume", "typed:turn/start", "typed:thread/inject_items"],
      );
      assert.deepStrictEqual(plain[2]?.params, t3TurnStart);
      const off = yield* session("kin:finance", `${stateDir}/kin/demo-a/memory-read`, false);
      assert.notProperty(off[0]?.params ?? {}, "environments");
      assert.strictEqual(off[0]?.method, "typed:thread/start");
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "kin-codex-signing-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);

type Asked = (payload: unknown) => Effect.Effect<unknown>;

it.effect(
  "on one Codex app-server, opened by any thread, the owner's thread gets a full session, the shared one stays confined and others are untouched; Kin decides each command, patch, network call and sub-agent's ask from its own thread's turn",
  () =>
    Effect.gen(function* () {
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const memory = `${stateDir}/kin/demo-a/memory-read`;
      const sql = yield* SqlClient.SqlClient;
      const orgId = KinOrgId.make("org-codex");
      const agentId = KinAgentId.make("tech");
      yield* ownerOnlyWakeup({ orgId, agentId, wakeupId: "wake-codex" });
      let decided = 0;
      // The policy Kin builds (`AgentSession.sessionPolicyLayer`), with its tool folders stood in.
      const services = Context.make(
        KinAgentSessionPolicy,
        KinAgentSessionPolicy.of({
          refusal: (threadId) =>
            Effect.sync(() => decided++).pipe(
              Effect.andThen(fullSessionRefusal(threadId)),
              Effect.provideService(SqlClient.SqlClient, sql),
            ),
          // Codex's own web search stays off in a confined session: nothing asks this.
          webSearch: () => Effect.die("unused web search"),
          delegated: () => Effect.succeed(false),
          toolDirectories: ["/kin-home/kin-tools/gh-pinned"],
          agentName: () => Effect.succeed("Tech lead"),
        }),
      ) as Context.Context<KinServices>;
      const sent: Array<Sent> = [];
      const answers = new Map<string, Asked>();
      const notified = new Map<string, Asked>();
      const recorded = recordingClient(sent);
      const client = {
        ...recorded,
        raw: {
          request: (method: string, params: Record<string, unknown>) =>
            recorded.raw.request(method, params).pipe(
              Effect.map((answer) => {
                if (method !== "thread/start") return answer;
                const config = params.config as Record<string, unknown>;
                const t3 = config["shell_environment_policy.set.T3CODE_THREAD_ID"];
                const native = { "kin:tech": "native-owner", "kin-shared:tech": "native-shared" };
                return { thread: { id: native[t3 as keyof typeof native] ?? "native-plain" } };
              }),
            ),
        },
        handleServerRequest: (method: string, handler: Asked) =>
          Effect.sync(() => void answers.set(method, handler)),
        handleServerNotification: (method: string, handler: Asked) =>
          Effect.sync(() => void notified.set(method, handler)),
      } as unknown as CodexClient.CodexAppServerClient["Service"];
      const base = Layer.succeed(
        CodexAdapterV2.CodexAppServerClientFactory,
        CodexAdapterV2.CodexAppServerClientFactory.of({ open: () => Effect.succeed(client) }),
      );
      // T3's own handler: the ask is shown to a person in the thread.
      const shownToAPerson: Asked = () => Effect.succeed("shown to a person");
      // T3 marks each thread's shell with its own id (`codexThreadRuntimeParams`).
      const startOf = (t3: string, cwd = memory) => ({
        ...t3ThreadStart,
        cwd,
        config: { ...t3ThreadStart.config, "shell_environment_policy.set.T3CODE_THREAD_ID": t3 },
      });
      yield* Effect.gen(function* () {
        const factory = yield* CodexAdapterV2.CodexAppServerClientFactory;
        // Someone's ordinary T3 thread opens the instance's one process; Kin's threads join it.
        const opened = yield* factory.open({
          instanceId: ProviderInstanceId.make("codex"),
          threadId: ThreadId.make("thread-plain"),
          providerSessionId: ProviderSessionId.make("session"),
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: "/work/project",
          },
          settings: {} as never,
          environment: { PATH: "/usr/bin" },
        });
        // What T3's adapter registers: each ask shown to a person in the thread.
        for (const method of [
          "item/commandExecution/requestApproval",
          "item/fileChange/requestApproval",
          "item/permissions/requestApproval",
          "execCommandApproval",
          "applyPatchApproval",
          "item/tool/requestUserInput",
        ])
          yield* opened.handleServerRequest(method as never, shownToAPerson as never);
        yield* opened.raw.request("thread/start", startOf("thread-plain", "/work/project"));
        for (const t3 of ["kin:tech", "kin-shared:tech"])
          yield* opened.raw.request("thread/start", startOf(t3));
        for (const native of ["native-plain", "native-owner", "native-shared"])
          yield* opened.raw.request("turn/start", { ...t3TurnStart, threadId: native });
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Codex.codex.install(base).pipe(
            Layer.provide(
              Layer.succeed(KinServer, {
                taskCardUpdater: Layer.empty,
                services: Option.some(services),
                subscribeForViewer: Option.none(),
              }),
            ),
            Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
          ),
        ),
      );
      const [plainStart, ownerStart, sharedStart] = sent
        .filter(({ method }) => method === "thread/start")
        .map(({ params }) => params);
      assert.deepStrictEqual(plainStart, startOf("thread-plain", "/work/project"));
      assert.notProperty(ownerStart, "environments");
      assert.strictEqual(ownerStart?.approvalPolicy, "untrusted");
      assert.strictEqual(ownerStart?.approvalsReviewer, "user");
      assert.strictEqual(ownerStart?.sandbox, "danger-full-access");
      assert.strictEqual(ownerStart?.baseInstructions, kinInstructions("owner", "codex"));
      const config = ownerStart?.config as Record<string, unknown>;
      for (const [key, value] of Object.entries(Codex.FULL_SESSION_CONFIG))
        assert.deepStrictEqual(config[key], value, key);
      // Search from the cached index and image viewing, as Claude's owner turn has them; unified
      // exec, whose stdin Codex doesn't ask about, and the user's own servers stay off.
      assert.strictEqual(config.web_search, "cached");
      assert.strictEqual(config["tools.view_image"], true);
      assert.strictEqual(config["features.unified_exec"], false);
      assert.strictEqual(config["skills.include_instructions"], false);
      assert.strictEqual(config["mcp_servers.chrome.enabled"], false);
      // gpt-6.1's search is Codex's own call, made on a custom provider only when it says so.
      assert.strictEqual(config["model_providers.gateway.supports_standalone_web_search"], true);
      // The signing gh first on PATH and the env a Claude agent's session keeps, nothing else.
      assert.strictEqual(
        config["shell_environment_policy.set.PATH"],
        `${stateDir}/kin/gh-sign:/kin-home/kin-tools/gh-pinned:/usr/bin`,
      );
      assert.strictEqual(config["shell_environment_policy.set.KIN_AGENT_NAME"], "Tech lead");
      const kept = config["shell_environment_policy.include_only"] as ReadonlyArray<string>;
      for (const name of ["PATH", "HOME", "KIN_AGENT_NAME", "T3CODE_THREAD_ID"])
        assert.include(kept, name);
      assert.notInclude(kept, "KIN_GITHUB_APP_ID");
      // The shared thread on the same process: no environment, nothing asked, no shell note.
      assert.deepStrictEqual(sharedStart?.environments, []);
      assert.strictEqual(sharedStart?.approvalPolicy, "never");
      assert.strictEqual(sharedStart?.sandbox, "read-only");
      assert.strictEqual(sharedStart?.baseInstructions, kinInstructions("confined", "codex"));
      const turns = sent
        .filter(({ method }) => method === "turn/start")
        .map(({ params }) => params);
      assert.deepStrictEqual(turns, [
        { ...t3TurnStart, threadId: "native-plain" },
        {
          threadId: "native-owner",
          input: t3TurnStart.input,
          approvalPolicy: "untrusted",
          approvalsReviewer: "user",
          sandboxPolicy: { type: "dangerFullAccess" },
        },
        {
          threadId: "native-shared",
          input: t3TurnStart.input,
          environments: [],
          approvalPolicy: "never",
          sandboxPolicy: { type: "readOnly", networkAccess: false },
        },
      ]);

      // A Codex sub-agent of the owner's thread starts on the same process.
      yield* notified.get("thread/started")!({
        thread: { id: "sub-agent", parentThreadId: "native-owner" },
      });
      const ask = (method: string, payload: object) => answers.get(method)!(payload);
      const command = (text: string, thread = "native-owner") => ({
        threadId: thread,
        turnId: `turn-${thread}`,
        itemId: "item",
        startedAtMs: 0,
        command: text,
      });
      const steers = () =>
        sent.filter(({ method }) => method === "typed:turn/steer").map(({ params }) => params);
      const curl = {
        ...command("curl -s https://example.com"),
        networkApprovalContext: { host: "example.com", protocol: "https" },
      };
      const patch = {
        threadId: "native-owner",
        turnId: "turn-native-owner",
        itemId: "patch",
        startedAtMs: 0,
      };
      const refusedWith = (text: string, thread = "native-owner") => ({
        threadId: thread,
        expectedTurnId: `turn-${thread}`,
        input: [{ type: "text", text }],
      });

      // No running turn on the owner's thread, such as a run Kin hasn't adopted: refused.
      assert.deepStrictEqual(
        yield* ask("item/commandExecution/requestApproval", command("echo hi")),
        { decision: "decline" },
      );
      assert.deepStrictEqual(steers(), [refusedWith(SESSION_REFUSAL.none)]);
      // The owner's own turn: a command, a patch, a network call and a sub-agent's command run.
      yield* sql`UPDATE kin_wakeups SET status = 'running', thread_id = 'kin:tech',
        audience = 'owner_only' WHERE wakeup_id = 'wake-codex'`;
      for (const [method, payload] of [
        ["item/commandExecution/requestApproval", command("echo hi")],
        ["item/fileChange/requestApproval", patch],
        ["item/commandExecution/requestApproval", curl],
        ["item/commandExecution/requestApproval", command("ls", "sub-agent")],
      ] as const)
        assert.deepStrictEqual(yield* ask(method, payload), { decision: "accept" }, method);
      assert.deepStrictEqual(
        yield* ask("execCommandApproval", { conversationId: "native-owner" }),
        {
          decision: "approved",
        },
      );
      // Meanwhile the shared thread on the same process doesn't borrow the owner's turn.
      assert.deepStrictEqual(
        yield* ask("item/commandExecution/requestApproval", command("echo hi", "native-shared")),
        { decision: "decline" },
      );
      assert.deepStrictEqual(steers().at(-1), refusedWith(SESSION_REFUSAL.none, "native-shared"));

      // An ordinary thread's asks still reach a person, as T3 shows them.
      assert.strictEqual(
        yield* ask(
          "item/commandExecution/requestApproval",
          command("rm -rf build", "native-plain"),
        ),
        "shown to a person",
      );
      // Nothing more than the session already has is ever granted.
      assert.deepStrictEqual(
        yield* ask("item/permissions/requestApproval", { threadId: "native-owner" }),
        {
          permissions: {},
        },
      );
      // Within the same turn the next call is decided again: outside text read, so refused.
      yield* sql`INSERT INTO kin_wakeup_outside_reads (org_id, wakeup_id, read_at, source)
        VALUES (${orgId}, 'wake-codex', 0, 'conn_mail')`;
      assert.deepStrictEqual(
        yield* ask("item/commandExecution/requestApproval", command("echo hi")),
        { decision: "decline" },
      );
      assert.deepStrictEqual(steers().at(-1), refusedWith(SESSION_REFUSAL.outside));
      yield* sql`DELETE FROM kin_wakeup_outside_reads WHERE wakeup_id = 'wake-codex'`;
      // A teammate is now in the owner's chat: every kind of ask is refused with the session refusal.
      yield* sql`UPDATE kin_wakeups SET audience = 'shared' WHERE wakeup_id = 'wake-codex'`;
      for (const [method, payload] of [
        ["item/commandExecution/requestApproval", command("echo hi")],
        ["item/fileChange/requestApproval", patch],
        ["item/commandExecution/requestApproval", curl],
        ["item/commandExecution/requestApproval", command("ls", "sub-agent")],
      ] as const)
        assert.deepStrictEqual(yield* ask(method, payload), { decision: "decline" }, method);
      assert.deepStrictEqual(steers().slice(-4), [
        refusedWith(SESSION_REFUSAL.shared),
        refusedWith(SESSION_REFUSAL.shared),
        refusedWith(SESSION_REFUSAL.shared),
        refusedWith(SESSION_REFUSAL.shared, "sub-agent"),
      ]);
      assert.deepStrictEqual(yield* ask("applyPatchApproval", { conversationId: "native-owner" }), {
        decision: { denied: { rejection: SESSION_REFUSAL.shared } },
      });
      // Every ask Kin could place was decided on its own; the rest keep T3's handler.
      assert.strictEqual(decided, 13);
      assert.strictEqual(answers.get("item/tool/requestUserInput"), shownToAPerson);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerConfig.layerTest(process.cwd(), { prefix: "kin-codex-full-" }),
          KinPersistence.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    ),
);
