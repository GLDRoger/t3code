import { assert, it } from "@effect/vitest";
import { AuthSessionId, AuthStandardClientScopes, KinAgentId, KinChatId } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Sqlite from "../../persistence/Sqlite.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import * as Repository from "../chat/KinChatRepository.ts";
import * as Chat from "../chat/layer.ts";
import { makeKinChatHandlers } from "../chat/rpcHandlers.ts";
import { dormantLeadDependencies } from "../lead/layer.testkit.ts";
import * as Kin from "../layer.ts";
import * as Presence from "./KinPushPresence.ts";

const sessionId = AuthSessionId.make("sess-phone");
const chatId = KinChatId.make("chat_team");

it.effect("counts a watcher only while its client keeps taking the stream", () =>
  Effect.gen(function* () {
    const presence = yield* Presence.KinPushPresence;
    const idleOpen = yield* Deferred.make<void>();
    // An idle chat on a live client: nothing to send, and the stream keeps being pulled.
    yield* Stream.fromEffect(Deferred.succeed(idleOpen, undefined)).pipe(
      Stream.concat(Stream.never),
      presence.watching(sessionId, chatId),
      Stream.runDrain,
      Effect.forkChild,
    );
    yield* Deferred.await(idleOpen);
    for (let minute = 0; minute < 10; minute += 1) yield* TestClock.adjust("1 minute");
    assert.isTrue(yield* presence.isWatching(sessionId, chatId));

    // A half-open client: it never acks the first event, so the server stops pulling.
    const stalledChat = KinChatId.make("chat_stalled");
    const received = yield* Deferred.make<void>();
    const ack = yield* Deferred.make<void>();
    yield* Stream.make("event").pipe(
      Stream.concat(Stream.never),
      presence.watching(sessionId, stalledChat),
      Stream.runForEach(() =>
        Deferred.succeed(received, undefined).pipe(Effect.andThen(Deferred.await(ack))),
      ),
      Effect.forkChild,
    );
    yield* Deferred.await(received);
    yield* TestClock.adjust("89 seconds");
    assert.isTrue(yield* presence.isWatching(sessionId, stalledChat));
    yield* TestClock.adjust("1 second");
    assert.isFalse(yield* presence.isWatching(sessionId, stalledChat));
  }).pipe(Effect.provide(Presence.layer)),
);

const session = {
  sessionId,
  subject: "phone",
  method: "browser-session-cookie" as const,
  scopes: AuthStandardClientScopes,
};
const root = Kin.layer.pipe(
  Layer.provide(dormantLeadDependencies),
  Layer.provideMerge(Chat.layer),
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
  Layer.provideMerge(Sqlite.layerMemory),
);

it.effect("marks the chat open for the subscribing session through the real handler", () =>
  Effect.gen(function* () {
    const person = (yield* (yield* KinIdentity).resolve(session))[0];
    assert.isDefined(person);
    const agentId = KinAgentId.make("lead");
    yield* (yield* Repository.KinChatRepository).insertAgent({
      ...person,
      agentId,
      ownerPersonId: person.personId,
      displayName: "Lead",
      role: "lead",
      createdAt: "1970-01-01T00:00:00.000Z",
    });
    const direct = yield* (yield* KinChatService).createDirect(person, { ...person, agentId });
    const services = Option.getOrThrow((yield* Kin.KinServer).services);
    const presence = Context.get(services, Presence.KinPushPresence);

    const handlers = yield* makeKinChatHandlers(session);
    const backlog = yield* Deferred.make<void>();
    const subscription = yield* handlers["kin.chat.subscribe"]({
      chatId: direct.chatId,
      afterSeq: 0,
    }).pipe(
      Stream.runForEach(() => Deferred.succeed(backlog, undefined)),
      Effect.forkChild,
    );
    yield* Deferred.await(backlog);
    assert.isTrue(yield* presence.isWatching(sessionId, direct.chatId));
    assert.isFalse(yield* presence.isWatching(AuthSessionId.make("sess-other"), direct.chatId));

    yield* Fiber.interrupt(subscription);
    assert.isFalse(yield* presence.isWatching(sessionId, direct.chatId));
  }).pipe(Effect.provide(root)),
);
