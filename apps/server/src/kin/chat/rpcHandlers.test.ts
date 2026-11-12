import { pairSession } from "../auth/ProofKeySessions.testkit.ts";
import { dormantLeadDependencies } from "../lead/layer.testkit.ts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Hub from "./KinChatHub.ts";
import * as Service from "./KinChatService.ts";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  type AuthEnvironmentScope,
  AuthKinChatScope,
  AuthSessionId,
  AuthSettingsWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  KinChatError,
  KinMemberId,
  KinPersonId,
  KinTaskCardState,
  KinWidgetId,
  KinWaitingId,
  AuthStandardClientScopes,
  KinAgentId,
  KinChatId,
  KinMessageId,
  KinChatAndBudgetRpcs,
  KinOrgId,
  ProviderInstanceId,
  ThreadId,
  RpcScopeAuthorization,
  WsRpcGroup,
  WS_METHODS,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as RpcTest from "effect/rpc/RpcTest";
import * as Schema from "effect/Schema";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcServer from "effect/rpc/RpcServer";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as FileSystem from "effect/FileSystem";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as RpcAuthorization from "../../auth/RpcAuthorization.ts";
import * as Kin from "../layer.ts";
import * as Chat from "./layer.ts";
import { KinIdentity } from "./KinIdentity.ts";
import { KinChatService } from "./KinChatService.ts";
import * as Repository from "./KinChatRepository.ts";
import { makeKinHandlers } from "../rpcHandlers.ts";
import { KIN_OPEN_CHATS_PER_CONNECTION } from "./rpcHandlers.ts";

const decodeTaskState = Schema.decodeEffect(KinTaskCardState);

const session = {
  sessionId: AuthSessionId.make("owner-session"),
  subject: "browser",
  method: "browser-session-cookie" as const,
  scopes: AuthStandardClientScopes,
};
const configured = ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }));
const root = Kin.layer.pipe(
  Layer.provide(dormantLeadDependencies),
  Layer.provideMerge(Chat.layer),
  Layer.provide(configured),
);
const probe = WsRpcGroup.omit(
  ...[...WsRpcGroup.requests.keys()].filter(
    (
      tag,
    ): tag is Exclude<RpcGroup.Rpcs<typeof WsRpcGroup>["_tag"], typeof WS_METHODS.serverProbe> =>
      tag !== WS_METHODS.serverProbe,
  ),
);
const group = RpcGroup.make(...KinChatAndBudgetRpcs, ...probe.requests.values()).middleware(
  RpcScopeAuthorization,
);
const seed = Effect.gen(function* () {
  const context = yield* Effect.context<
    KinIdentity | KinChatService | Repository.KinChatRepository | Hub.KinChatHub
  >();
  const identity = Context.get(context, KinIdentity);
  const chat = Context.get(context, KinChatService);
  const repo = Context.get(context, Repository.KinChatRepository);
  yield* pairSession(session.sessionId);
  const person = (yield* identity.resolve(session))[0];
  assert.isDefined(person);
  const agentId = KinAgentId.make("lead");
  yield* repo.insertAgent({
    ...person,
    agentId,
    ownerPersonId: person.personId,
    displayName: "Lead",
    role: "lead",
    createdAt: "1970-01-01T00:00:00.000Z",
  });
  const direct = yield* chat.createDirect(person, { ...person, agentId });
  return { identity, chat, repo, person, direct, context };
});

