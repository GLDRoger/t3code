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

import { fullSessionRefusal } from "./AgentSession.ts";
import * as ServerConfig from "../../config.ts";
import * as CodexAdapterV2 from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CodexIsolation from "./CodexIsolation.ts";
import { ownerOnlyWakeup } from "./Audience.testkit.ts";
import { SESSION_REFUSAL } from "./Audience.ts";
import { KinAgentSessionPolicy } from "./sessionPolicy.ts";
import { KinServer, type Services as KinServices } from "../KinServer.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";

type Sent = { readonly method: string; readonly params: Record<string, unknown> };

/** A Codex client that records what reaches the app-server and answers config/read. */
const recordingClient = (sent: Array<Sent>) =>
  ({
    raw: {
      request: (method: string, params: Record<string, unknown>) =>
        Effect.sync(() => {
          sent.push({ method, params });
          return method === "config/read"
            ? { config: { mcp_servers: { chrome: {}, sentry: {}, "t3-code": {} } } }
            : {};
        }),
    },
    request: (method: string, params: Record<string, unknown>) =>
      Effect.sync(() => {
        sent.push({ method: `typed:${method}`, params });
        return {};
      }),
  }) as unknown as CodexClient.CodexAppServerClient["Service"];

const kinServer = Layer.succeed(KinServer, {
  taskCardUpdater: Layer.empty,
  services: Option.some(
    Context.make(
      KinAgentSessionPolicy,
      KinAgentSessionPolicy.of({
        refusal: () => Effect.undefined,
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

const session = (threadId: string, cwd: string, enabled = true) =>
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
      yield* client.request("thread/start", { ...t3ThreadStart, cwd } as never).pipe(Effect.exit);
      yield* client.raw.request("thread/resume", { threadId: "native", ...t3ThreadStart, cwd });
      yield* client.request("turn/start", t3TurnStart as never).pipe(Effect.exit);
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
        CodexIsolation.codexClientFactory(base).pipe(
          Layer.provide(kinServer),
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: enabled }))),
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
      for (const threadId of ["kin-shared:finance"]) {
        const sent = yield* session(threadId, memory);
        const [read, start, resume, turn] = sent;
        assert.deepStrictEqual(read, { method: "config/read", params: { cwd: memory } });
        for (const thread of [start, resume]) {
          const params = thread!.params;
          // Raw, so `environments` survives the stable schema.
          assert.oneOf(thread!.method, ["thread/start", "thread/resume"]);
          assert.deepStrictEqual(params.environments, []);
          assert.strictEqual(params.sandbox, "read-only");
          assert.strictEqual(params.approvalPolicy, "never");
          assert.strictEqual(params.baseInstructions, CodexIsolation.codexInstructions);
          const config = params.config as Record<string, unknown>;
          for (const [key, value] of Object.entries(CodexIsolation.CONFINED_CONFIG))
            assert.deepStrictEqual(config[key], value, key);
          // The user's own servers are off by name; T3's keep Kin's endpoint, calls approved.
          assert.strictEqual(config["mcp_servers.chrome.enabled"], false);
          assert.strictEqual(config["mcp_servers.sentry.enabled"], false);
          assert.notProperty(config, "mcp_servers.t3-code.enabled");
          assert.deepStrictEqual(config["mcp_servers.t3-code"], {
            ...t3ThreadStart.config["mcp_servers.t3-code"],
            default_tools_approval_mode: "approve",
          });
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
  "a Codex task a lead delegated posts on GitHub through the signing gh; other Codex threads, and Kin off, are untouched",
  () =>
    Effect.gen(function* () {
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const [, delegated] = yield* session("task-from-lead", "/work/scratch");
      assert.deepStrictEqual(delegated?.params.config, {
        ...t3ThreadStart.config,
        "shell_environment_policy.set.PATH": `${stateDir}/kin/gh-sign:/kin-home/kin-tools/gh-pinned:/usr/bin`,
        "shell_environment_policy.set.KIN_AGENT_NAME": "Tech lead",
      });
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

type Asked = (payload: unknown) => Effect.Effect<unknown, unknown>;

it.effect(
  "an owner-only Codex thread gets a full session, and Kin decides each command, patch, network call and sub-agent's ask from the turn as it is then",
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
          delegated: () => Effect.succeed(false),
          toolDirectories: ["/kin-home/kin-tools/gh-pinned"],
          agentName: () => Effect.succeed("Tech lead"),
        }),
      ) as Context.Context<KinServices>;
      const sent: Array<Sent> = [];
      const answers = new Map<string, Asked>();
      const recorded = recordingClient(sent);
      const client = {
        ...recorded,
        handleServerRequest: (method: string, handler: Asked) =>
          Effect.sync(() => void answers.set(method, handler)),
      } as unknown as CodexClient.CodexAppServerClient["Service"];
      const base = Layer.succeed(
        CodexAdapterV2.CodexAppServerClientFactory,
        CodexAdapterV2.CodexAppServerClientFactory.of({ open: () => Effect.succeed(client) }),
      );
      const shownToAPerson: Asked = () => Effect.die("an ask on a Kin thread reached a person");
      yield* Effect.gen(function* () {
        const factory = yield* CodexAdapterV2.CodexAppServerClientFactory;
        const opened = yield* factory.open({
          instanceId: ProviderInstanceId.make("codex"),
          threadId: ThreadId.make("kin:tech"),
          providerSessionId: ProviderSessionId.make("session"),
          runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: memory },
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
        yield* opened.raw.request("thread/start", { ...t3ThreadStart, cwd: memory });
        yield* opened.raw.request("turn/start", t3TurnStart);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          CodexIsolation.codexClientFactory(base).pipe(
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
      const start = sent.find(({ method }) => method === "thread/start")!.params;
      assert.notProperty(start, "environments");
      assert.strictEqual(start.approvalPolicy, "untrusted");
      assert.strictEqual(start.approvalsReviewer, "user");
      assert.strictEqual(start.sandbox, "danger-full-access");
      assert.strictEqual(start.baseInstructions, CodexIsolation.codexFullSessionInstructions);
      const config = start.config as Record<string, unknown>;
      for (const [key, value] of Object.entries(CodexIsolation.FULL_SESSION_CONFIG))
        assert.deepStrictEqual(config[key], value, key);
      // What can't ask stays off; the user's own servers too.
      assert.strictEqual(config.web_search, "disabled");
      assert.strictEqual(config["features.unified_exec"], false);
      assert.strictEqual(config["tools.view_image"], false);
      assert.strictEqual(config["mcp_servers.chrome.enabled"], false);
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
      assert.deepStrictEqual(sent.find(({ method }) => method === "turn/start")?.params, {
        threadId: "native",
        input: t3TurnStart.input,
        approvalPolicy: "untrusted",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "dangerFullAccess" },
      });

      const ask = (method: string, payload: object) => answers.get(method)!(payload);
      const command = (text: string, thread = "native") => ({
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
      const patch = { threadId: "native", turnId: "turn-native", itemId: "patch", startedAtMs: 0 };

      // No running turn on the thread, such as a run Kin hasn't adopted: refused.
      assert.deepStrictEqual(
        yield* ask("item/commandExecution/requestApproval", command("echo hi")),
        {
          decision: "decline",
        },
      );
      assert.deepStrictEqual(steers(), [
        {
          threadId: "native",
          expectedTurnId: "turn-native",
          input: [{ type: "text", text: SESSION_REFUSAL.none }],
        },
      ]);
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
      assert.deepStrictEqual(yield* ask("execCommandApproval", { conversationId: "native" }), {
        decision: "approved",
      });
      // Nothing more than the session already has is ever granted.
      assert.deepStrictEqual(yield* ask("item/permissions/requestApproval", {}), {
        permissions: {},
      });
      // Within the same turn the next call is decided again: outside text read, so refused.
      yield* sql`INSERT INTO kin_wakeup_outside_reads (org_id, wakeup_id, read_at, source)
        VALUES (${orgId}, 'wake-codex', 0, 'conn_mail')`;
      assert.deepStrictEqual(
        yield* ask("item/commandExecution/requestApproval", command("echo hi")),
        {
          decision: "decline",
        },
      );
      assert.deepStrictEqual(steers().at(-1), {
        threadId: "native",
        expectedTurnId: "turn-native",
        input: [{ type: "text", text: SESSION_REFUSAL.outside }],
      });
      yield* sql`DELETE FROM kin_wakeup_outside_reads WHERE wakeup_id = 'wake-codex'`;
      // A teammate is now in the chat: every kind of ask is refused with the session refusal.
      yield* sql`UPDATE kin_wakeups SET audience = 'shared' WHERE wakeup_id = 'wake-codex'`;
      for (const [method, payload] of [
        ["item/commandExecution/requestApproval", command("echo hi")],
        ["item/fileChange/requestApproval", patch],
        ["item/commandExecution/requestApproval", curl],
        ["item/commandExecution/requestApproval", command("ls", "sub-agent")],
      ] as const)
        assert.deepStrictEqual(yield* ask(method, payload), { decision: "decline" }, method);
      assert.deepStrictEqual(
        steers()
          .slice(-4)
          .map(({ threadId, input }) => [threadId, input]),
        [
          ["native", [{ type: "text", text: SESSION_REFUSAL.shared }]],
          ["native", [{ type: "text", text: SESSION_REFUSAL.shared }]],
          ["native", [{ type: "text", text: SESSION_REFUSAL.shared }]],
          ["sub-agent", [{ type: "text", text: SESSION_REFUSAL.shared }]],
        ],
      );
      assert.deepStrictEqual(yield* ask("applyPatchApproval", { conversationId: "native" }), {
        decision: { denied: { rejection: SESSION_REFUSAL.shared } },
      });
      // Every ask was decided on its own; asks Kin doesn't answer keep T3's handler.
      assert.strictEqual(decided, 14);
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
