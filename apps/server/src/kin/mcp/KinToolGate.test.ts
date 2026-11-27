import * as NodeUtil from "node:util";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as TestClock from "effect/testing/TestClock";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";
import {
  EnvironmentId,
  KinAgentId,
  KinChatError,
  KinOrgId,
  KinPersonId,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { McpInvocationContext, type McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { advertisedJsonSchema } from "../../mcp/advertisedJsonSchema.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";

import { KinIdentity } from "../chat/KinIdentity.ts";
import { KinServer, type Services } from "../KinServer.ts";
import * as Kin from "../layer.ts";
import { KinDocumentToolkit } from "../gendocs/mcp.ts";
import { TURN_EVENT_TOOLS } from "../lead/eventIds.ts";
import { KinLeadToolkit } from "../lead/mcp/tools.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import { KinPulseToolkit } from "../pulse/mcp.ts";
import { CreateInput, sourceOf, UpdateInput } from "../work/leadWork.ts";
import { KinDocsToolkit } from "../work/mcp/docTools.ts";
import { KinBillToolkit } from "../work/mcp/billTools.ts";
import { KinStatementToolkit } from "../work/mcp/statementTools.ts";
import { KinWorkToolkit } from "../work/mcp/tools.ts";
import * as KinToolGate from "./KinToolGate.ts";
import { McpProvidersOffered } from "./toolPolicy.ts";

it("fills and hides the event of every Kin tool that takes one, and of no other", () => {
  const tools = [
    KinLeadToolkit,
    KinWorkToolkit,
    KinDocsToolkit,
    KinStatementToolkit,
    KinBillToolkit,
    KinDocumentToolkit,
    KinPulseToolkit,
  ].flatMap((toolkit) => Object.values(toolkit.tools) as Array<Tool.Any>);
  const takes = tools.flatMap((tool) =>
    Predicate.hasProperty(Tool.getJsonSchema(tool).properties ?? {}, "sourceEventId")
      ? [tool.name]
      : [],
  );
  assert.isDefined(Kin.layer);
  assert.deepStrictEqual([...TURN_EVENT_TOOLS].toSorted(), takes.toSorted());
  for (const tool of tools)
    assert.notProperty(
      advertisedJsonSchema(tool, { kin: true }).properties ?? {},
      "sourceEventId",
      tool.name,
    );
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

it.effect(
  "fills an omitted source with the latest message, resolves old message IDs, and refuses unknown IDs",
  () => {
    const threadId = ThreadId.make("lead-thread");
    const orgId = KinOrgId.make("org_tidewater_freight");
    const agentId = KinAgentId.make("agent_chief_of_staff");
    const ownerPersonId = KinPersonId.make("person_rhea");
    const wakeupId = "wake_record_source";
    const agent = { _tag: "agent" as const, orgId, agentId, ownerPersonId, threadId };
    const recordTool = <Name extends "record_create" | "record_update">(
      name: Name,
      parameters: Name extends "record_create" ? typeof CreateInput : typeof UpdateInput,
    ) =>
      Tool.make(name, {
        parameters,
        success: Schema.Struct({ sourceEventId: Schema.String }),
        failure: KinChatError,
        failureMode: "return",
        dependencies: [SqlClient.SqlClient],
      }).annotateMerge(KinWorkToolkit.tools[name].annotations);
    const Records = Toolkit.make(
      recordTool("record_create", CreateInput),
      recordTool("record_update", UpdateInput),
    );
    const filled = ({ sourceEventId }: { readonly sourceEventId: string }) =>
      sourceOf({ ...agent, wakeupId, startedAt: 0 }, sourceEventId).pipe(
        Effect.catchTags({ SqlError: Effect.die }),
        Effect.as({ sourceEventId }),
      );
    const handlers = McpToolAccess.toLayer(Records, {
      record_create: McpToolAccess.reads(filled),
      record_update: McpToolAccess.reads(filled),
    });
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const server = yield* McpServer.McpServer;
      const identity = yield* KinIdentity;
      const services = Context.make(KinIdentity, identity).pipe(
        Context.add(SqlClient.SqlClient, sql),
      ) as unknown as Context.Context<Services>;
      const at = "2026-11-27T09:00:00.000Z";
      yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Tidewater Freight', ${at})`;
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
      VALUES (${ownerPersonId}, ${orgId}, 'rhea', 'Rhea', ${at})`;
      yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
      VALUES (${agentId}, ${orgId}, 'Chief of staff', 'lead', ${ownerPersonId}, ${at})`;
      yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
      VALUES ('chat_rhea_chief', ${orgId}, 'direct', 'rhea:chief', 2, ${at})`;
      yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, thread_id, models_json,
      worker_projects_json, owner_chat_id)
      VALUES (${agentId}, ${orgId}, 'Chief of staff', 0, ${threadId}, '{}', '[]', 'chat_rhea_chief')`;
      const messages = [
        ["event_first_message", "message_first", 1],
        ["event_latest_message", "message_latest", 2],
      ] as const;
      yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, model, started_at,
      status, event_ids, audience) VALUES (${wakeupId}, ${orgId}, ${agentId}, ${threadId}, 'test',
        0, 'running', ${JSON.stringify(messages.map(([eventId]) => eventId))}, 'shared')`;
      for (const [eventId, messageId, receivedAt] of messages) {
        const payload = JSON.stringify({ chatId: "chat_rhea_chief", messageId });
        yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json,
        received_at, queued_at, state, wakeup_id)
        VALUES (${eventId}, ${orgId}, ${agentId}, 'chat.message', 'P0', ${payload},
          ${receivedAt}, ${receivedAt}, 'claimed', ${wakeupId})`;
      }

      const rows = {
        record_create: { records: [{ title: "Check the Juniper Cold Chain delivery" }] },
        record_update: { key: "W-12", title: "Check the Juniper Cold Chain delivery" },
      };
      const call = (name: keyof typeof rows, args: { sourceEventId?: string }) =>
        server.callTool({ name, arguments: { ...args, ...rows[name] } }).pipe(
          Effect.provideService(McpSchema.McpServerClient, client),
          Effect.provideService(McpInvocationContext, caller),
          Effect.provideService(KinServer, {
            services: Option.some(services),
            subscribeForViewer: Option.none(),
            taskCardUpdater: Layer.empty,
          }),
        );
      for (const name of ["record_create", "record_update"] as const) {
        for (const [args, sourceEventId] of [
          [{}, "event_latest_message"],
          [{ sourceEventId: "message_first" }, "event_first_message"],
          [{ sourceEventId: "event_first_message" }, "event_first_message"],
        ] as const) {
          const result = yield* call(name, args);
          assert.deepStrictEqual(result.structuredContent, { sourceEventId }, name);
        }
        const refused = yield* call(name, { sourceEventId: "event_unknown" });
        assert.isTrue(refused.isError, name);
        assert.include(
          JSON.stringify(refused.content),
          "sourceEventId must be one of this turn's events. Nothing was written.",
        );
      }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          KinToolGate.layer,
          McpHttpServer.toolkitRegistration(Records, handlers, { kin: true }),
        ).pipe(
          Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
          Layer.provideMerge(
            Layer.mock(KinIdentity)({
              owner: { _tag: "person", orgId, personId: ownerPersonId },
              isAgentThread: (thread) => thread === threadId,
              isLeadThread: (thread) => thread === threadId,
              resolveAgent: () => Effect.succeed(agent),
            }),
          ),
          Layer.provideMerge(KinPersistence.layer),
          Layer.provideMerge(Sqlite.layerMemory),
        ),
      ),
    );
  },
);

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
        KinToolGate.callCounts,
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
          kin ? KinToolGate.helperModels : Layer.empty,
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
