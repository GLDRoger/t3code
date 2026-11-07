import * as FileSystem from "effect/FileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthStandardClientScopes,
  EnvironmentId,
  KinAgentId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import { McpSchema, McpServer } from "effect/ai";
import * as McpSessions from "../../mcp/McpSessionRegistry.ts";
import * as KinMcp from "./layer.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import { McpInvocationContext, type McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import { HttpRouter, HttpServerRequest } from "effect/http";
import * as ServerSettings from "../../serverSettings.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Kin from "../layer.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import { KinChatToolkit, handlers, agentServices } from "./KinChatToolkit.ts";

const threadId = ThreadId.make("lead-thread");
const agentId = KinAgentId.make("lead");
const thread = {
  threadId,
  providerSessionId: "session",
  providerInstanceId: ProviderInstanceId.make("provider"),
};
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "session",
  issuedAt: 0,
  capabilities: new Set(),
  client: undefined,
  thread,
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
const runtime = (config: Record<string, unknown>) =>
  Kin.layer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))));
const registration = McpHttpServer.toolkitRegistration(KinChatToolkit, handlers).pipe(
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
);
const fakeRegistry = Layer.succeed(McpSessions.McpSessionRegistry, {
  issue: (request) =>
    Effect.succeed({
      config: {
        environmentId: scope.environmentId,
        threadId: request.threadId,
        providerSessionId: "session",
        providerInstanceId: request.providerInstanceId,
        endpoint: "http://127.0.0.1:43123/mcp",
        authorizationHeader: "Bearer test",
        browserToolsAvailable: false,
      },
    }),
  resolve: () => Effect.undefined,
  touch: () => Effect.void,
  revokeProviderSession: () => Effect.void,
  revokeThread: () => Effect.void,
  revokeAll: Effect.void,
});
const layer = Layer.merge(registration, KinMcp.registry(fakeRegistry)).pipe(
  Layer.provideMerge(runtime({ KIN_ENABLED: true })),
  Layer.provideMerge(Sqlite.layerMemory),
);
const visible = Effect.gen(function* () {
  const server = yield* McpServer.McpServer;
  return yield* Effect.sync(() =>
    server.tools
      .filter(
        ({ annotations }) =>
          Context.getOrUndefined(annotations, McpSchema.EnabledWhen)?.(client.initializePayload) ===
          true,
      )
      .map(({ tool }) => tool.name),
  );
});
const call = (name: string, args: Record<string, unknown>, caller = scope) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext, caller),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });
const seed = Effect.gen(function* () {
  const kin = yield* Kin.KinServer;
  const services = Option.getOrThrow(kin.services);
  const identity = Context.get(services, KinIdentity);
  const chatService = Context.get(services, KinChatService);
  const [person] = yield* identity.resolve({
    sessionId: AuthSessionId.make("owner"),
    subject: "browser",
    method: "browser-session-cookie",
    scopes: AuthStandardClientScopes,
  });
  assert.isDefined(person);
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at) VALUES (${agentId}, ${person.orgId}, 'Lead', 'lead', ${person.personId}, '1970-01-01T00:00:00.000Z')`;
  assert.deepStrictEqual(
    yield* visible.pipe(Effect.provideService(McpInvocationContext, scope)),
    [],
  );
  yield* identity.registerAgentThread({ orgId: person.orgId, agentId, threadId });
  const chat = yield* chatService.createDirect(person, { orgId: person.orgId, agentId });
  return { identity, chatService, person, chat, sql };
});

it.effect(
  "shares WS identity, stores agent authors, reads roles, and preserves retry identity",
  () =>
    Effect.gen(function* () {
      const { chat, person, chatService, sql } = yield* seed;
      assert.lengthOf(yield* visible.pipe(Effect.provideService(McpInvocationContext, scope)), 3);
      const registry = yield* McpSessions.McpSessionRegistry;
      for (const request of [
        thread,
        { ...thread, threadId: ThreadId.make("ordinary") },
        { ...thread, subagent: true },
      ]) {
        const issued = yield* registry.issue(request);
        assert.strictEqual(
          issued.config.endpoint,
          request === thread ? "http://127.0.0.1:43123/kin/mcp" : "http://127.0.0.1:43123/mcp",
        );
      }
      const input = {
        chatId: chat.chatId,
        body: "Evidence",
        intent: "evidence",
        clientMessageId: "retry",
        author: { _tag: "human", personId: person.personId },
      };
      const first = yield* call("kin_chat_post", input);
      assert.isFalse(first.isError);
      assert.deepStrictEqual(yield* call("kin_chat_post", input), first);
      assert.isTrue((yield* call("kin_chat_post", { ...input, body: "Changed" })).isError);
      const { agent, read } = yield* agentServices.pipe(
        Effect.provideService(McpInvocationContext, scope),
      );
      const rows = yield* read(agent, { chatId: chat.chatId });
      assert.lengthOf(rows, 1);
      const suggestion = yield* chatService.send(person, {
        chatId: chat.chatId,
        body: "Private suggestion",
        clientMessageId: "suggestion",
      });
      yield* sql`UPDATE kin_messages SET status = 'suggested' WHERE message_id = ${suggestion.messageId}`;
      assert.deepStrictEqual(yield* read(agent, { chatId: chat.chatId, limit: 1 }), rows);
      assert.deepStrictEqual(
        yield* read(agent, { chatId: chat.chatId, afterSeq: rows[0]?.seq ?? 0 }),
        [],
      );
      assert.include(rows[0]?.author, {
        _tag: "agent",
        agentId,
        threadId,
        ownerPersonId: person.personId,
      });
      const result = yield* call("kin_chat_read", { chatId: chat.chatId });
      assert.isFalse(result.isError);
      assert.include(JSON.stringify(result), "authorRole");
      assert.isTrue(
        (yield* call("kin_widget_upsert", { chatId: chat.chatId, type: "approval", state: {} }))
          .isError,
      );
      for (const changed of [
        { afterSeq: -1 },
        { afterSeq: 0.5 },
        { afterSeq: Number.MAX_SAFE_INTEGER + 1 },
        { limit: 101 },
      ]) {
        const result = yield* call("kin_chat_read", { chatId: chat.chatId, ...changed }).pipe(
          Effect.result,
        );
        assert.isTrue(result._tag === "Failure" || result.success.isError);
      }
      for (const changed of [
        { body: "bad\u0000body" },
        { clientMessageId: "bad\u0000key" },
        { body: "a".repeat(16001) },
        { mentions: Array.from({ length: 101 }, () => "member") },
      ]) {
        const result = yield* call("kin_chat_post", { ...input, ...changed }).pipe(Effect.result);
        assert.isTrue(result._tag === "Failure" || result.success.isError);
      }
    }).pipe(Effect.provide(layer)),
);

it.effect.each(["ordinary", "subagent", "ended", "retired", "muted"] as const)(
  "refuses %s callers",
  (mode) =>
    Effect.gen(function* () {
      const { chat, identity, person, sql } = yield* seed;
      const caller =
        mode === "ordinary"
          ? { ...scope, thread: { ...thread, threadId: ThreadId.make("ordinary") } }
          : mode === "subagent"
            ? { ...scope, thread: { ...thread, subagent: true } }
            : scope;
      if (mode === "ended") yield* identity.endAgentThread({ orgId: person.orgId, threadId });
      if (mode === "retired")
        yield* sql`UPDATE kin_agents SET retired_at = '1970-01-01T00:00:00.000Z' WHERE agent_id = ${agentId}`;
      if (mode === "muted")
        yield* sql`UPDATE kin_chat_members SET muted_until = '2100-01-01T00:00:00.000Z' WHERE agent_id = ${agentId}`;
      const result = yield* call(
        "kin_chat_post",
        { chatId: chat.chatId, body: "No", intent: "answer" },
        caller,
      ).pipe(Effect.result);
      assert.isTrue(result._tag === "Failure" || result.success.isError);
      if (mode !== "muted") {
        const read = yield* call("kin_chat_read", { chatId: chat.chatId }, caller).pipe(
          Effect.result,
        );
        assert.isTrue(read._tag === "Failure" || read.success.isError);
      }
    }).pipe(Effect.provide(layer)),
);

it.effect("hides foreign chats with the same not_found error", () =>
  Effect.gen(function* () {
    const { sql } = yield* seed;
    yield* sql`INSERT INTO kin_orgs VALUES ('foreign', 'Foreign', '1970-01-01T00:00:00.000Z')`;
    yield* sql`INSERT INTO kin_chats VALUES ('foreign-chat', 'foreign', 'team_group', NULL, NULL, NULL, 0, NULL, '1970-01-01T00:00:00.000Z', NULL)`;
    for (const chatId of ["missing", "foreign-chat"]) {
      const result = yield* call("kin_chat_read", { chatId });
      assert.isTrue(result.isError);
      assert.include(JSON.stringify(result), "Kin record not found.");
      assert.isTrue(
        (yield* call("kin_chat_post", { chatId, body: "No", intent: "answer" })).isError,
      );
    }
  }).pipe(Effect.provide(layer)),
);

it.effect.each([{}, { KIN_ENABLED: false }, { KIN_ENABLED: "maybe" }])(
  "disabled config %j has no tools or authority",
  (config) =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* visible.pipe(Effect.provideService(McpInvocationContext, scope)),
        [],
      );
      assert.include(
        yield* agentServices.pipe(Effect.provideService(McpInvocationContext, scope), Effect.flip),
        { reason: "unavailable" },
      );
    }).pipe(
      Effect.provide(
        registration.pipe(Layer.provideMerge(runtime(config)), Layer.provide(Sqlite.layerMemory)),
      ),
    ),
);

it.effect("keeps trusted persistence, waiting and hub APIs outside the toolkit", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const source = yield* fs.readFileString(
      new URL("./KinChatToolkit.ts", import.meta.url).pathname,
    );
    assert.notMatch(source, /import[^;]*(?:KinChatRepository|KinChatHub)/);
    assert.notMatch(source, /\.addWaiting\(|\.subscribeForViewer\(/);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("admits only active provider agents at /kin/mcp", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { identity, person } = yield* seed;
      const kin = yield* Kin.KinServer;
      const providerScope = { ...scope, thread };
      const authRegistry = Layer.mock(McpSessions.McpSessionRegistry)({
        resolve: (token) =>
          Effect.succeed(
            token === "agent"
              ? providerScope
              : token === "ordinary"
                ? { ...providerScope, thread: { ...thread, threadId: ThreadId.make("ordinary") } }
                : undefined,
          ),
      });
      const http = yield* HttpRouter.toHttpEffect(
        KinMcp.endpoint(McpHttpServer.toolkitRegistration(KinChatToolkit, handlers)).pipe(
          Layer.provide(Layer.succeed(Kin.KinServer, kin)),
          Layer.provide(authRegistry),
          Layer.provide(ServerSettings.layerTest()),
        ),
      );
      const request = (token: string) =>
        http.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              new Request("http://localhost/kin/mcp", {
                method: "POST",
                headers: {
                  authorization: `Bearer ${token}`,
                  "content-type": "application/json",
                  accept: "application/json, text/event-stream",
                },
                body: JSON.stringify({
                  jsonrpc: "2.0",
                  id: 1,
                  method: "initialize",
                  params: client.initializePayload,
                }),
              }),
            ),
          ),
        );
      assert.strictEqual((yield* request("missing")).status, 401);
      assert.strictEqual((yield* request("ordinary")).status, 403);
      assert.strictEqual((yield* request("agent")).status, 200);
      yield* identity.endAgentThread({ orgId: person.orgId, threadId });
      assert.strictEqual((yield* request("agent")).status, 403);
    }),
  ).pipe(Effect.provide(layer)),
);
