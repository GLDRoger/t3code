import { pairSession } from "../auth/ProofKeySessions.testkit.ts";
import { kinSecretsTest } from "../lead/layer.testkit.ts";
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
  KIN_REACTION_EMOJI,
  KinAgentId,
  KinChatId,
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
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import { McpSchema, McpServer } from "effect/ai";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as McpSessions from "../../mcp/McpSessionRegistry.ts";
import * as KinMcp from "./layer.ts";
import { KinLeadToolkit } from "../lead/mcp/tools.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import { McpInvocationContext, type McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import { HttpRouter, HttpServerRequest } from "effect/http";
import * as ServerSettings from "../../serverSettings.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Kin from "../layer.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import { KinGroups } from "../chat/KinGroups.ts";
import {
  AUDIENCE_MOVED,
  PRIVATE_DESTINATION,
  SHARED_ELSEWHERE,
  SHARED_OTHER_CHAT,
  SHARED_REFUSAL,
} from "../lead/Audience.ts";
import * as KinToolGate from "./KinToolGate.ts";
import { toolAdmitted } from "../lead/SharedTools.ts";
import { KinLevelGate } from "../lead/LevelGate.ts";
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
    Layer.provide(kinSecretsTest),
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
/** The same toolkit behind the Kin endpoint's gate, which every tool call passes first. */
const gatedLayer = Layer.mergeAll(
  registration,
  KinToolGate.layer.pipe(Layer.provide(McpHttpServer.layerInProcessMcpServer)),
  KinMcp.registry(fakeRegistry),
).pipe(
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
// L1 by default: these tests post for real. An L0 lead posts only where its owner placed it.
const seed = Effect.fn("test.seed")(function* (notice = false, level = "L1") {
  const kin = yield* Kin.KinServer;
  const services = Option.getOrThrow(kin.services);
  const identity = Context.get(services, KinIdentity);
  const chatService = Context.get(services, KinChatService);
  yield* pairSession(AuthSessionId.make("owner"));
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
  yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level, level_since, models_json, worker_projects_json, owner_chat_id)
    VALUES (${agentId}, ${person.orgId}, 'Lead', ${level}, 0, '{}', '[]', ${chat.chatId})`;
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

it.effect(
  "a teammate joining mid-turn withholds the owner-only reply, and a shared turn reads only its own chat",
  () =>
    Effect.gen(function* () {
      const { chat: direct, person, chatService, sql } = yield* seed();
      const at = "1970-01-01T00:00:00.000Z";
      yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at)
        VALUES ('room', ${person.orgId}, 'team_group', 0, ${at})`;
      yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
        VALUES ('room-owner', ${person.orgId}, 'room', 'person', ${person.personId}, 'owner', ${at})`;
      yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, agent_id, role, joined_at)
        VALUES ('room-lead', ${person.orgId}, 'room', 'agent', ${agentId}, 'member', ${at})`;
      const asked = yield* chatService.send(person, {
        chatId: KinChatId.make("room"),
        body: "Owner question in the group",
        clientMessageId: "room-question",
      });
      yield* startAgentWakeup({ orgId: person.orgId, agentId, threadId, message: asked });
      // The owner alone reads the group: the lead reads its other chats too.
      assert.isFalse((yield* call("kin_chat_read", { chatId: direct.chatId })).isError);
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
        VALUES ('teammate', ${person.orgId}, 'teammate', 'Teammate', ${at})`;
      yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
        VALUES ('room-teammate', ${person.orgId}, 'room', 'person', 'teammate', 'member', ${at})`;
      assert.include(errorOf(yield* call("kin_chat_read", { chatId: direct.chatId })), {
        reason: "not_allowed",
        message: SHARED_OTHER_CHAT,
      });
      assert.isFalse((yield* call("kin_chat_read", { chatId: "room" })).isError);
      // Built for the owner alone, it now says nothing where it was asked, nor anywhere else.
      for (const [chatId, message] of [
        ["room", AUDIENCE_MOVED],
        [direct.chatId, SHARED_ELSEWHERE],
      ] as const)
        assert.include(
          errorOf(
            yield* call("kin_chat_post", {
              chatId,
              body: "Built for the owner alone",
              intent: "evidence",
            }),
          ),
          { reason: "not_allowed", message },
        );
      // Shared once, shared until it ends: the teammate leaving opens nothing back up.
      yield* sql`UPDATE kin_chat_members SET left_at = ${at} WHERE member_id = 'room-teammate'`;
      assert.include(errorOf(yield* call("kin_chat_read", { chatId: direct.chatId })), {
        reason: "not_allowed",
        message: SHARED_OTHER_CHAT,
      });
    }).pipe(Effect.provide(layer)),
);

