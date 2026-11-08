import { environment } from "../chat/TaskCard.testkit.ts";
import { authorityLayer, startAgentWakeup } from "../chat/WakeupAuthority.testkit.ts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as TestClock from "effect/testing/TestClock";
import { FLOOR_GRANT_TTL_MS } from "../floor/FloorManager.ts";
import * as FileSystem from "effect/FileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthStandardClientScopes,
  EnvironmentId,
  KinAgentId,
  KinMessageId,
  KinMemberId,
  KinOrgId,
  KinPersonId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import { McpSchema, McpServer } from "effect/ai";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
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
  Kin.layer.pipe(
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))),
    Layer.provideMerge(environment),
  );
const registration = McpHttpServer.toolkitRegistration(KinChatToolkit, handlers).pipe(
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
);
const fakeRegistry = Layer.sync(McpSessions.McpSessionRegistry, () => {
  const credentials = new Map<string, typeof scope & { thread: typeof thread }>();
  return McpSessions.McpSessionRegistry.of({
    issue: (request) =>
      Effect.sync(() => {
        const token = `test-${credentials.size}`;
        credentials.set(token, {
          ...scope,
          thread: { ...thread, ...request, providerSessionId: token },
        });
        return {
          config: {
            environmentId: scope.environmentId,
            threadId: request.threadId,
            providerSessionId: token,
            providerInstanceId: request.providerInstanceId,
            endpoint: "http://127.0.0.1:43123/mcp",
            authorizationHeader: `Bearer ${token}`,
            browserToolsAvailable: false,
          },
        };
      }),
    resolve: (token) => Effect.sync(() => credentials.get(token)),
    touch: () => Effect.void,
    revokeProviderSession: () => Effect.void,
    revokeThread: () => Effect.void,
    revokeAll: Effect.void,
  });
});
const liveThreads = Layer.mock(ThreadManagement.ThreadManagementService)({
  getThreadShell: (id) =>
    Effect.succeed({ ...liveThreadShell(id), providerInstanceId: thread.providerInstanceId }),
});
const layer = Layer.merge(registration, KinMcp.registry(fakeRegistry)).pipe(
  Layer.provideMerge(runtime({ KIN_ENABLED: true })),
  Layer.provideMerge(authorityLayer),
  Layer.provideMerge(liveThreads),
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
const errorOf = (result: McpSchema.CallToolResult) => {
  assert.isTrue(result.isError);
  const text = result.content.find((item) => item.type === "text")?.text;
  assert.isDefined(text);
  const error: unknown = JSON.parse(text);
  return error;
};
const seed = Effect.fn("test.seed")(function* (notice = false) {
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
  yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id)
    VALUES (${agentId}, ${person.orgId}, 'Lead', 0, '{}', '[]', ${chat.chatId})`;
  const prompt = notice
    ? undefined
    : yield* chatService.send(person, {
        chatId: chat.chatId,
        body: "Owner question",
        clientMessageId: "seed-human",
      });
  yield* startAgentWakeup({
    orgId: person.orgId,
    agentId,
    threadId,
    ...(prompt === undefined ? {} : { message: prompt }),
  });
  return { identity, chatService, person, chat, sql };
});

it.effect(
  "shares WS identity, stores agent authors, reads roles, and preserves retry identity",
  () =>
    Effect.gen(function* () {
      const { chat, person, chatService, sql } = yield* seed();
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
      assert.include(errorOf(yield* call("kin_chat_post", { ...input, body: "Changed" })), {
        reason: "not_allowed",
      });
      const { agent, read } = yield* agentServices.pipe(
        Effect.provideService(McpInvocationContext, scope),
      );
      const rows = yield* read(agent, { chatId: chat.chatId });
      assert.lengthOf(rows, 2);
      const suggestion = yield* chatService.send(person, {
        chatId: chat.chatId,
        body: "Private suggestion",
        clientMessageId: "suggestion",
      });
      yield* sql`UPDATE kin_messages SET status = 'suggested' WHERE message_id = ${suggestion.messageId}`;
      assert.deepStrictEqual(yield* read(agent, { chatId: chat.chatId, limit: 2 }), rows);
      assert.deepStrictEqual(
        yield* read(agent, { chatId: chat.chatId, afterSeq: rows.at(-1)?.seq ?? 0 }),
        [],
      );
      assert.include(rows[1]?.author, {
        _tag: "agent",
        agentId,
        threadId,
        ownerPersonId: person.personId,
      });
      const result = yield* call("kin_chat_read", { chatId: chat.chatId });
      assert.isFalse(result.isError);
      assert.include(JSON.stringify(result), "authorRole");
      const refused = yield* call("kin_widget_upsert", {
        chatId: chat.chatId,
        type: "approval",
        state: {},
      }).pipe(Effect.result);
      assert.strictEqual(refused._tag, "Failure");
      const create = yield* call("kin_widget_upsert", {
        chatId: chat.chatId,
        type: "task",
        state: taskState,
      }).pipe(Effect.result);
      assert.strictEqual(create._tag, "Failure");
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
      const { chat, identity, person, sql } = yield* seed();
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
      assert.include(
        yield* agentServices.pipe(
          Effect.provideService(McpInvocationContext, caller),
          Effect.result,
        ),
        mode === "muted" ? { _tag: "Success" } : { _tag: "Failure" },
      );
      if (mode === "ordinary" || mode === "subagent" || mode === "ended") {
        assert.include(
          yield* agentServices.pipe(
            Effect.provideService(McpInvocationContext, caller),
            Effect.flip,
          ),
          { reason: "not_allowed" },
        );
        assert.strictEqual(result._tag, "Failure");
        if (result._tag === "Failure") assert.include(result.failure, { _tag: "InvalidParams" });
      } else {
        assert.strictEqual(result._tag, "Success");
        if (result._tag === "Success")
          assert.include(errorOf(result.success), { reason: "not_allowed" });
      }
      if (mode !== "muted") {
        const read = yield* call("kin_chat_read", { chatId: chat.chatId }, caller).pipe(
          Effect.result,
        );
        if (mode === "retired") {
          assert.strictEqual(read._tag, "Success");
          if (read._tag === "Success")
            assert.include(errorOf(read.success), { reason: "not_allowed" });
        } else {
          assert.strictEqual(read._tag, "Failure");
          if (read._tag === "Failure") assert.include(read.failure, { _tag: "InvalidParams" });
        }
      }
    }).pipe(Effect.provide(layer)),
);

it.effect("hides foreign chats with the same not_found error", () =>
  Effect.gen(function* () {
    const { sql } = yield* seed();
    yield* sql`INSERT INTO kin_orgs VALUES ('foreign', 'Foreign', '1970-01-01T00:00:00.000Z')`;
    yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, title, team_id, direct_key, last_seq, last_message_at, created_at, archived_at) VALUES ('foreign-chat', 'foreign', 'team_group', NULL, NULL, NULL, 0, NULL, '1970-01-01T00:00:00.000Z', NULL)`;
    for (const chatId of ["missing", "foreign-chat"]) {
      const result = yield* call("kin_chat_read", { chatId });
      assert.include(errorOf(result), { reason: "not_found" });
      assert.include(
        errorOf(yield* call("kin_chat_post", { chatId, body: "No", intent: "answer" })),
        { reason: "not_found" },
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
        registration.pipe(
          Layer.provideMerge(runtime(config)),
          Layer.provide(Sqlite.layerMemory),
          Layer.provide(liveThreads),
        ),
      ),
    ),
);

it.effect("admits only active provider agents at /kin/mcp", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { identity, person, sql } = yield* seed();
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
      yield* sql`UPDATE kin_wakeups SET status = 'completed' WHERE org_id = ${person.orgId} AND thread_id = ${threadId}`;
      assert.strictEqual((yield* request("agent")).status, 403);
      yield* sql`UPDATE kin_wakeups SET status = 'running' WHERE org_id = ${person.orgId} AND thread_id = ${threadId}`;
      assert.strictEqual((yield* request("agent")).status, 200);
      yield* identity.endAgentThread({ orgId: person.orgId, threadId });
      assert.strictEqual((yield* request("agent")).status, 403);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("invalidates credentials when registration changes their endpoint", () =>
  Effect.gen(function* () {
    const registry = yield* McpSessions.McpSessionRegistry;
    const ordinary = yield* registry.issue(thread);
    const resolve = (issued: typeof ordinary) =>
      registry.resolve(issued.config.authorizationHeader.slice(7));
    assert.isDefined(yield* resolve(ordinary));
    const { identity, person } = yield* seed();
    assert.isUndefined(yield* resolve(ordinary));
    const agent = yield* registry.issue(thread);
    assert.strictEqual(agent.config.endpoint, "http://127.0.0.1:43123/kin/mcp");
    assert.isDefined(yield* resolve(agent));
    yield* identity.endAgentThread({ orgId: person.orgId, threadId });
    assert.isUndefined(yield* resolve(agent));
    const ended = yield* registry.issue(thread);
    assert.strictEqual(ended.config.endpoint, ordinary.config.endpoint);
    assert.isDefined(yield* resolve(ended));
  }).pipe(Effect.provide(layer)),
);

it.effect.each(["deleted", "archived"] as const)("refuses writes from %s threads", (mode) =>
  Effect.gen(function* () {
    const { chat } = yield* seed();
    for (const [name, input] of [
      ["kin_chat_post", { chatId: chat.chatId, body: "No", intent: "answer" }],
      [
        "kin_widget_upsert",
        { chatId: chat.chatId, widgetId: "widget-1", revision: 1, type: "task", state: taskState },
      ],
    ] as const) {
      const result = yield* call(name, input).pipe(
        Effect.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (id) =>
              Effect.succeed({
                ...liveThreadShell(id),
                providerInstanceId: thread.providerInstanceId,
                ...(mode === "deleted"
                  ? { deletedAt: liveThreadShell(id).updatedAt }
                  : { archivedAt: liveThreadShell(id).updatedAt }),
              }),
          }),
        ),
      );
      assert.isTrue(result.isError);
      assert.include(errorOf(result), {
        code: mode === "deleted" ? "thread_not_found" : "parent_not_active",
      });
    }
  }).pipe(Effect.provide(layer)),
);

