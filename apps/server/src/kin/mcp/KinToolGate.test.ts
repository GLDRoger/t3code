import * as NodeUtil from "node:util";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Predicate from "effect/Predicate";
import * as TestClock from "effect/testing/TestClock";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { McpInvocationContext, type McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";

import * as Kin from "../layer.ts";
import { KinDocumentToolkit } from "../gendocs/mcp.ts";
import { TURN_EVENT_TOOLS } from "../lead/eventIds.ts";
import { KinLeadToolkit } from "../lead/mcp/tools.ts";
import { KinPulseToolkit } from "../pulse/mcp.ts";
import { KinDocsToolkit } from "../work/mcp/docTools.ts";
import { KinBillToolkit } from "../work/mcp/billTools.ts";
import { KinStatementToolkit } from "../work/mcp/statementTools.ts";
import { KinWorkToolkit } from "../work/mcp/tools.ts";
import { callCounts, helperModels } from "./KinToolGate.ts";
import { McpProvidersOffered } from "./toolPolicy.ts";

it("fills the event of every Kin tool that takes one, and of no other", () => {
  const takes = [
    KinLeadToolkit,
    KinWorkToolkit,
    KinDocsToolkit,
    KinStatementToolkit,
    KinBillToolkit,
    KinDocumentToolkit,
    KinPulseToolkit,
  ].flatMap((toolkit) =>
    Object.values(toolkit.tools).flatMap((tool) =>
      Predicate.hasProperty(tool.parametersSchema, "fields") &&
      Predicate.hasProperty(tool.parametersSchema.fields, "sourceEventId")
        ? [tool.name]
        : [],
    ),
  );
  assert.isDefined(Kin.layer);
  assert.deepStrictEqual([...TURN_EVENT_TOOLS].toSorted(), takes.toSorted());
});

const Invented = Toolkit.make(
  ...["invented_read", "invented_write"].map((name) =>
    Tool.make(name, {
      description: "Invented: a tool an agent calls.",
      success: Schema.Struct({ ran: Schema.String }),
      failure: OrchestratorMcpFailure,
      failureMode: "return",
    }),
  ),
);
const inventedHandlers = McpToolAccess.toLayer(Invented, {
  invented_read: McpToolAccess.reads(() => Effect.succeed({ ran: "read" })),
  invented_write: McpToolAccess.reads(() => Effect.succeed({ ran: "write" })),
});

const caller: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "lead",
  issuedAt: 0,
  capabilities: new Set(),
  client: undefined,
  thread: {
    threadId: ThreadId.make("lead-thread"),
    providerSessionId: "lead",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "test", version: "1" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

it.effect("counts each tool's calls in memory and logs them in one line an hour", () => {
  const lines: Array<string> = [];
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const call = (name: string) =>
      server
        .callTool({ name, arguments: {} })
        .pipe(
          Effect.provideService(McpSchema.McpServerClient, client),
          Effect.provideService(McpInvocationContext, caller),
        );
    yield* call("invented_read");
    yield* call("invented_read");
    yield* call("invented_write");
    assert.deepStrictEqual(lines, []);
    yield* TestClock.adjust("1 hour");
    assert.lengthOf(lines, 1);
    assert.include(lines[0], "Kin tool calls");
    assert.include(lines[0], "invented_read: 2");
    assert.include(lines[0], "invented_write: 1");
    // A quiet hour logs nothing; the next hour counts afresh.
    yield* TestClock.adjust("1 hour");
    yield* call("invented_write");
    yield* TestClock.adjust("1 hour");
    assert.lengthOf(lines, 2);
    assert.notInclude(lines[1], "invented_read");
    assert.include(lines[1], "invented_write: 1");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        callCounts,
        McpHttpServer.toolkitRegistration(Invented, inventedHandlers),
      ).pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provideMerge(
          Logger.layer(
            [
              Logger.make(
                (options) => void lines.push(NodeUtil.inspect(options.message, { depth: 8 })),
              ),
            ],
            { mergeWithExisting: false },
          ),
        ),
      ),
    ),
  );
});