// Review of 0a2a431b26: an owner-only routine turn could post a notice into a group a teammate
// reads, with whatever the owner's context put in it.
it.effect("an owner-only turn posts nothing where a teammate reads, and the owner hears once", () =>
  Effect.gen(function* () {
    const { chat: direct, person, sql } = yield* seed(true);
    const at = "1970-01-01T00:00:00.000Z";
    yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
      VALUES ('teammate', ${person.orgId}, 'teammate', 'Teammate', ${at})`;
    yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, title, last_seq, created_at)
      VALUES ('room', ${person.orgId}, 'team_group', 'Launch', 0, ${at})`;
    for (const [member, kind, principal, role] of [
      ["room-owner", "person", person.personId, "owner"],
      ["room-teammate", "person", "teammate", "member"],
      ["room-lead", "agent", agentId, "member"],
    ] as const)
      yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, agent_id, role, joined_at)
        VALUES (${member}, ${person.orgId}, 'room', ${kind}, ${kind === "person" ? principal : null},
          ${kind === "agent" ? principal : null}, ${role}, ${at})`;
    for (const clientMessageId of ["routine-1", "routine-2"])
      assert.include(
        errorOf(
          yield* call("kin_chat_post", {
            chatId: "room",
            body: "Invented private brief",
            intent: "evidence",
            clientMessageId,
          }),
        ),
        { reason: "not_allowed", message: PRIVATE_DESTINATION },
      );
    assert.deepStrictEqual(
      yield* sql`SELECT body FROM kin_messages WHERE chat_id = 'room' ORDER BY seq`,
      [],
    );
    assert.deepStrictEqual(
      yield* sql`SELECT body FROM kin_messages WHERE chat_id = ${direct.chatId}
        AND author_kind = 'system' ORDER BY seq`,
      [{ body: "Lead couldn't post in Launch: other people are in it." }],
    );
    // Its own direct chat with the owner still gets the post.
    assert.isFalse(
      (yield* call("kin_chat_post", {
        chatId: direct.chatId,
        body: "Invented brief",
        intent: "evidence",
      })).isError,
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("every tool call passes the gate, which holds a turn a teammate reads to its list", () =>
  Effect.gen(function* () {
    const { chat: direct, person, chatService, sql } = yield* seed();
    const kin = yield* Kin.KinServer;
    const at = "1970-01-01T00:00:00.000Z";
    yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
      VALUES ('teammate', ${person.orgId}, 'teammate', 'Teammate', ${at})`;
    yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at)
      VALUES ('room', ${person.orgId}, 'team_group', 0, ${at})`;
    for (const [member, kind, principal, role] of [
      ["room-owner", "person", person.personId, "owner"],
      ["room-teammate", "person", "teammate", "member"],
      ["room-lead", "agent", agentId, "member"],
    ] as const)
      yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, agent_id, role, joined_at)
        VALUES (${member}, ${person.orgId}, 'room', ${kind}, ${kind === "person" ? principal : null},
          ${kind === "agent" ? principal : null}, ${role}, ${at})`;
    const gated = (name: string, args: Record<string, unknown>) =>
      call(name, args).pipe(Effect.provideService(Kin.KinServer, kin));
    // The owner alone reads its direct chat: everything passes.
    assert.isFalse((yield* gated("kin_chat_read", { chatId: "room" })).isError);
    const asked = yield* chatService.send(person, {
      chatId: KinChatId.make("room"),
      body: "Owner question with a teammate listening",
      clientMessageId: "room-ask",
    });
    yield* startAgentWakeup({ orgId: person.orgId, agentId, threadId, message: asked });
    assert.isFalse((yield* gated("kin_chat_read", { chatId: "room" })).isError);
    for (const [name, args] of [
      ["kin_chat_read", { chatId: direct.chatId }],
      ["kin_chat_post", { chatId: direct.chatId, body: "Invented", intent: "evidence" }],
    ] as const)
      assert.strictEqual((yield* gated(name, args).pipe(Effect.flip)).message, SHARED_REFUSAL);
    assert.deepStrictEqual(
      yield* sql`SELECT body FROM kin_messages WHERE chat_id = ${direct.chatId}
        AND author_kind = 'agent' ORDER BY seq`,
      [],
    );
  }).pipe(Effect.provide(gatedLayer)),
);