const taskState = {
  taskId: "task",
  environmentId: "environment",
  threadId: ThreadId.make("worker"),
  remoteEnvironmentId: null,
  title: "Work",
  model: null,
  status: "working",
  pullRequests: [],
  lastError: null,
  updatedAt: "1970-01-01T00:00:00.000Z",
};

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

type FloorPost = Omit<Parameters<KinChatService["Service"]["send"]>[1], "clientMessageId"> & {
  readonly clientMessageId?: string;
};
const sendFloor = Effect.fn("test.sendFloor")(function* (input: FloorPost) {
  const { agent, send } = yield* agentServices.pipe(
    Effect.provideService(McpInvocationContext, scope),
  );
  return yield* send(agent, {
    ...input,
    clientMessageId: input.clientMessageId ?? SecureRandom.uuidV4Unsafe(),
  }).pipe(Effect.result);
});
const failureOf = <A, E>(result: Result.Result<A, E>) => Result.getOrThrow(Result.flip(result));

it.effect(
  "enforces implicit direct grants atomically, keeps retries, and permits wake-up notices outside runs",
  () =>
    Effect.gen(function* () {
      const { chat, person, chatService, sql } = yield* seed();
      const { agent } = yield* agentServices.pipe(
        Effect.provideService(McpInvocationContext, scope),
      );
      yield* sql`DELETE FROM kin_floor_grants WHERE org_id = ${person.orgId}`;
      yield* sql`DELETE FROM kin_floor_runs WHERE org_id = ${person.orgId}`;
      const post = {
        chatId: chat.chatId,
        body: "Answer",
        intent: "answer",
        clientMessageId: "floor-reply",
      } as const;
      assert.include(failureOf(yield* sendFloor(post)), { reason: "floor_not_granted" });
      const prompt = { chatId: chat.chatId, body: "Please answer", clientMessageId: "floor-human" };
      const human = yield* chatService.send(person, prompt);
      const [grant] = yield* sql<{
        token: string;
        run_id: string;
      }>`SELECT token, run_id FROM kin_floor_grants WHERE org_id = ${person.orgId} AND chat_id = ${chat.chatId} ORDER BY token`;
      assert.isDefined(grant);
      assert.include(failureOf(yield* sendFloor({ ...post, floorGrant: "forged" })), {
        reason: "floor_not_granted",
      });
      assert.include(
        failureOf(yield* sendFloor({ ...post, replyTo: KinMessageId.make("foreign-message") })),
        {
          reason: "not_found",
          message: "Kin record not found.",
        },
      );
      for (const corrupt of [
        { mention_queue: "not-json" },
        { mention_queue: '[" "]' },
        { last_speaker: " " },
      ]) {
        const [before] = yield* sql<{
          mention_queue: string;
        }>`SELECT mention_queue FROM kin_floor_runs WHERE run_id = ${grant.run_id}`;
        yield* sql`UPDATE kin_floor_runs SET ${sql.update(corrupt)} WHERE run_id = ${grant.run_id}`;
        assert.strictEqual(failureOf(yield* sendFloor(post))._tag, "PersistenceSqlError");
        yield* sql`UPDATE kin_floor_runs SET mention_queue = ${before!.mention_queue}, last_speaker = NULL WHERE run_id = ${grant.run_id}`;
      }
      yield* sql`UPDATE kin_floor_runs SET agent_turns = 1, last_speaker = 'other' WHERE run_id = ${grant.run_id}`;
      assert.include(failureOf(yield* sendFloor(post)), { reason: "invalid_state" });
      yield* sql`UPDATE kin_floor_runs SET agent_turns = 0, last_speaker = NULL WHERE run_id = ${grant.run_id}`;
      const first = yield* sendFloor(post);
      assert.isTrue(Result.isSuccess(first));
      assert.deepStrictEqual(yield* sendFloor(post), first);
      assert.include(failureOf(yield* sendFloor({ ...post, body: "Changed" })), {
        reason: "not_allowed",
      });
      assert.deepStrictEqual(yield* chatService.send(person, prompt), human);
      for (const intent of ["answer", "evidence", "question"] as const) {
        assert.include(
          failureOf(
            yield* sendFloor({
              ...post,
              intent,
              clientMessageId: `second-${intent}`,
              floorGrant: grant.token,
            }),
          ),
          { reason: intent === "evidence" ? "floor_not_granted" : "invalid_state" },
        );
      }
      const { read } = yield* agentServices.pipe(
        Effect.provideService(McpInvocationContext, scope),
      );
      assert.strictEqual(
        (yield* read(agent, { chatId: chat.chatId })).at(-1)?.floorRunId,
        grant.run_id,
      );
      yield* startAgentWakeup({ orgId: person.orgId, agentId, threadId });
      for (const invalid of [
        { intent: "answer" as const },
        { intent: "objection" as const },
        { intent: "evidence" as const, floorGrant: grant.token },
      ]) {
        assert.include(
          failureOf(
            yield* sendFloor({
              ...post,
              ...invalid,
              clientMessageId: `invalid-notice-${invalid.intent}`,
            }),
          ),
          { reason: "invalid_state" },
        );
      }
      assert.isFalse(
        (yield* sendFloor({
          ...post,
          body: "Routine evidence",
          intent: "evidence",
          clientMessageId: "notice",
        }))._tag === "Failure",
      );
      assert.isNull((yield* read(agent, { chatId: chat.chatId })).at(-1)?.floorRunId);
      assert.deepStrictEqual(
        yield* sql`SELECT agent_turns FROM kin_floor_runs WHERE org_id = ${person.orgId} AND run_id = ${grant.run_id} ORDER BY run_id`,
        [{ agent_turns: 1 }],
      );
      const concurrentHuman = yield* chatService.send(person, {
        ...prompt,
        clientMessageId: "concurrent-human",
      });
      yield* startAgentWakeup({ orgId: person.orgId, agentId, threadId, message: concurrentHuman });
      const concurrent = yield* Effect.forEach(
        ["a", "b"],
        (key) =>
          sendFloor({
            ...post,
            clientMessageId: `concurrent-${key}`,
            intent: "evidence",
          }),
        { concurrency: "unbounded" },
      );
      assert.strictEqual(concurrent.filter((result) => Result.isSuccess(result)).length, 1);
      assert.include(failureOf(concurrent.find((result) => Result.isFailure(result))!), {
        reason: "floor_not_granted",
      });
      yield* startAgentWakeup({ orgId: person.orgId, agentId, threadId });
      assert.include(failureOf(yield* sendFloor({ ...post, clientMessageId: "notice-answer" })), {
        reason: "invalid_state",
      });
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "expires and releases grants on time and new human messages, and scopes tokens to chat, org and agent",
  () =>
    Effect.gen(function* () {
      const { chat, person, chatService, sql } = yield* seed();
      yield* sql`DELETE FROM kin_floor_grants WHERE org_id = ${person.orgId}`;
      yield* sql`DELETE FROM kin_floor_runs WHERE org_id = ${person.orgId}`;
      const human = (id: string) =>
        chatService.send(person, { chatId: chat.chatId, body: "Question", clientMessageId: id });
      yield* human("human-1");
      const [grant] = yield* sql<{
        token: string;
        run_id: string;
      }>`SELECT token, run_id FROM kin_floor_grants WHERE org_id = ${person.orgId} AND chat_id = ${chat.chatId} ORDER BY token`;
      assert.isDefined(grant);
      const post = {
        chatId: chat.chatId,
        body: "Answer",
        intent: "answer",
        floorGrant: grant.token,
      } as const;
      yield* TestClock.adjust(FLOOR_GRANT_TTL_MS);
      assert.include(failureOf(yield* sendFloor(post)), { reason: "floor_not_granted" });
      yield* human("human-2");
      assert.include(failureOf(yield* sendFloor(post)), { reason: "floor_not_granted" });
      const [fresh] = yield* sql<{
        token: string;
        run_id: string;
      }>`SELECT token, run_id FROM kin_floor_grants WHERE org_id = ${person.orgId} AND run_id != ${grant.run_id} ORDER BY token`;
      assert.isDefined(fresh);
      // Corrupt-scope rows simulate otherwise valid server tokens belonging to another principal.
      const otherAgent = KinAgentId.make("other-agent");
      yield* sql`INSERT INTO kin_agents (org_id, agent_id, display_name, role, owner_person_id, created_at)
      VALUES (${person.orgId}, ${otherAgent}, 'Other', 'qa', ${person.personId}, '1970-01-01T00:00:00.000Z')`;
      const other = yield* chatService.createDirect(person, {
        orgId: person.orgId,
        agentId: otherAgent,
      });
      for (const change of ["agent", "chat"] as const) {
        yield* sql`UPDATE kin_floor_grants SET agent_id = ${change === "agent" ? otherAgent : agentId}, chat_id = ${change === "chat" ? other.chatId : chat.chatId}
        WHERE org_id = ${person.orgId} AND token = ${fresh.token}`;
        assert.include(failureOf(yield* sendFloor({ ...post, floorGrant: fresh.token })), {
          reason: "floor_not_granted",
        });
      }
      yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES ('foreign-org', 'Foreign', '1970-01-01T00:00:00.000Z')`;
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
      VALUES ('foreign-person', 'foreign-org', 'foreign', 'Foreign', '1970-01-01T00:00:00.000Z')`;
      yield* sql`INSERT INTO kin_agents (org_id, agent_id, display_name, role, owner_person_id, created_at)
      VALUES ('foreign-org', 'foreign-agent', 'Foreign', 'lead', 'foreign-person', '1970-01-01T00:00:00.000Z')`;
      const foreignPerson = {
        _tag: "person",
        orgId: KinOrgId.make("foreign-org"),
        personId: KinPersonId.make("foreign-person"),
      } as const;
      const foreignChat = yield* chatService.createDirect(foreignPerson, {
        orgId: foreignPerson.orgId,
        agentId: KinAgentId.make("foreign-agent"),
      });
      yield* chatService.send(foreignPerson, {
        chatId: foreignChat.chatId,
        body: "Foreign question",
        clientMessageId: "foreign-human",
      });
      const [foreignGrant] = yield* sql<{
        token: string;
      }>`SELECT token FROM kin_floor_grants WHERE org_id = ${foreignPerson.orgId} ORDER BY token`;
      assert.isDefined(foreignGrant);
      assert.include(failureOf(yield* sendFloor({ ...post, floorGrant: foreignGrant.token })), {
        reason: "floor_not_granted",
      });
      assert.include(
        failureOf(
          yield* sendFloor({
            ...post,
            chatId: foreignChat.chatId,
            floorGrant: foreignGrant.token,
          }),
        ),
        { reason: "not_found", message: "Kin record not found." },
      );
      yield* sql`UPDATE kin_floor_grants SET agent_id = ${agentId}, chat_id = ${chat.chatId} WHERE org_id = ${person.orgId} AND token = ${fresh.token}`;
      assert.isFalse((yield* sendFloor({ ...post, floorGrant: fresh.token }))._tag === "Failure");
      yield* human("human-3");
      assert.include(failureOf(yield* sendFloor({ ...post, floorGrant: fresh.token })), {
        reason: "floor_not_granted",
      });
      assert.isFalse(
        (yield* sendFloor({
          chatId: post.chatId,
          body: post.body,
          intent: post.intent,
        }))._tag === "Failure",
      );
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "limits agent notices to ten per rolling hour without charging retries or server notices",
  () =>
    Effect.gen(function* () {
      const { chat, person, chatService, sql } = yield* seed(true);
      const post = {
        chatId: chat.chatId,
        body: "Notice",
        intent: "evidence",
        clientMessageId: "notice-0",
      } as const;
      const first = yield* sendFloor(post);
      assert.isTrue(Result.isSuccess(first));
      for (let n = 1; n < 10; n++)
        assert.isFalse(
          (yield* sendFloor({ ...post, clientMessageId: `notice-${n}` }))._tag === "Failure",
        );
      assert.deepStrictEqual(yield* sendFloor(post), first);
      assert.include(failureOf(yield* sendFloor({ ...post, clientMessageId: "limited" })), {
        reason: "limit",
      });
      yield* chatService.notice({
        orgId: person.orgId,
        chatId: chat.chatId,
        messageId: KinMessageId.make("server-notice"),
        body: "Server notice",
      });
      assert.deepStrictEqual(
        yield* sql`SELECT COUNT(*) AS count FROM kin_floor_notices WHERE org_id = ${person.orgId} AND chat_id = ${chat.chatId} ORDER BY message_id`,
        [{ count: 10 }],
      );
      yield* TestClock.adjust(3_600_000);
      assert.isFalse(
        (yield* sendFloor({ ...post, clientMessageId: "new-hour" }))._tag === "Failure",
      );
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "requires explicit group grants and keeps the six-turn door closed until a human speaks",
  () =>
    Effect.gen(function* () {
      const { chat, person, chatService, sql } = yield* seed();
      yield* sql`DELETE FROM kin_floor_grants WHERE org_id = ${person.orgId}`;
      yield* sql`DELETE FROM kin_floor_runs WHERE org_id = ${person.orgId}`;
      yield* sql`UPDATE kin_chats SET kind = 'team_group', direct_key = NULL WHERE org_id = ${person.orgId} AND chat_id = ${chat.chatId}`;
      const [member] = yield* sql<{
        member_id: string;
      }>`SELECT member_id FROM kin_chat_members WHERE org_id = ${person.orgId} AND chat_id = ${chat.chatId} AND agent_id = ${agentId} ORDER BY member_id`;
      assert.isDefined(member);
      yield* sql`INSERT INTO kin_agents (org_id, agent_id, display_name, role, owner_person_id, created_at)
        VALUES (${person.orgId}, 'queued-qa', 'QA', 'qa', ${person.personId}, '1970-01-01T00:00:00.000Z')`;
      yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, agent_id, role, joined_at)
        VALUES ('queued-qa-member', ${person.orgId}, ${chat.chatId}, 'agent', 'queued-qa', 'member', '1970-01-01T00:00:00.000Z')`;
      yield* chatService.send(person, {
        chatId: chat.chatId,
        body: "Please answer",
        mentions: [KinMemberId.make(member.member_id), KinMemberId.make("queued-qa-member")],
        clientMessageId: "group-human",
      });
      const [grant] = yield* sql<{
        token: string;
        run_id: string;
      }>`SELECT token, run_id FROM kin_floor_grants WHERE org_id = ${person.orgId} AND chat_id = ${chat.chatId} ORDER BY token`;
      assert.isDefined(grant);
      const post = {
        chatId: chat.chatId,
        body: "Answer",
        intent: "answer",
        clientMessageId: "group-answer",
      } as const;
      assert.include(failureOf(yield* sendFloor(post)), { reason: "floor_not_granted" });
      assert.include(errorOf(yield* call("kin_chat_post", { ...post, floorGrant: grant.token })), {
        reason: "floor_not_granted",
      });
      const first = yield* sendFloor({ ...post, floorGrant: grant.token });
      assert.isTrue(Result.isSuccess(first));
      assert.deepStrictEqual(
        yield* sql`SELECT agent_id FROM kin_floor_grants
        WHERE org_id = ${person.orgId} AND run_id = ${grant.run_id} AND consumed_at IS NULL ORDER BY token`,
        [{ agent_id: "queued-qa" }],
      );
      assert.deepStrictEqual(yield* sendFloor({ ...post, floorGrant: grant.token }), first);
      assert.include(
        failureOf(
          yield* sendFloor({
            ...post,
            clientMessageId: "reuse",
            intent: "evidence",
            floorGrant: grant.token,
          }),
        ),
        { reason: "floor_not_granted" },
      );
      yield* sql`UPDATE kin_floor_runs SET agent_turns = 6, state = 'closed' WHERE org_id = ${person.orgId} AND run_id = ${grant.run_id}`;
      assert.include(
        failureOf(
          yield* sendFloor({
            ...post,
            clientMessageId: "closed",
            floorGrant: grant.token,
          }),
        ),
        { reason: "floor_closed" },
      );
      yield* chatService.send(person, {
        chatId: chat.chatId,
        body: "New question",
        mentions: [KinMemberId.make(member.member_id)],
        clientMessageId: "new-group-human",
      });
      const [fresh] = yield* sql<{
        token: string;
      }>`SELECT token FROM kin_floor_grants WHERE org_id = ${person.orgId} AND run_id != ${grant.run_id} ORDER BY token`;
      assert.isDefined(fresh);
      assert.isFalse(
        (yield* sendFloor({
          ...post,
          clientMessageId: "new-group-answer",
          floorGrant: fresh.token,
        }))._tag === "Failure",
      );
    }).pipe(Effect.provide(layer)),
);