const inventedProvider = (instanceId: string, driver: string, slugs: ReadonlyArray<string>) =>
  ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver,
    enabled: true,
    installed: true,
    models: slugs.map((slug) => ({
      slug,
      name: slug,
      isCustom: false,
      ...(slug === "invented-quill" ? { aliases: ["quill"] } : {}),
    })),
  }) as unknown as ServerProvider;
/** Stand-ins for T3's two tools, reading what Kin's gate leaves them. */
const Delegation = Toolkit.make(
  Tool.make("delegate_task", {
    description: "Invented: starts a task.",
    parameters: Schema.Struct({ task: Schema.String, target: Schema.optional(Schema.Unknown) }),
    success: Schema.Struct({ ran: Schema.String }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
  }),
  Tool.make("orchestrator_capabilities", {
    description: "Invented: lists models.",
    success: Schema.Struct({ models: Schema.Array(Schema.String) }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
  }),
);

it.effect.each([
  ["a Kin agent", true],
  ["plain T3 Code", false],
] as const)(
  "%s: a helper task starts only on a model agents may run on, and is offered only those",
  ([_who, kin]) => {
    const started: Array<unknown> = [];
    let settings: Parameters<Effect.Success<typeof McpProvidersOffered>>[0];
    const providers = [
      inventedProvider("claudeAgent", "claudeAgent", ["invented-quill", "invented-moth"]),
      inventedProvider("codex", "codex", ["invented-lark"]),
    ];
    const handlers = McpToolAccess.toLayer(Delegation, {
      delegate_task: McpToolAccess.reads(({ target }) =>
        Effect.sync(() => started.push(target ?? null)).pipe(Effect.as({ ran: "started" })),
      ),
      orchestrator_capabilities: McpToolAccess.reads(() =>
        Effect.gen(function* () {
          const offered = yield* (yield* McpProvidersOffered)(settings, providers);
          return { models: offered.flatMap((one) => one.models.map((model) => model.slug)) };
        }),
      ),
    });
    return Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
      const call = (name: string, args: object) =>
        server.callTool({ name, arguments: args }).pipe(
          Effect.provideService(McpSchema.McpServerClient, client),
          Effect.provideService(McpInvocationContext, {
            ...caller,
            thread: {
              ...caller.thread!,
              providerInstanceId: ProviderInstanceId.make("claudeAgent"),
            },
          }),
          Effect.map((result) => JSON.stringify(result)),
          Effect.catch((error) => Effect.succeed(JSON.stringify(error))),
        );
      const refused = [
        { model: "invented-sparrow" },
        { model: "invented-moth" },
        { providerInstanceId: "codex", model: "invented-lark" },
      ];
      const admitted = [undefined, { model: "quill" }, { providerInstanceId: "claudeAgent" }];
      for (const target of refused) {
        const answer = yield* call("delegate_task", { task: "Invented: review", target });
        if (kin) assert.include(answer, "Kin didn't start this task", JSON.stringify(target));
        else assert.include(answer, "started");
      }
      // Nothing started for a refused call: no thread, card or run follows a handler never run.
      assert.lengthOf(started, kin ? 0 : refused.length);
      for (const target of admitted)
        assert.include(
          yield* call("delegate_task", { task: "Invented: review", ...(target ? { target } : {}) }),
          "started",
        );
      assert.include(
        yield* call("orchestrator_capabilities", {}),
        kin
          ? JSON.stringify({ models: ["invented-quill"] })
          : JSON.stringify({ models: ["invented-quill", "invented-moth", "invented-lark"] }),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          McpHttpServer.toolkitRegistration(Delegation, handlers),
          kin ? helperModels : Layer.empty,
        ).pipe(
          Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
          Layer.provideMerge(
            ServerSettings.layerTest({
              providerModelPreferences: { claudeAgent: { hiddenModels: ["invented-moth"] } },
            } as never),
          ),
          Layer.provideMerge(
            Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed(providers) }),
          ),
        ),
      ),
    );
  },
);