// A turn built with the owner's notes in mind can't go on once a teammate can read its chat.
it.effect("a teammate joining aborts the owner-only turn, and leaving reopens nothing", () =>
  Effect.gen(function* () {
    const { person, chatService, sql } = yield* seed();
    const kin = yield* Kin.KinServer;
    const groups = Context.get(Option.getOrThrow(kin.services), KinGroups);
    const at = "1970-01-01T00:00:00.000Z";
    yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
      VALUES ('teammate', ${person.orgId}, 'teammate', 'Teammate', ${at})`;
    yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, title, last_seq, created_at)
      VALUES ('room', ${person.orgId}, 'team_group', 'Launch', 0, ${at})`;
    for (const [member, kind, principal, role] of [
      ["room-owner", "person", person.personId, "owner"],
      ["room-lead", "agent", agentId, "member"],
    ] as const)
      yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, agent_id, role, joined_at)
        VALUES (${member}, ${person.orgId}, 'room', ${kind}, ${kind === "person" ? principal : null},
          ${kind === "agent" ? principal : null}, ${role}, ${at})`;
    const asked = yield* chatService.send(person, {
      chatId: KinChatId.make("room"),
      body: "Owner question in the group",
      clientMessageId: "room-ask",
    });
    yield* startAgentWakeup({ orgId: person.orgId, agentId, threadId, message: asked });
    const gated = (name: string, args: Record<string, unknown>) =>
      call(name, args).pipe(Effect.provideService(Kin.KinServer, kin));
    const abortedAt = sql<{ abortedAt: number | null }>`SELECT aborted_at AS "abortedAt"
      FROM kin_wakeups WHERE agent_id = ${agentId} AND status = 'running' ORDER BY wakeup_id`;
    assert.deepStrictEqual(yield* abortedAt, [{ abortedAt: null }]);
    const mate = yield* groups.addMember([person], {
      chatId: KinChatId.make("room"),
      principal: { _tag: "person", personId: KinPersonId.make("teammate") },
    });
    assert.isNotNull((yield* abortedAt)[0]?.abortedAt);
    const calls = [
      ["kin_delegate", { kind: "build", title: "Invented", brief: "Invented", memoryItemIds: [] }],
      ["kin_follow_up", { workerId: "worker", brief: "Invented" }],
      ["kin_chat_post", { chatId: "room", body: "Invented", intent: "evidence" }],
      ["kin_widget_upsert", { chatId: "room", type: "task", state: taskState }],
      ["kin_hand_off", { toAgentId: "other", brief: "Invented" }],
      ["request_action", { kind: "merge", summary: "Invented" }],
      ["kin_defer", { title: "Invented", due: "2026-12-01T09:00:00Z" }],
    ] as const;
    // Only the chat tools are registered here; the gate asks `toolAdmitted` the same for all.
    const [wake] = yield* sql<{ wakeupId: string }>`SELECT wakeup_id AS "wakeupId" FROM kin_wakeups
      WHERE agent_id = ${agentId} AND status = 'running' ORDER BY wakeup_id`;
    const turn = { orgId: person.orgId, agentId, wakeupId: wake!.wakeupId };
    for (const [name, args] of calls)
      if (name === "kin_chat_post" || name === "kin_widget_upsert")
        assert.strictEqual((yield* gated(name, args).pipe(Effect.flip)).message, SHARED_REFUSAL);
      else assert.isFalse(yield* toolAdmitted(turn, name, args), name);
    // The teammate leaving between two calls opens nothing back up.
    yield* groups.removeMember([person], {
      chatId: KinChatId.make("room"),
      memberId: mate.memberId,
    });
    assert.strictEqual(
      (yield* gated("kin_chat_post", calls[2][1]).pipe(Effect.flip)).message,
      SHARED_REFUSAL,
    );
    assert.isNotNull((yield* abortedAt)[0]?.abortedAt);
    assert.deepStrictEqual(
      yield* sql`SELECT body FROM kin_messages WHERE chat_id = 'room' AND author_kind = 'agent'
        ORDER BY seq`,
      [],
    );
    assert.deepStrictEqual(
      yield* sql`SELECT widget_id FROM kin_widgets WHERE chat_id = 'room' ORDER BY widget_id`,
      [],
    );
  }).pipe(Effect.provide(gatedLayer)),
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

const resultOf = (result: McpSchema.CallToolResult) => {
  assert.isFalse(result.isError);
  const text = result.content.find((item) => item.type === "text")?.text;
  assert.isDefined(text);
  const value: unknown = JSON.parse(text);
  return value;
};
// Chats the lead is in besides its owner's direct chat: a team group nobody placed it in, another
// direct chat, and a group the lead's owner owns.
const otherChats = (sql: SqlClient.SqlClient, orgId: KinOrgId, ownerId: string) =>
  Effect.gen(function* () {
    const at = "1970-01-01T00:00:00.000Z";
    yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, title, team_id, direct_key, last_seq, last_message_at, created_at, archived_at) VALUES ('group-1', ${orgId}, 'team_group', 'Team', NULL, NULL, 0, NULL, ${at}, NULL), ('other-direct', ${orgId}, 'direct', NULL, NULL, 'other-key', 0, NULL, ${at}, NULL), ('owner-group', ${orgId}, 'team_group', 'Owner team', NULL, NULL, 0, NULL, ${at}, NULL)`;
    yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, agent_id, role, joined_at) VALUES ('group-lead', ${orgId}, 'group-1', 'agent', ${agentId}, 'member', ${at}), ('other-lead', ${orgId}, 'other-direct', 'agent', ${agentId}, 'member', ${at}), ('owner-group-lead', ${orgId}, 'owner-group', 'agent', ${agentId}, 'member', ${at})`;
    yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at) VALUES ('owner-group-owner', ${orgId}, 'owner-group', 'person', ${ownerId}, 'owner', ${at})`;
  });
