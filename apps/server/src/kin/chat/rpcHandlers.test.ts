import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Hub from "./KinChatHub.ts";
import * as Service from "./KinChatService.ts";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  AuthSessionId,
  AuthStandardClientScopes,
  KinAgentId,
  KinChatId,
  KinMessageId,
  KinChatRpcs,
  KinOrgId,
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
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcServer from "effect/rpc/RpcServer";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as FileSystem from "effect/FileSystem";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as RpcAuthorization from "../../auth/RpcAuthorization.ts";
import * as Kin from "../layer.ts";
import { KinIdentity } from "./KinIdentity.ts";
import { KinChatService } from "./KinChatService.ts";
import * as Repository from "./KinChatRepository.ts";
import { makeKinChatHandlers } from "./rpcHandlers.ts";

const session = {
  sessionId: AuthSessionId.make("owner-session"),
  subject: "browser",
  method: "browser-session-cookie" as const,
  scopes: AuthStandardClientScopes,
};
const configured = ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }));
const root = Kin.layer.pipe(Layer.provide(configured));
const probe = WsRpcGroup.omit(
  ...[...WsRpcGroup.requests.keys()].filter(
    (
      tag,
    ): tag is Exclude<RpcGroup.Rpcs<typeof WsRpcGroup>["_tag"], typeof WS_METHODS.serverProbe> =>
      tag !== WS_METHODS.serverProbe,
  ),
);
const group = RpcGroup.make(...KinChatRpcs, ...probe.requests.values()).middleware(
  RpcScopeAuthorization,
);
const seed = Effect.gen(function* () {
  const kin = yield* Kin.KinServer;
  const context = Option.getOrThrow(kin.services);
  const identity = Context.get(context, KinIdentity);
  const chat = Context.get(context, KinChatService);
  const repo = Context.get(context, Repository.KinChatRepository);
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
    const { direct, repo, identity, person, context } = yield* seed;
    const threadId = ThreadId.make("registered-through-runner");
    yield* identity.registerAgentThread({ ...person, agentId: KinAgentId.make("lead"), threadId });
    const consumer = Context.get(context, KinIdentity);
    assert.isTrue(consumer.isAgentThread(threadId));
    const handlers = yield* makeKinChatHandlers(session);
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
    for (const chatId of [foreignChat, KinChatId.make("missing")]) {
      assert.include(
        yield* client["kin.chat.history"]({ chatId, beforeSeq: 100, limit: 100 }).pipe(Effect.flip),
        { reason: "not_found", message: "Kin record not found." },
      );
      assert.include(
        yield* Stream.runHead(client["kin.chat.subscribe"]({ chatId })).pipe(Effect.flip),
        { reason: "not_found" },
      );
      assert.include(
        yield* client["kin.messages.send"]({ chatId, body: "No", clientMessageId: "denied" }).pipe(
          Effect.flip,
        ),
        { reason: "not_found" },
      );
    }
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
        ...live,
        messageId: KinMessageId.make("delayed"),
        clientMessageId: { kind: "send", id: "delayed" },
      });
      const later = yield* repo.insertMessage({
        ...live,
        messageId: KinMessageId.make("later"),
        clientMessageId: { kind: "send", id: "later" },
      });
      yield* hub.publish({ type: "message.posted", orgId: person.orgId, message: later });
      yield* hub.publish({ type: "message.posted", orgId: person.orgId, message: delayed });
      assert.deepStrictEqual(yield* Queue.take(events), { _tag: "message", message: later });
      assert.deepStrictEqual(yield* Queue.take(events), { _tag: "message", message: delayed });
    }).pipe(Effect.provide(root.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

it.effect("keeps transport handlers out of persistence", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const source = yield* fs.readFileString(new URL("./rpcHandlers.ts", import.meta.url).pathname);
    assert.notMatch(source, /KinChatRepository|sql\/SqlClient/);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("resets large backlogs and bounds a resume to the current snapshot", () =>
  Effect.gen(function* () {
    const { chat, person, direct } = yield* seed;
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
      { _tag: "reset", lastSeq: 201 },
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
