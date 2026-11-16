import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import type * as CodexClient from "effect-codex-app-server/client";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../../config.ts";
import * as CodexAdapterV2 from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { KinServer, type Services as KinServices } from "../KinServer.ts";
import * as CodexIsolation from "./CodexIsolation.ts";
import { KinAgentSessionPolicy } from "./sessionPolicy.ts";

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
  "every Kin agent turn on Codex, shared or the owner's, runs with no environment, no network and only Kin's MCP endpoint",
  () =>
    Effect.gen(function* () {
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const memory = `${stateDir}/kin/demo-a/memory-read`;
      for (const threadId of ["kin-shared:finance", "kin:finance"]) {
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
            ...t3TurnStart,
            environments: [],
            approvalPolicy: "never",
            sandboxPolicy: { type: "readOnly", networkAccess: false },
          },
        });
        assert.lengthOf(sent, 4);
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
        ["typed:thread/start", "thread/resume", "typed:turn/start"],
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