const NOT_ALLOWED = {
  reason: "not_allowed",
  message: "You can't post in this chat. Nothing was sent.",
} as const;

it.effect(
  "at L0 kin_chat_post is refused outside chats its owner placed it in, and records nothing",
  () =>
    Effect.gen(function* () {
      const { person, sql } = yield* seed(false, "L0");
      yield* otherChats(sql, person.orgId, person.personId);
      const agentMessages = sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_messages
      WHERE org_id = ${person.orgId} AND author_kind = 'agent' ORDER BY n`;
      const post = (chatId: string) =>
        call("kin_chat_post", {
          chatId,
          body: "Rate limiting moves to Friday.",
          intent: "decision",
          clientMessageId: `post-${chatId}`,
        });
      for (const chatId of ["group-1", "other-direct", "missing", "foreign-chat"])
        assert.deepInclude(errorOf(yield* post(chatId)), NOT_ALLOWED);
      // The owner's own group passes the gate and meets the floor, as any group reply does.
      assert.include(errorOf(yield* post("owner-group")), { reason: "floor_not_granted" });
      assert.deepStrictEqual(yield* agentMessages, [{ n: 0 }]);
      assert.deepStrictEqual(yield* sql`SELECT COUNT(*) AS n FROM kin_shadow_entries ORDER BY n`, [
        { n: 0 },
      ]);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "at L0 a kin_ask card and a kin_react land in the owner's direct chat and are refused elsewhere",
  () =>
    Effect.gen(function* () {
      const { chat, person, sql } = yield* seed(false, "L0");
      yield* otherChats(sql, person.orgId, person.personId);
      const services = Option.getOrThrow((yield* Kin.KinServer).services);
      const agent = yield* Context.get(services, KinIdentity).resolveAgent(scope);
      const gate = Context.get(services, KinLevelGate);
      const ask = (chatId: string) =>
        gate.ask(agent, {
          chatId: KinChatId.make(chatId),
          clientMessageId: `ask-${chatId}`,
          question: "Ship today?",
          options: [{ label: "Yes" }, { label: "No" }],
        });
      assert.deepInclude(yield* ask("group-1").pipe(Effect.flip), NOT_ALLOWED);
      assert.deepInclude(yield* ask("other-direct").pipe(Effect.flip), NOT_ALLOWED);
      const card = yield* ask(chat.chatId);
      assert.include(card, { type: "choice", chatId: chat.chatId });
      assert.ok("messageId" in card);
      const react = (chatId: string) =>
        gate.react(agent, {
          chatId: KinChatId.make(chatId),
          messageId: card.messageId,
          emoji: "👍",
        });
      assert.deepInclude(yield* react("group-1").pipe(Effect.flip), NOT_ALLOWED);
      assert.include(yield* react(chat.chatId), { emoji: "👍", chatId: chat.chatId });
      // The tool takes every emoji a person's menu offers, not a narrower set of its own.
      const reactInput = Schema.decodeUnknownEffect(
        KinLeadToolkit.tools.kin_react.parametersSchema,
      );
      const accepted = yield* Effect.forEach(KIN_REACTION_EMOJI, (emoji) =>
        reactInput({ messageId: card.messageId, emoji }),
      );
      assert.deepStrictEqual(
        accepted.map((input) => input.emoji),
        [...KIN_REACTION_EMOJI],
      );
      assert.deepStrictEqual(
        yield* sql<{
          chatId: string;
          type: string;
        }>`SELECT chat_id AS "chatId", type FROM kin_widgets
        WHERE org_id = ${person.orgId} AND type = 'choice' ORDER BY widget_id`,
        [{ chatId: chat.chatId, type: "choice" }],
      );
    }).pipe(Effect.provide(layer)),
);

it.effect("a chat's own level caps the lead's: min(lead, chat), from stored rows only", () =>
  Effect.gen(function* () {
    const { chat, person, sql } = yield* seed(false, "L1");
    yield* otherChats(sql, person.orgId, person.personId);
    const post = (chatId: string, clientMessageId: string) =>
      call("kin_chat_post", { chatId, body: "Answer", intent: "answer", clientMessageId });
    yield* sql`INSERT INTO kin_chat_levels (org_id, agent_id, chat_id, level, level_since) VALUES (${person.orgId}, ${agentId}, 'group-1', 'L0', 0), (${person.orgId}, ${agentId}, ${chat.chatId}, 'L0', 0)`;
    assert.deepInclude(errorOf(yield* post("group-1", "capped")), NOT_ALLOWED);
    // The owner's direct chat posts at L0, whichever level makes it L0.
    assert.include(resultOf(yield* post(chat.chatId, "owner")), { authorRole: "member" });
    // Cards follow the same cap: a capped group's cards are refused before any lookup.
    const capped = NOT_ALLOWED.message;
    const card = (chatId: string) =>
      call("kin_widget_upsert", {
        chatId,
        widgetId: "widget-1",
        revision: 1,
        type: "task",
        state: taskState,
      });
    assert.include(errorOf(yield* card("group-1")), { reason: "not_allowed", message: capped });
    assert.notInclude(JSON.stringify(errorOf(yield* card(chat.chatId))), capped);
    // A chat level above the lead's never raises it.
    yield* sql`UPDATE kin_leads SET level = 'L0' WHERE agent_id = ${agentId}`;
    yield* sql`UPDATE kin_chat_levels SET level = 'L3' WHERE agent_id = ${agentId}`;
    assert.deepInclude(errorOf(yield* post("group-1", "still-l0")), NOT_ALLOWED);
    // Only a direct chat counts as the owner's, whatever kin_leads names.
    yield* sql`UPDATE kin_leads SET owner_chat_id = 'group-1' WHERE agent_id = ${agentId}`;
    assert.deepInclude(errorOf(yield* post("group-1", "not-direct")), NOT_ALLOWED);
    yield* sql`UPDATE kin_leads SET owner_chat_id = ${chat.chatId} WHERE agent_id = ${agentId}`;
    yield* sql`UPDATE kin_leads SET level = 'L1' WHERE agent_id = ${agentId}`;
    yield* sql`DELETE FROM kin_chat_levels WHERE agent_id = ${agentId}`;
    assert.include(errorOf(yield* post("group-1", "live")), { reason: "floor_not_granted" });
  }).pipe(Effect.provide(layer)),
);

it.effect.each(["L0", "L1"] as const)(
  "at %s the owner's direct chat posts for real, under the floor",
  (level) =>
    Effect.gen(function* () {
      const { chat, person, sql } = yield* seed(false, level);
      const post = (clientMessageId: string, body = "Answer", intent = "answer") =>
        call("kin_chat_post", { chatId: chat.chatId, body, intent, clientMessageId });
      const reply = resultOf(yield* post("reply"));
      assert.include(reply, { chatId: chat.chatId, authorRole: "member", body: "Answer" });
      assert.deepStrictEqual(resultOf(yield* post("reply")), reply);
      assert.include(errorOf(yield* post("reply", "Changed")), { reason: "not_allowed" });
      // One grant lasts the wake-up: a second post shares the reply's floor run.
      assert.include(resultOf(yield* post("again", "More", "evidence")), {
        floorRunId: (reply as { floorRunId: string }).floorRunId,
      });
      assert.deepStrictEqual(
        yield* sql`SELECT COUNT(*) AS n FROM kin_messages WHERE org_id = ${person.orgId} AND author_kind = 'agent' ORDER BY n`,
        [{ n: 2 }],
      );
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
        { reason: "disabled" },
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
          Layer.provide(
            Layer.effect(
              KinMcp.KinAgentSessions,
              Effect.gen(function* () {
                const registry = yield* McpSessions.McpSessionRegistry;
                return { resolveAgent: registry.resolve };
              }),
            ).pipe(Layer.provideMerge(authRegistry)),
          ),
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
    assert.isUndefined(yield* resolve(agent));
    const agents = yield* KinMcp.KinAgentSessions;
    assert.isDefined(yield* agents.resolveAgent(agent.config.authorizationHeader.slice(7)));
    yield* identity.endAgentThread({ orgId: person.orgId, threadId });
    assert.isUndefined(yield* resolve(agent));
    assert.isUndefined(yield* agents.resolveAgent(agent.config.authorizationHeader.slice(7)));
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
      // Once another agent has spoken, only an agent the message still owes a turn answers it.
      const [owed] = yield* sql<{
        mention_queue: string;
      }>`SELECT mention_queue FROM kin_floor_runs WHERE run_id = ${grant.run_id}`;
      yield* sql`UPDATE kin_floor_runs SET agent_turns = 1, last_speaker = 'other', mention_queue = '[]' WHERE run_id = ${grant.run_id}`;
      assert.include(failureOf(yield* sendFloor(post)), { reason: "invalid_state" });
      yield* sql`UPDATE kin_floor_runs SET agent_turns = 0, last_speaker = NULL, mention_queue = ${owed!.mention_queue} WHERE run_id = ${grant.run_id}`;
      const first = yield* sendFloor(post);
      assert.isTrue(Result.isSuccess(first));
      assert.deepStrictEqual(yield* sendFloor(post), first);
      assert.include(failureOf(yield* sendFloor({ ...post, body: "Changed" })), {
        reason: "not_allowed",
      });
      assert.deepStrictEqual(yield* chatService.send(person, prompt), human);
      // The wake-up's grant lasts its run: later posts share the floor run as one agent turn.
      for (const intent of ["answer", "evidence", "question"] as const)
        assert.include(
          Result.getOrThrow(
            yield* sendFloor({ ...post, intent, clientMessageId: `second-${intent}` }),
          ),
          { floorRunId: grant.run_id },
        );
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
      // One wake-up, one turn: both land in the same run without a second grant.
      const runs = concurrent.map((result) => Result.getOrThrow(result).floorRunId);
      assert.strictEqual(new Set(runs).size, 1);
      assert.deepStrictEqual(
        yield* sql`SELECT agent_turns FROM kin_floor_runs WHERE org_id = ${person.orgId} AND run_id = ${runs[0]} ORDER BY run_id`,
        [{ agent_turns: 1 }],
      );
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
      for (let n = 1; n < 10; n++) {
        // The hourly limit spans wake-ups; one wake-up alone stops at eight posts per chat.
        if (n === 5) yield* startAgentWakeup({ orgId: person.orgId, agentId, threadId });
        assert.isFalse(
          (yield* sendFloor({ ...post, clientMessageId: `notice-${n}` }))._tag === "Failure",
        );
      }
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
  "grants each agent a group message names one reply, and keeps the six-turn door closed until a human speaks",
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
      }>`SELECT token, run_id FROM kin_floor_grants WHERE org_id = ${person.orgId} AND chat_id = ${chat.chatId} AND agent_id = ${agentId} ORDER BY token`;
      assert.isDefined(grant);
      const post = {
        chatId: chat.chatId,
        body: "Answer",
        intent: "answer",
        clientMessageId: "group-answer",
      } as const;
      // The grant is the agent's own row: a token that isn't its grant's opens nothing.
      assert.include(failureOf(yield* sendFloor({ ...post, floorGrant: "forged" })), {
        reason: "floor_not_granted",
      });
      const first = yield* sendFloor(post);
      assert.isTrue(Result.isSuccess(first));
      assert.deepStrictEqual(
        yield* sql`SELECT agent_id FROM kin_floor_grants
        WHERE org_id = ${person.orgId} AND run_id = ${grant.run_id} AND consumed_at IS NULL ORDER BY token`,
        [{ agent_id: "queued-qa" }],
      );
      assert.deepStrictEqual(yield* sendFloor({ ...post, floorGrant: grant.token }), first);
      // The same wake-up keeps talking in its turn; it is still one agent turn.
      assert.include(
        Result.getOrThrow(
          yield* sendFloor({ ...post, clientMessageId: "reuse", intent: "evidence" }),
        ),
        { floorRunId: grant.run_id },
      );
      assert.deepStrictEqual(
        yield* sql`SELECT agent_turns FROM kin_floor_runs WHERE org_id = ${person.orgId} AND run_id = ${grant.run_id} ORDER BY run_id`,
        [{ agent_turns: 1 }],
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
      }>`SELECT token FROM kin_floor_grants WHERE org_id = ${person.orgId} AND run_id != ${grant.run_id} AND agent_id = ${agentId} ORDER BY token`;
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