it.effect("serves real WS sends, subscriptions and afterSeq resume with org isolation", () =>
  Effect.gen(function* () {
    const { direct, repo, chat, person } = yield* seed;
    const threadId = ThreadId.make("registered-through-runner");
    const runnerConsumer = yield* Effect.gen(function* () {
      const root = yield* Kin.KinServer;
      return Context.get(Option.getOrThrow(root.services), KinIdentity).registerAgentThread;
    });
    const toolConsumer = yield* Effect.gen(function* () {
      const root = yield* Kin.KinServer;
      return Context.get(Option.getOrThrow(root.services), KinIdentity).isAgentThread;
    });
    assert.isFalse(toolConsumer(threadId));
    yield* runnerConsumer({ ...person, agentId: KinAgentId.make("lead"), threadId });
    assert.isTrue(toolConsumer(threadId));
    const handlers = yield* makeKinHandlers(session);
    const serverHandlers = group.toLayer({ ...handlers, "server.probe": () => Effect.succeed({}) });
    const route = Layer.effectDiscard(
      Effect.gen(function* () {
        const router = yield* HttpRouter.HttpRouter;
        const effect = yield* RpcServer.toHttpEffectWebsocket(group);
        yield* router.add("GET", "/ws", effect);
      }),
    ).pipe(
      Layer.provide(serverHandlers),
      Layer.provide(RpcSerialization.layerJson),
      Layer.provide(RpcAuthorization.layer(AuthStandardClientScopes)),
    );
    const server = yield* Layer.build(
      HttpRouter.serve(route, { disableListenLog: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layerTest),
      ),
    );
    const address = Context.get(server, HttpServer.HttpServer).address;
    if (address._tag === "UnixPathAddress") return assert.fail("Expected an internet socket");
    const transport = yield* Layer.build(
      RpcClient.layerProtocolSocket({ retryTransientErrors: false }).pipe(
        Layer.provide(NodeSocket.layerWebSocket(`ws://127.0.0.1:${address.port}/ws`)),
        Layer.provide(RpcSerialization.layerJson),
      ),
    );
    const client = yield* RpcClient.make(group).pipe(Effect.provide(transport));
    assert.deepStrictEqual(yield* client["server.probe"]({}), {});
    const forged = {
      chatId: direct.chatId,
      clientMessageId: "first",
      body: "Hello",
      author: { _tag: "system" },
    };
    const first = yield* client["kin.messages.send"](forged);
    assert.strictEqual(first.clientMessageId, "first");
    assert.include(first.author, { _tag: "human", personId: person.personId });
    const events = yield* Stream.toQueue(
      client["kin.chat.subscribe"]({ chatId: direct.chatId, afterSeq: 0 }),
      { capacity: "unbounded" },
    );
    const backlog = yield* Queue.take(events);
    assert.include(backlog, { _tag: "backlog", lastSeq: 1 });
    if (backlog._tag === "backlog") assert.deepStrictEqual(backlog.messages, [first]);
    const next = yield* client["kin.messages.send"]({
      chatId: direct.chatId,
      clientMessageId: "next",
      body: "Live",
    });
    assert.deepStrictEqual(yield* Queue.take(events), { _tag: "message", message: next });
    const resumed = Option.getOrThrow(
      yield* Stream.runHead(
        client["kin.chat.subscribe"]({ chatId: direct.chatId, afterSeq: first.seq }),
      ),
    );
    assert.include(resumed, { _tag: "backlog", lastSeq: 2 });
    if (resumed._tag === "backlog") assert.deepStrictEqual(resumed.messages, [next]);
    const list = Option.getOrThrow(yield* Stream.runHead(client["kin.chats.subscribe"]({})));
    assert.strictEqual(list._tag, "snapshot");
    if (list._tag === "snapshot") assert.strictEqual(list.chats[0]?.lastSeq, 2);
    const foreignOrg = KinOrgId.make("foreign");
    const foreignChat = KinChatId.make("foreign-chat");
    yield* repo.insertOrg({ orgId: foreignOrg, name: "Other", createdAt: direct.createdAt });
    yield* repo.createChat({
      ...direct,
      orgId: foreignOrg,
      chatId: foreignChat,
      kind: "project_group",
      directKey: null,
    });
    const foreignPerson = {
      _tag: "person" as const,
      orgId: foreignOrg,
      personId: KinPersonId.make("foreign-person"),
    };
    yield* repo.insertPerson({
      ...foreignPerson,
      handle: "foreign",
      displayName: "Other",
      githubLogin: null,
      createdAt: direct.createdAt,
    });
    yield* repo.addMember({
      ...foreignPerson,
      chatId: foreignChat,
      memberId: KinMemberId.make("foreign-member"),
      principal: foreignPerson,
      role: "owner",
      joinedAt: direct.createdAt,
      leftAt: null,
      mutedUntil: null,
    });
    const foreignAgentId = KinAgentId.make("foreign-agent");
    yield* repo.insertAgent({
      ...foreignPerson,
      agentId: foreignAgentId,
      displayName: "Other lead",
      role: "lead",
      ownerPersonId: foreignPerson.personId,
      createdAt: direct.createdAt,
    });
    const foreignMessage = yield* chat.send(foreignPerson, {
      chatId: foreignChat,
      clientMessageId: "foreign-message",
      body: "Private",
    });
    const foreignWidget = {
      ...foreignPerson,
      widgetId: KinWidgetId.make("foreign-widget"),
      messageId: foreignMessage.messageId,
      widgetClass: "native" as const,
      revision: 1,
      source: null,
      feed: null,
      awaiting: [],
      pinnedAt: null,
      closedAt: null,
      updatedAt: direct.createdAt,
      chatId: foreignChat,
      type: "task" as const,
      state: yield* decodeTaskState({
        taskId: "task",
        environmentId: "environment",
        threadId,
        remoteEnvironmentId: null,
        title: "Private",
        model: null,
        status: "working",
        pullRequests: [],
        lastError: null,
        updatedAt: direct.createdAt,
      }),
    };
    yield* repo.insertWidget({ ...foreignWidget, audience: "chat" });
    const orgs = yield* client["kin.orgs.list"]({});
    assert.deepStrictEqual(
      orgs.orgs.map(({ orgId }) => orgId),
      [person.orgId],
    );
    assert.deepStrictEqual(orgs.orgs[0]?.agents, [
      { agentId: KinAgentId.make("lead"), displayName: "Lead", retired: false },
    ]);
    const denials = [
      ["kin.chats.subscribe", Stream.runHead(client["kin.chats.subscribe"]({ orgId: foreignOrg }))],
      [
        "kin.chats.createDirect",
        client["kin.chats.createDirect"]({ orgId: foreignOrg, agentId: KinAgentId.make("lead") }),
      ],
      [
        "kin.chats.createDirect/agent",
        client["kin.chats.createDirect"]({ orgId: person.orgId, agentId: foreignAgentId }),
      ],
      ["kin.chat.subscribe", Stream.runHead(client["kin.chat.subscribe"]({ chatId: foreignChat }))],
      [
        "kin.chat.history",
        client["kin.chat.history"]({ chatId: foreignChat, beforeSeq: 100, limit: 100 }),
      ],
      [
        "kin.messages.send/chat",
        client["kin.messages.send"]({ chatId: foreignChat, body: "No", clientMessageId: "denied" }),
      ],
      [
        "kin.messages.send/message",
        client["kin.messages.send"]({
          chatId: direct.chatId,
          body: "No",
          clientMessageId: "foreign-reply",
          replyTo: foreignMessage.messageId,
        }),
      ],
      ["kin.messages.markRead", client["kin.messages.markRead"]({ chatId: foreignChat, seq: 1 })],
      [
        "kin.widgets.act",
        client["kin.widgets.act"]({
          widgetId: foreignWidget.widgetId,
          revision: 1,
          actionId: "open",
          clientActionId: "denied",
        }),
      ],
    ] as const;
    for (const [method, request] of denials)
      assert.include(
        yield* request.pipe(Effect.flip),
        { reason: "not_found", message: "Kin record not found." },
        method,
      );
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE kin_agents SET retired_at = ${direct.createdAt} WHERE org_id = ${person.orgId} AND agent_id = 'lead'`;
    assert.deepStrictEqual((yield* client["kin.orgs.list"]({})).orgs[0]?.agents, [
      { agentId: KinAgentId.make("lead"), displayName: "Lead", retired: true },
    ]);
  }).pipe(Effect.provide(root.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

it.effect(
  "subscribes before the resume read, deduplicates a concurrent send, then emits live",
  () =>
    Effect.gen(function* () {
      const { chat, repo, person, direct, context } = yield* seed;
      const subscribed = yield* Deferred.make<void>();
      const historyStarted = yield* Deferred.make<void>();
      const releaseHistory = yield* Deferred.make<void>();
      const hub = Context.get(context, Hub.KinChatHub);
      const interceptedRepo = {
        ...repo,
        resume: (input: Parameters<typeof repo.resume>[0]) =>
          Deferred.succeed(historyStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseHistory)),
            Effect.andThen(repo.resume(input)),
          ),
      };
      const service = yield* KinChatService.pipe(
        Effect.provide(
          Layer.fresh(Service.layer).pipe(
            Layer.provide(Layer.succeed(Repository.KinChatRepository, interceptedRepo)),
            Layer.provide(
              Layer.succeed(Hub.KinChatHub, {
                ...hub,
                subscribeForViewer: (viewer) =>
                  hub
                    .subscribeForViewer(viewer)
                    .pipe(Effect.tap(() => Deferred.succeed(subscribed, undefined))),
              }),
            ),
          ),
        ),
      );
      assert.notStrictEqual(service, chat);
      const events = yield* Stream.toQueue(
        service.subscribe(person, { chatId: direct.chatId, afterSeq: 0 }),
        { capacity: "unbounded" },
      );
      yield* Deferred.await(historyStarted);
      assert.isTrue(yield* Deferred.isDone(subscribed));
      const concurrent = yield* chat.send(person, {
        chatId: direct.chatId,
        body: "During read",
        clientMessageId: "concurrent",
      });
      yield* Deferred.succeed(releaseHistory, undefined);
      const backlog = yield* Queue.take(events);
      assert.strictEqual(backlog._tag, "backlog");
      if (backlog._tag === "backlog") assert.deepStrictEqual(backlog.messages, [concurrent]);
      const live = yield* chat.send(person, {
        chatId: direct.chatId,
        body: "After read",
        clientMessageId: "live",
      });
      assert.deepStrictEqual(yield* Queue.take(events), { _tag: "message", message: live });
      const delayed = yield* repo.insertMessage({
        audience: "chat",
        ...live,
        messageId: KinMessageId.make("delayed"),
        clientMessageId: { kind: "send", id: "delayed" },
      });
      const later = yield* repo.insertMessage({
        audience: "chat",
        ...live,
        messageId: KinMessageId.make("later"),
        clientMessageId: { kind: "send", id: "later" },
      });
      yield* hub.publish({ type: "message.posted", orgId: person.orgId, message: later });
      yield* hub.publish({ type: "message.posted", orgId: person.orgId, message: later });
      yield* hub.publish({ type: "message.posted", orgId: person.orgId, message: delayed });
      assert.deepStrictEqual(yield* Queue.take(events), { _tag: "message", message: later });
      assert.deepStrictEqual(yield* Queue.take(events), { _tag: "message", message: delayed });
    }).pipe(Effect.provide(root.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

// QA Q17: one socket held 1,000 subscriptions to a chat, about 240 KB of server memory each.
it.effect("caps the chats one connection keeps open with a plain refusal", () =>
  Effect.gen(function* () {
    const { direct } = yield* seed;
    const handlers = yield* makeKinHandlers(session);
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.merge(
          group.toLayer({ ...handlers, "server.probe": () => Effect.succeed({}) }),
          RpcAuthorization.layer(AuthStandardClientScopes),
        ),
      ),
    );
    const subscribe = () => client["kin.chat.subscribe"]({ chatId: direct.chatId });
    for (let open = 0; open < KIN_OPEN_CHATS_PER_CONNECTION; open++) {
      const events = yield* Stream.toQueue(subscribe(), { capacity: "unbounded" });
      assert.include(yield* Queue.take(events), { _tag: "backlog" });
    }
    assert.include(yield* Stream.runHead(subscribe()).pipe(Effect.flip), { reason: "limit" });
  }).pipe(Effect.provide(root.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

it.effect("keeps transport handlers out of persistence", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const source = yield* fs.readFileString(new URL("./rpcHandlers.ts", import.meta.url).pathname);
    assert.notMatch(source, /KinChatRepository|sql\/SqlClient|(?:kin|\.\.)\/persistence/);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("resets large backlogs and bounds a resume to the current snapshot", () =>
  Effect.gen(function* () {
    const { chat, person, direct, repo, context } = yield* seed;
    for (let i = 0; i < 201; i++)
      yield* chat.send(person, {
        chatId: direct.chatId,
        body: `Message ${i}`,
        clientMessageId: `message-${i}`,
      });
    assert.deepStrictEqual(
      Option.getOrThrow(
        yield* Stream.runHead(chat.subscribe(person, { chatId: direct.chatId, afterSeq: 0 })),
      ),
      { _tag: "reset", lastSeq: 201, lastChangeSeq: 201 },
    );
    const resume = Option.getOrThrow(
      yield* Stream.runHead(chat.subscribe(person, { chatId: direct.chatId, afterSeq: 1 })),
    );
    assert.strictEqual(resume._tag, "backlog");
    if (resume._tag === "backlog") {
      assert.strictEqual(resume.messages.length, 200);
      assert.strictEqual(resume.messages[0]?.seq, 2);
      assert.strictEqual(resume.lastSeq, 201);
    }
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE kin_messages SET body = 'Offline edit' WHERE org_id = ${person.orgId} AND chat_id = ${direct.chatId}`;
    assert.deepStrictEqual(
      Option.getOrThrow(
        yield* Stream.runHead(
          chat.subscribe(person, {
            chatId: direct.chatId,
            afterSeq: 201,
            afterChangeSeq: 201,
          }),
        ),
      ),
      { _tag: "reset", lastSeq: 201, lastChangeSeq: 402 },
    );
    // A client keeps its change cursor frozen while live, so the stream must refresh it.
    const events = yield* Stream.toQueue(
      chat.subscribe(person, { chatId: direct.chatId, afterSeq: 201, afterChangeSeq: 402 }),
      { capacity: "unbounded" },
    );
    let cursor = yield* Queue.take(events);
    assert.strictEqual(cursor._tag, "backlog");
    for (let i = 0; i < 201; i++)
      yield* chat.send(person, {
        chatId: direct.chatId,
        body: `Live ${i}`,
        clientMessageId: `live-${i}`,
      });
    const held = new Set<string>();
    let afterSeq = 201;
    for (let i = 0; i < 201; i++) {
      const event = yield* Queue.take(events);
      if (event._tag === "message") {
        held.add(event.message.messageId);
        afterSeq = Math.max(afterSeq, event.message.seq);
      } else if (event._tag === "backlog") {
        assert.isFalse(event.messages.some((m) => held.has(m.messageId)));
        cursor = event;
      }
    }
    assert.strictEqual(cursor._tag, "backlog");
    if (cursor._tag !== "backlog") return;
    const reconnect = Option.getOrThrow(
      yield* Stream.runHead(
        chat.subscribe(person, {
          chatId: direct.chatId,
          afterSeq,
          afterChangeSeq: cursor.lastChangeSeq,
        }),
      ),
    );
    assert.strictEqual(reconnect._tag, "backlog");

    // Widget writes bump their anchor's change_seq too, so widget-only activity must refresh it.
    const hub = Context.get(context, Hub.KinChatHub);
    const anchors = yield* sql<{
      messageId: string;
      seq: number;
    }>`SELECT message_id AS "messageId", seq
      FROM kin_messages WHERE org_id = ${person.orgId} AND chat_id = ${direct.chatId} ORDER BY seq LIMIT 201`;
    const widgets = [];
    for (const [i, anchor] of anchors.entries()) {
      const widget = {
        orgId: person.orgId,
        chatId: direct.chatId,
        widgetId: KinWidgetId.make(`live-widget-${i}`),
        messageId: KinMessageId.make(anchor.messageId),
        widgetClass: "native" as const,
        revision: 1,
        source: null,
        feed: null,
        awaiting: [],
        pinnedAt: null,
        closedAt: null,
        updatedAt: direct.createdAt,
        type: "task" as const,
        state: yield* decodeTaskState({
          taskId: `task-${i}`,
          environmentId: "environment",
          threadId: ThreadId.make(`thread-${i}`),
          remoteEnvironmentId: null,
          title: "Task",
          model: null,
          status: "working",
          pullRequests: [],
          lastError: null,
          updatedAt: direct.createdAt,
        }),
      };
      yield* repo.insertWidget({ ...widget, audience: "chat" });
      widgets.push(widget);
    }
    const [frozen] = yield* sql<{ seq: number; change: number }>`SELECT MAX(seq) AS seq,
      MAX(change_seq) AS change FROM kin_messages WHERE org_id = ${person.orgId} AND chat_id = ${direct.chatId}`;
    const widgetEvents = yield* Stream.toQueue(
      chat.subscribe(person, {
        chatId: direct.chatId,
        afterSeq: frozen!.seq,
        afterChangeSeq: frozen!.change,
      }),
      { capacity: "unbounded" },
    );
    let widgetCursor = yield* Queue.take(widgetEvents);
    assert.strictEqual(widgetCursor._tag, "backlog");
    for (const widget of widgets) {
      yield* sql`UPDATE kin_widgets SET revision = 2 WHERE org_id = ${person.orgId} AND widget_id = ${widget.widgetId}`;
      yield* hub.publish({
        type: "widget.updated",
        orgId: person.orgId,
        widget: { ...widget, revision: 2 },
      });
    }
    // Updates the checkpoint already carried arrive in its backlog, not again live.
    const seen = new Set<string>();
    while (seen.size < widgets.length) {
      const event = yield* Queue.take(widgetEvents);
      if (event._tag === "widget") seen.add(event.widget.widgetId);
      else if (event._tag === "backlog") {
        widgetCursor = event;
        for (const widget of event.widgets) seen.add(widget.widgetId);
      }
    }
    assert.strictEqual(widgetCursor._tag, "backlog");
    if (widgetCursor._tag !== "backlog") return;
    const widgetReconnect = Option.getOrThrow(
      yield* Stream.runHead(
        chat.subscribe(person, {
          chatId: direct.chatId,
          afterSeq: frozen!.seq,
          afterChangeSeq: widgetCursor.lastChangeSeq,
        }),
      ),
    );
    assert.strictEqual(widgetReconnect._tag, "backlog");
  }).pipe(Effect.provide(root.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

it.effect("subscribes before the list snapshot and drops buffered state already in it", () =>
  Effect.gen(function* () {
    const { chat, person, direct, context } = yield* seed;
    const hub = Context.get(context, Hub.KinChatHub);
    const service = yield* KinChatService.pipe(
      Effect.provide(
        Layer.fresh(Service.layer).pipe(
          Layer.provide(
            Layer.succeed(
              Repository.KinChatRepository,
              Context.get(context, Repository.KinChatRepository),
            ),
          ),
          Layer.provide(
            Layer.succeed(Hub.KinChatHub, {
              ...hub,
              subscribeForViewer: (viewer) =>
                hub.subscribeForViewer(viewer).pipe(
                  Effect.tap(() =>
                    chat
                      .send(person, {
                        chatId: direct.chatId,
                        clientMessageId: "during-list",
                        body: "During snapshot",
                      })
                      .pipe(Effect.orDie),
                  ),
                ),
            }),
          ),
        ),
      ),
    );
    const queue = yield* Stream.toQueue(service.subscribeChats([person], {}), {
      capacity: "unbounded",
    });
    const initial = yield* Queue.take(queue);
    assert.strictEqual(initial._tag, "snapshot");
    if (initial._tag === "snapshot") assert.strictEqual(initial.chats[0]?.lastSeq, 1);
    yield* chat.send(person, {
      chatId: direct.chatId,
      clientMessageId: "after-list",
      body: "After snapshot",
    });
    const live = yield* Queue.take(queue);
    assert.strictEqual(live._tag, "chat");
    if (live._tag === "chat") assert.strictEqual(live.chat.lastSeq, 2);
  }).pipe(Effect.provide(root.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

it.effect("denies settings-only sessions before Kin handlers execute", () =>
  Effect.gen(function* () {
    const handlers = yield* makeKinHandlers({ ...session, scopes: [AuthSettingsWriteScope] });
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.merge(
          group.toLayer({ ...handlers, "server.probe": () => Effect.succeed({}) }),
          RpcAuthorization.layer([AuthSettingsWriteScope]),
        ),
      ),
    );
    assert.strictEqual(
      (yield* client["kin.orgs.list"]({}).pipe(Effect.flip))._tag,
      "EnvironmentAuthorizationError",
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("drops a failed waiting read without ending the chat list stream", () =>
  Effect.gen(function* () {
    const { repo, person, direct, context, chat } = yield* seed;
    const hub = Context.get(context, Hub.KinChatHub);
    const service = yield* KinChatService.pipe(
      Effect.provide(
        Layer.fresh(Service.layer).pipe(
          Layer.provide(
            Layer.succeed(Repository.KinChatRepository, {
              ...repo,
              getWaiting: () =>
                Effect.fail(
                  new KinChatError({ reason: "not_found", message: "Kin record not found." }),
                ),
            }),
          ),
        ),
      ),
    );
    const events = yield* Stream.toQueue(service.subscribeChats([person], {}), {
      capacity: "unbounded",
    });
    assert.strictEqual((yield* Queue.take(events))._tag, "snapshot");
    yield* hub.publish({
      type: "waiting.updated",
      orgId: person.orgId,
      item: {
        ...person,
        chatId: direct.chatId,
        waitingId: KinWaitingId.make("failed-read"),
        messageId: null,
        widgetId: null,
        reason: "mention",
        createdAt: direct.createdAt,
        resolvedAt: null,
        resolution: null,
      },
    });
    yield* chat.send(person, {
      chatId: direct.chatId,
      body: "Still live",
      clientMessageId: "marker",
    });
    const next = yield* Queue.take(events);
    assert.strictEqual(next._tag, "chat");
    if (next._tag === "chat") assert.strictEqual(next.chat.lastSeq, 1);
  }).pipe(Effect.provide(root.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

it.effect(
  "serves budget and time zone settings to the owner and refuses non-owner and foreign organizations",
  () =>
    Effect.gen(function* () {
      const { person, repo } = yield* seed;
      const handlers = yield* makeKinHandlers(session);
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.merge(
            group.toLayer({ ...handlers, "server.probe": () => Effect.succeed({}) }),
            RpcAuthorization.layer(AuthStandardClientScopes),
          ),
        ),
      );
      const input = { orgId: person.orgId, limits: { leadUnits: 300, workerUnits: 600 } };
      assert.deepStrictEqual((yield* client["kin.budget.set"](input)).limits, input.limits);
      assert.deepStrictEqual(
        (yield* client["kin.budget.get"]({ orgId: person.orgId })).limits,
        input.limits,
      );
      assert.include(
        yield* client["kin.budget.set"]({ ...input, orgId: KinOrgId.make("foreign") }).pipe(
          Effect.flip,
        ),
        { reason: "not_found" },
      );
      const memberId = KinPersonId.make("non-owner");
      yield* repo.insertPerson({
        orgId: person.orgId,
        personId: memberId,
        handle: "member",
        displayName: "Member",
        githubLogin: null,
        createdAt: "1970-01-01T00:00:00.000Z",
      });
      const kin = yield* Kin.KinServer;
      const services = Option.getOrThrow(kin.services);
      const identity = Context.get(services, KinIdentity);
      const memberHandlers = yield* makeKinHandlers(session).pipe(
        Effect.provideService(Kin.KinServer, {
          ...kin,
          services: Option.some(
            Context.add(services, KinIdentity, {
              ...identity,
              resolve: () =>
                Effect.succeed([{ _tag: "person", orgId: person.orgId, personId: memberId }]),
            }),
          ),
        }),
      );
      const memberClient = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.merge(
            group.toLayer({ ...memberHandlers, "server.probe": () => Effect.succeed({}) }),
            RpcAuthorization.layer(AuthStandardClientScopes),
          ),
        ),
      );
      assert.include(yield* memberClient["kin.budget.set"](input).pipe(Effect.flip), {
        reason: "not_allowed",
      });
      const readOnly = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.merge(
            group.toLayer({ ...handlers, "server.probe": () => Effect.succeed({}) }),
            RpcAuthorization.layer([AuthOrchestrationReadScope]),
          ),
        ),
      );
      const zone = { orgId: person.orgId, timeZone: "Asia/Kolkata" };
      assert.deepStrictEqual(yield* client["kin.triggers.getTimeZone"]({ orgId: person.orgId }), {
        ...zone,
        timeZone: "UTC",
      });
      assert.include(yield* memberClient["kin.triggers.setTimeZone"](zone).pipe(Effect.flip), {
        reason: "not_allowed",
      });
      assert.strictEqual(
        (yield* readOnly["kin.budget.set"](input).pipe(Effect.flip))._tag,
        "EnvironmentAuthorizationError",
      );
      assert.strictEqual(
        (yield* readOnly["kin.triggers.setTimeZone"](zone).pipe(Effect.flip))._tag,
        "EnvironmentAuthorizationError",
      );
      // Where visuals may load from is the owner's alone: a teammate's session and a session
      // without the settings grant are both refused, whatever they ask.
      const host = { orgId: person.orgId, host: "tiles.example.com" };
      assert.deepStrictEqual(yield* client["kin.visuals.hosts.allow"](host), {
        orgId: person.orgId,
        hosts: ["tiles.example.com"],
      });
      for (const call of [
        memberClient["kin.visuals.hosts.list"]({ orgId: person.orgId }),
        memberClient["kin.visuals.hosts.allow"]({ ...host, host: "evil.example.com" }),
        memberClient["kin.visuals.hosts.remove"](host),
      ])
        assert.include(yield* call.pipe(Effect.flip), { reason: "not_allowed" });
      for (const call of [
        readOnly["kin.visuals.hosts.list"]({ orgId: person.orgId }),
        readOnly["kin.visuals.hosts.allow"](host),
        readOnly["kin.visuals.hosts.remove"](host),
      ])
        assert.strictEqual((yield* call.pipe(Effect.flip))._tag, "EnvironmentAuthorizationError");
      assert.deepStrictEqual(yield* client["kin.visuals.hosts.remove"](host), {
        orgId: person.orgId,
        hosts: [],
      });
    }).pipe(Effect.provide(root.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

it.effect("lets only the owner stop and resume Kin over RPC; members may read the state", () =>
  Effect.gen(function* () {
    const { person, repo } = yield* seed;
    const clientFor = (
      handlers: Effect.Success<ReturnType<typeof makeKinHandlers>>,
      scopes: ReadonlyArray<AuthEnvironmentScope> = AuthStandardClientScopes,
    ) =>
      RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.merge(
            group.toLayer({ ...handlers, "server.probe": () => Effect.succeed({}) }),
            RpcAuthorization.layer(scopes),
          ),
        ),
      );
    const handlers = yield* makeKinHandlers(session);
    const client = yield* clientFor(handlers);
    const input = { orgId: person.orgId };
    const paused = yield* client["kin.org.pause"]({ ...input, reason: "Going offline" });
    assert.include(paused, { paused: true, pausedBy: person.personId, reason: "Going offline" });
    assert.deepStrictEqual(yield* client["kin.org.pause"](input), paused);
    assert.deepStrictEqual(yield* client["kin.org.get"](input), paused);
    assert.include(
      yield* client["kin.org.pause"]({ orgId: KinOrgId.make("foreign") }).pipe(Effect.flip),
      { reason: "not_found" },
    );

    const memberId = KinPersonId.make("stop-member");
    yield* repo.insertPerson({
      orgId: person.orgId,
      personId: memberId,
      handle: "stop-member",
      displayName: "Member",
      githubLogin: null,
      createdAt: "1970-01-01T00:00:00.000Z",
    });
    const kin = yield* Kin.KinServer;
    const services = Option.getOrThrow(kin.services);
    const identity = Context.get(services, KinIdentity);
    const memberHandlers = yield* makeKinHandlers(session).pipe(
      Effect.provideService(Kin.KinServer, {
        ...kin,
        services: Option.some(
          Context.add(services, KinIdentity, {
            ...identity,
            resolve: () =>
              Effect.succeed([{ _tag: "person", orgId: person.orgId, personId: memberId }]),
          }),
        ),
      }),
    );
    const member = yield* clientFor(memberHandlers);
    // The owner's own words for why stay his.
    assert.deepStrictEqual(yield* member["kin.org.get"](input), { ...paused, reason: null });
    // QA Q15: a teammate's session holds only kin:chat, and still sees the switch and the zone.
    const teammate = yield* clientFor(memberHandlers, [AuthKinChatScope]);
    assert.deepStrictEqual(yield* teammate["kin.org.get"](input), { ...paused, reason: null });
    assert.deepStrictEqual(yield* teammate["kin.triggers.getTimeZone"](input), {
      ...input,
      timeZone: "UTC",
    });
    // The budget's amounts stay with the owner's settings.
    assert.strictEqual(
      (yield* teammate["kin.budget.get"](input).pipe(Effect.flip))._tag,
      "EnvironmentAuthorizationError",
    );
    assert.include(yield* member["kin.org.resume"](input).pipe(Effect.flip), {
      reason: "not_allowed",
    });
    assert.include(yield* member["kin.org.pause"](input).pipe(Effect.flip), {
      reason: "not_allowed",
    });
    const readOnly = yield* clientFor(handlers, [AuthOrchestrationReadScope]);
    // Reading the switch is Kin's chat scope now: a session without it sees no Kin at all.
    for (const method of ["kin.org.pause", "kin.org.resume", "kin.org.get"] as const)
      assert.strictEqual(
        (yield* readOnly[method](input).pipe(Effect.flip))._tag,
        "EnvironmentAuthorizationError",
      );

    const resumed = yield* client["kin.org.resume"](input);
    assert.isFalse(resumed.paused);
    assert.deepStrictEqual(yield* client["kin.org.resume"](input), resumed);
  }).pipe(Effect.provide(root.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

it.effect("creates many leads over RPC for the owner only, through the CLI's create", () =>
  Effect.gen(function* () {
    const { person, repo } = yield* seed;
    const clientFor = (
      handlers: Effect.Success<ReturnType<typeof makeKinHandlers>>,
      scopes: ReadonlyArray<AuthEnvironmentScope> = AuthStandardClientScopes,
    ) =>
      RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.merge(
            group.toLayer({ ...handlers, "server.probe": () => Effect.succeed({}) }),
            RpcAuthorization.layer(scopes),
          ),
        ),
      );
    const settings = ServerSettings.layerTest();
    const handlers = yield* makeKinHandlers(session).pipe(Effect.provide(settings));
    const client = yield* clientFor(handlers);
    const claude = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-4-6" };
    const input = {
      orgId: person.orgId,
      name: "Growth",
      domain: "growth",
      charter: "Grow signups.",
      models: { strong: claude, cheap: claude },
    };
    const growth = yield* client["kin.lead.create"](input);
    assert.include(growth, {
      outcome: "created",
      domain: "growth",
      level: "L0",
      createdByPersonId: person.personId,
    });
    // The third lead copies the first lead's models.
    const { models: _models, ...noModels } = input;
    const social = yield* client["kin.lead.create"]({
      ...noModels,
      name: "Social",
      domain: "social-media",
    });
    assert.strictEqual(social.outcome, "created");
    assert.notStrictEqual(social.ownerChatId, growth.ownerChatId);
    assert.deepStrictEqual(yield* client["kin.lead.create"](input), {
      ...growth,
      outcome: "existing",
    });
    assert.include(
      yield* client["kin.lead.create"]({ ...input, orgId: KinOrgId.make("foreign") }).pipe(
        Effect.flip,
      ),
      { reason: "not_allowed" },
    );

    // A member's session is refused by the service, and a session without the settings grant
    // never reaches it.
    const memberId = KinPersonId.make("lead-member");
    yield* repo.insertPerson({
      orgId: person.orgId,
      personId: memberId,
      handle: "lead-member",
      displayName: "Member",
      githubLogin: null,
      createdAt: "1970-01-01T00:00:00.000Z",
    });
    const kin = yield* Kin.KinServer;
    const services = Option.getOrThrow(kin.services);
    const identity = Context.get(services, KinIdentity);
    const member = yield* clientFor(
      yield* makeKinHandlers(session).pipe(
        Effect.provide(settings),
        Effect.provideService(Kin.KinServer, {
          ...kin,
          services: Option.some(
            Context.add(services, KinIdentity, {
              ...identity,
              resolve: () =>
                Effect.succeed([{ _tag: "person", orgId: person.orgId, personId: memberId }]),
            }),
          ),
        }),
      ),
    );
    assert.include(
      yield* member["kin.lead.create"]({ ...input, domain: "finance" }).pipe(Effect.flip),
      { reason: "not_allowed" },
    );
    const operator = yield* clientFor(handlers, [
      AuthOrchestrationReadScope,
      AuthOrchestrationOperateScope,
    ]);
    assert.strictEqual(
      (yield* operator["kin.lead.create"]({ ...input, domain: "finance" }).pipe(Effect.flip))._tag,
      "EnvironmentAuthorizationError",
    );

    // The owner lists their leads and edits one; a member sees none and edits none.
    const org = { orgId: person.orgId };
    const listed = (yield* client["kin.leads.list"](org)).leads;
    // Both were created in the same instant, so their order is the ids'.
    assert.sameDeepMembers(
      listed.map(({ agentId, name, ownerChatId }) => ({ agentId, name, ownerChatId })),
      [growth, social].map(({ agentId, name, ownerChatId }) => ({ agentId, name, ownerChatId })),
    );
    // Leads are part of the chat list, so a session that can't chat can't list them.
    assert.strictEqual(
      (yield* operator["kin.leads.list"](org).pipe(Effect.flip))._tag,
      "EnvironmentAuthorizationError",
    );
    assert.deepStrictEqual(yield* member["kin.leads.list"](org), { leads: [], contacts: [] });
    assert.deepStrictEqual(yield* client["kin.leads.list"]({ orgId: KinOrgId.make("foreign") }), {
      leads: [],
      contacts: [],
    });
    const edit = { ...org, agentId: growth.agentId, charter: "Grow paid signups." };
    assert.deepStrictEqual(yield* client["kin.lead.update"](edit), {
      ...listed.find((lead) => lead.agentId === growth.agentId)!,
      charter: "Grow paid signups.",
    });
    assert.include(yield* member["kin.lead.update"](edit).pipe(Effect.flip), {
      reason: "not_allowed",
    });
    assert.strictEqual(
      (yield* operator["kin.lead.update"](edit).pipe(Effect.flip))._tag,
      "EnvironmentAuthorizationError",
    );
    assert.include(
      yield* client["kin.lead.update"]({ ...edit, orgId: KinOrgId.make("foreign") }).pipe(
        Effect.flip,
      ),
      { reason: "not_found" },
    );
    const sql = yield* SqlClient.SqlClient;
    assert.deepStrictEqual(
      yield* sql`SELECT domain FROM kin_leads WHERE org_id = ${person.orgId} ORDER BY domain`,
      [{ domain: "growth" }, { domain: "social-media" }],
    );

    // Retiring and restoring are the owner's: a member reads the agent as not there, and a
    // session without the settings grant (a chat-only one included) never reaches the service.
    const target = { ...org, agentId: social.agentId };
    assert.include(yield* member["kin.lead.retire"](target).pipe(Effect.flip), {
      reason: "not_found",
    });
    const chatOnly = yield* clientFor(handlers, [AuthKinChatScope]);
    for (const caller of [operator, chatOnly])
      for (const method of ["kin.lead.retire", "kin.lead.restore"] as const)
        assert.strictEqual(
          (yield* caller[method](target).pipe(Effect.flip))._tag,
          "EnvironmentAuthorizationError",
        );
    const retired = yield* client["kin.lead.retire"](target);
    assert.strictEqual(retired.retired?.byPersonId, person.personId);
    assert.deepStrictEqual(
      (yield* client["kin.leads.list"](org)).leads.map((lead) => lead.agentId),
      [growth.agentId],
    );
    assert.deepStrictEqual(
      (yield* client["kin.leads.list"]({ ...org, includeRetired: true })).leads.map((lead) => [
        lead.agentId,
        lead.retired !== undefined,
      ]),
      [
        [growth.agentId, false],
        [social.agentId, true],
      ],
    );
    // The owner's last agent stays.
    assert.include(
      yield* client["kin.lead.retire"]({ ...org, agentId: growth.agentId }).pipe(Effect.flip),
      { reason: "invalid_state" },
    );
    assert.include(yield* member["kin.lead.restore"](target).pipe(Effect.flip), {
      reason: "not_found",
    });
    assert.isUndefined((yield* client["kin.lead.restore"](target)).retired);
  }).pipe(Effect.provide(root.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

it.effect(
  "a teammate's chat-only session messages only the leads the owner allowed, in a chat outside the owner's list",
  () =>
    Effect.gen(function* () {
      const { person, repo, direct } = yield* seed;
      const settings = ServerSettings.layerTest();
      const kin = yield* Kin.KinServer;
      const services = Option.getOrThrow(kin.services);
      const identity = Context.get(services, KinIdentity);
      const clientFor = (
        scopes: ReadonlyArray<AuthEnvironmentScope>,
        as?: { readonly personId: KinPersonId },
      ) =>
        makeKinHandlers(session).pipe(
          Effect.provide(settings),
          Effect.provideService(Kin.KinServer, {
            ...kin,
            services: Option.some(
              as === undefined
                ? services
                : Context.add(services, KinIdentity, {
                    ...identity,
                    resolve: () => Effect.succeed([{ _tag: "person", orgId: person.orgId, ...as }]),
                  }),
            ),
          }),
          Effect.flatMap((handlers) =>
            RpcTest.makeClient(group).pipe(
              Effect.provide(
                Layer.merge(
                  group.toLayer({ ...handlers, "server.probe": () => Effect.succeed({}) }),
                  RpcAuthorization.layer(scopes),
                ),
              ),
            ),
          ),
        );
      const owner = yield* clientFor(AuthStandardClientScopes);
      const people = [KinPersonId.make("priya"), KinPersonId.make("sam")] as const;
      for (const personId of people)
        yield* repo.insertPerson({
          orgId: person.orgId,
          personId,
          handle: personId,
          displayName: personId === "priya" ? "Priya" : "Sam",
          githubLogin: null,
          createdAt: "1970-01-01T00:00:00.000Z",
        });
      const [priyaId, samId] = people;
      const priya = yield* clientFor([AuthKinChatScope], { personId: priyaId });
      const sam = yield* clientFor([AuthKinChatScope], { personId: samId });
      const claude = {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      };
      const make = (name: string, domain: string) =>
        owner["kin.lead.create"]({
          orgId: person.orgId,
          name,
          domain,
          charter: `Private to the owner: ${name}.`,
          intro: `${name} questions.`,
          models: { strong: claude, cheap: claude },
        });
      const finance = yield* make("Finance", "finance");
      const growth = yield* make("Growth", "growth");
      const org = { orgId: person.orgId };
      const lead = { ...org, agentId: finance.agentId };
      const send = (
        client: typeof priya,
        chatId: KinChatId,
        clientMessageId: string,
        body = "Is the invoice out?",
      ) => client["kin.messages.send"]({ chatId, clientMessageId, body });
      const page = (client: typeof priya, chatId: KinChatId) =>
        client["kin.chat.history"]({ chatId, beforeSeq: 1000, limit: 50 });

      // Who may message a lead is the owner's to read and change: a teammate's session never
      // reaches the service, whichever lead or person it names.
      const refused = <A>(attempt: Effect.Effect<A, { readonly _tag: string }>) =>
        attempt.pipe(
          Effect.flip,
          Effect.map((error) => error._tag),
        );
      const unauthorized = "EnvironmentAuthorizationError";
      assert.strictEqual(yield* refused(priya["kin.lead.access.list"](lead)), unauthorized);
      assert.strictEqual(
        yield* refused(priya["kin.lead.access.grant"]({ ...lead, personId: priyaId })),
        unauthorized,
      );
      assert.strictEqual(
        yield* refused(priya["kin.lead.access.revoke"]({ ...lead, personId: samId })),
        unauthorized,
      );
      assert.strictEqual(
        yield* refused(priya["kin.lead.update"]({ ...lead, intro: "Mine now." })),
        unauthorized,
      );
      // Nothing is hers until the owner says so.
      assert.deepStrictEqual(yield* priya["kin.leads.list"](org), { leads: [], contacts: [] });
      assert.include(yield* priya["kin.chats.createDirect"](lead).pipe(Effect.flip), {
        reason: "not_allowed",
      });

      assert.strictEqual(
        (yield* owner["kin.leads.list"](org)).leads.find((held) => held.agentId === finance.agentId)
          ?.intro,
        "Finance questions.",
      );
      yield* owner["kin.lead.update"]({ ...lead, intro: "Handles invoices." });
      assert.deepStrictEqual(
        (yield* owner["kin.lead.access.grant"]({ ...lead, personId: priyaId })).people.map(
          ({ personId, displayName }) => ({ personId, displayName }),
        ),
        [{ personId: priyaId, displayName: "Priya" }],
      );
      const chat = yield* priya["kin.chats.createDirect"](lead);
      // All she is told about it: no charter, domain, model or work, and none of the owner's leads.
      // She is told whose workspace it is, since that person can see the chat.
      assert.deepStrictEqual(yield* priya["kin.leads.list"](org), {
        leads: [],
        contacts: [
          {
            ...lead,
            name: "Finance",
            intro: "Handles invoices.",
            chatId: chat.chatId,
            ownerName: "Owner",
          },
        ],
      });
      assert.strictEqual((yield* priya["kin.chats.createDirect"](lead)).chatId, chat.chatId);
      yield* send(priya, chat.chatId, "hers-1");
      assert.lengthOf((yield* page(priya, chat.chatId)).messages, 1);

      // Her access is to that lead, in her own chat: not another lead, the owner's chats with
      // either, or someone else's chat.
      for (const attempt of [
        priya["kin.chats.createDirect"]({ ...org, agentId: growth.agentId }),
        priya["kin.chats.createDirect"]({ ...org, agentId: KinAgentId.make("lead") }),
      ])
        assert.include(yield* attempt.pipe(Effect.flip), { reason: "not_allowed" });
      for (const chatId of [finance.ownerChatId, growth.ownerChatId, direct.chatId]) {
        assert.include(yield* page(priya, chatId).pipe(Effect.flip), { reason: "not_found" });
        assert.include(yield* send(priya, chatId, `into-${chatId}`).pipe(Effect.flip), {
          reason: "not_found",
        });
        assert.include(
          yield* priya["kin.chat.subscribe"]({ chatId }).pipe(Stream.runHead, Effect.flip),
          { reason: "not_found" },
        );
      }
      // Sam was not allowed, and Priya's chat is not his.
      assert.include(yield* sam["kin.chats.createDirect"](lead).pipe(Effect.flip), {
        reason: "not_allowed",
      });
      assert.include(yield* page(sam, chat.chatId).pipe(Effect.flip), { reason: "not_found" });
      // Nor is it in the owner's Kin chats, though the owner can still see it on the machine.
      assert.include(yield* page(owner, chat.chatId).pipe(Effect.flip), { reason: "not_found" });
      assert.include(yield* send(owner, chat.chatId, "owner-in").pipe(Effect.flip), {
        reason: "not_found",
      });
      assert.lengthOf((yield* owner["kin.lead.access.list"](lead)).people, 1);

      // Taken away: she reads what was said and can add nothing, and can't start over.
      assert.deepStrictEqual(
        yield* owner["kin.lead.access.revoke"]({ ...lead, personId: priyaId }),
        {
          people: [],
        },
      );
      assert.include(yield* send(priya, chat.chatId, "hers-2").pipe(Effect.flip), {
        reason: "not_allowed",
      });
      assert.include(yield* priya["kin.chats.createDirect"](lead).pipe(Effect.flip), {
        reason: "not_allowed",
      });
      assert.lengthOf((yield* page(priya, chat.chatId)).messages, 1);
      assert.deepStrictEqual(yield* priya["kin.leads.list"](org), { leads: [], contacts: [] });
      // Allowed again: the same chat.
      yield* owner["kin.lead.access.grant"]({ ...lead, personId: priyaId });
      yield* send(priya, chat.chatId, "hers-3");
      assert.strictEqual((yield* priya["kin.leads.list"](org)).contacts?.[0]?.chatId, chat.chatId);
    }).pipe(Effect.provide(root.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

it.effect("replays offline edits, deletions and widget revisions once with afterChangeSeq", () =>
  Effect.gen(function* () {
    const { chat, repo, person, direct } = yield* seed;
    const sql = yield* SqlClient.SqlClient;
    const old = yield* chat.send(person, {
      chatId: direct.chatId,
      body: "Old",
      clientMessageId: "old",
    });
    const removed = yield* chat.send(person, {
      chatId: direct.chatId,
      body: "Remove",
      clientMessageId: "remove",
    });
    const latest = yield* chat.send(person, {
      chatId: direct.chatId,
      body: "Latest",
      clientMessageId: "latest",
    });
    const widgetId = KinWidgetId.make("offline-widget");
    yield* repo.insertWidget({
      audience: "chat",
      ...person,
      chatId: direct.chatId,
      messageId: old.messageId,
      widgetId,
      widgetClass: "native",
      type: "task",
      state: {},
      source: null,
      feed: null,
      awaiting: [],
      pinnedAt: null,
      closedAt: null,
      updatedAt: direct.createdAt,
    });
    const baseline = Option.getOrThrow(
      yield* Stream.runHead(
        chat.subscribe(person, { chatId: direct.chatId, afterSeq: latest.seq }),
      ),
    );
    assert.strictEqual(baseline._tag, "backlog");
    if (baseline._tag !== "backlog") return;
    yield* sql`UPDATE kin_messages SET body = 'Edited', edited_at = '1970-01-01T00:00:01.000Z' WHERE org_id = ${person.orgId} AND message_id = ${old.messageId}`;
    yield* sql`UPDATE kin_messages SET body = '', status = 'deleted' WHERE org_id = ${person.orgId} AND message_id = ${removed.messageId}`;
    yield* sql`UPDATE kin_widgets SET revision = 2 WHERE org_id = ${person.orgId} AND widget_id = ${widgetId}`;
    const event = Option.getOrThrow(
      yield* Stream.runHead(
        chat.subscribe(person, {
          chatId: direct.chatId,
          afterSeq: latest.seq,
          afterChangeSeq: baseline.lastChangeSeq,
        }),
      ),
    );
    const legacy = Option.getOrThrow(
      yield* Stream.runHead(
        chat.subscribe(person, { chatId: direct.chatId, afterSeq: latest.seq }),
      ),
    );
    assert.include(legacy, { _tag: "backlog" });
    if (legacy._tag === "backlog")
      assert.deepStrictEqual([legacy.messages, legacy.widgets], [[], []]);
    assert.strictEqual(event._tag, "backlog");
    if (event._tag !== "backlog") return;
    assert.deepStrictEqual(
      event.messages.map((m) => [m.messageId, m.body, m.status]),
      [
        [old.messageId, "Edited", "posted"],
        [removed.messageId, "", "deleted"],
      ],
    );
    assert.deepStrictEqual(
      event.widgets.map((w) => [w.widgetId, w.revision]),
      [[widgetId, 2]],
    );
    assert.strictEqual(new Set(event.messages.map((m) => m.messageId)).size, event.messages.length);
    assert.isDefined(event.lastChangeSeq);
    const cursor = {
      chatId: direct.chatId,
      afterSeq: event.lastSeq,
      afterChangeSeq: event.lastChangeSeq,
    };
    const unchanged = Option.getOrThrow(yield* Stream.runHead(chat.subscribe(person, cursor)));
    assert.include(unchanged, { _tag: "backlog" });
    if (unchanged._tag === "backlog")
      assert.deepStrictEqual([unchanged.messages, unchanged.widgets], [[], []]);
    yield* sql`UPDATE kin_widgets SET revision = 3 WHERE org_id = ${person.orgId} AND widget_id = ${widgetId}`;
    const changed = Option.getOrThrow(yield* Stream.runHead(chat.subscribe(person, cursor)));
    assert.strictEqual(changed._tag, "backlog");
    if (changed._tag === "backlog") {
      assert.deepStrictEqual(
        changed.messages.map((m) => m.messageId),
        [old.messageId],
      );
      assert.deepStrictEqual(
        changed.widgets.map((w) => w.revision),
        [3],
      );
    }
  }).pipe(Effect.provide(root.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

it.effect("maps a real persistence failure to retryable unavailable and preserves refusals", () =>
  Effect.gen(function* () {
    const { direct } = yield* seed;
    const handlers = yield* makeKinHandlers(session);
    assert.include(
      yield* handlers["kin.chat.history"]({
        chatId: KinChatId.make("missing"),
        beforeSeq: 100,
        limit: 10,
      }).pipe(Effect.flip),
      { reason: "not_found" },
    );
    const kin = yield* Kin.KinServer;
    const services = Option.getOrThrow(kin.services);
    const identity = Context.get(services, KinIdentity);
    const broken = yield* makeKinHandlers(session).pipe(
      Effect.provideService(Kin.KinServer, {
        ...kin,
        services: Option.some(
          Context.add(services, KinIdentity, {
            ...identity,
            resolve: () => Effect.die("identity defect"),
          }),
        ),
      }),
    );
    assert.include(yield* broken["kin.orgs.list"]().pipe(Effect.flip), { reason: "unavailable" });
    assert.include(
      yield* Stream.runHead(broken["kin.chat.subscribe"]({ chatId: direct.chatId })).pipe(
        Effect.flip,
      ),
      { reason: "unavailable" },
    );
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DROP TABLE kin_widgets`;
    yield* sql`DROP TABLE kin_messages`;
    assert.include(
      yield* handlers["kin.chat.history"]({
        chatId: direct.chatId,
        beforeSeq: 100,
        limit: 10,
      }).pipe(Effect.flip),
      { reason: "unavailable" },
    );
  }).pipe(Effect.provide(root.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

it.effect("exposes a send id only to its author in live, backlog, history and summaries", () =>
  Effect.gen(function* () {
    const { chat, repo, person, direct } = yield* seed;
    const other = { ...person, personId: KinPersonId.make("second-viewer") };
    yield* repo.insertPerson({
      ...other,
      handle: "second",
      displayName: "Second",
      githubLogin: null,
      createdAt: direct.createdAt,
    });
    yield* repo.addMember({
      ...direct,
      memberId: KinMemberId.make("second-member"),
      principal: other,
      role: "member",
      joinedAt: direct.createdAt,
      leftAt: null,
      mutedUntil: null,
    });
    const ownEvents = yield* Stream.toQueue(chat.subscribe(person, { chatId: direct.chatId }), {
      capacity: "unbounded",
    });
    const otherEvents = yield* Stream.toQueue(chat.subscribe(other, { chatId: direct.chatId }), {
      capacity: "unbounded",
    });
    yield* Queue.take(ownEvents);
    yield* Queue.take(otherEvents);
    const sent = yield* chat.send(person, {
      chatId: direct.chatId,
      body: "Hello",
      clientMessageId: "pending-bubble",
    });
    assert.strictEqual(sent.clientMessageId, "pending-bubble");
    for (const [viewer, events, expected] of [
      [person, ownEvents, "pending-bubble"],
      [other, otherEvents, undefined],
    ] as const) {
      const live = yield* Queue.take(events);
      assert.strictEqual(live._tag, "message");
      if (live._tag === "message") {
        assert.strictEqual(live.message.clientMessageId, expected);
        assert.strictEqual(Object.hasOwn(live.message, "clientMessageId"), expected !== undefined);
      }
      const history = yield* chat.history(viewer, {
        chatId: direct.chatId,
        beforeSeq: 100,
        limit: 10,
      });
      assert.strictEqual(history.messages[0]?.clientMessageId, expected);
      const backlog = Option.getOrThrow(
        yield* Stream.runHead(chat.subscribe(viewer, { chatId: direct.chatId, afterSeq: 0 })),
      );
      if (backlog._tag !== "backlog") return assert.fail("Expected backlog");
      assert.strictEqual(backlog.messages[0]?.clientMessageId, expected);
      const list = Option.getOrThrow(yield* Stream.runHead(chat.subscribeChats([viewer], {})));
      if (list._tag !== "snapshot") return assert.fail("Expected snapshot");
      assert.strictEqual(list.chats[0]?.lastMessage?.clientMessageId, expected);
    }
    assert.strictEqual(
      (yield* chat.send(person, {
        chatId: direct.chatId,
        body: "Hello",
        clientMessageId: "pending-bubble",
      })).clientMessageId,
      "pending-bubble",
    );
  }).pipe(Effect.provide(root.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);
