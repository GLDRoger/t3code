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

import { pairSession } from "../auth/ProofKeySessions.testkit.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import * as Repository from "../chat/KinChatRepository.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import * as Chat from "../chat/layer.ts";
import { dormantLeadDependencies } from "../lead/layer.testkit.ts";
import * as Kin from "../layer.ts";
import * as Presence from "./KinPushPresence.ts";
import { makeKinPushHandlers } from "./rpcHandlers.ts";

const sessionId = AuthSessionId.make("sess-phone");
const chatId = KinChatId.make("chat_team");

it.effect("counts a watcher only while its client keeps acking beats", () =>
  Effect.gen(function* () {
    const presence = yield* Presence.KinPushPresence;
    // A live client on an idle chat: it acks every beat, so the stream keeps being pulled.
    yield* presence
      .watch(sessionId, chatId)
      .pipe(Stream.runDrain, Effect.forkChild({ startImmediately: true }));

    // A half-open client: it takes the first beat and never acks it.
    const stalled = KinChatId.make("chat_stalled");
    const received = yield* Deferred.make<void>();
    yield* presence.watch(sessionId, stalled).pipe(
      Stream.runForEach(() =>
        Deferred.succeed(received, undefined).pipe(Effect.andThen(Effect.never)),
      ),
      Effect.forkChild({ startImmediately: true }),
    );
    assert.isTrue(yield* presence.isWatching(sessionId, stalled));
    yield* TestClock.adjust("15 seconds");
    yield* Deferred.await(received);
    // Its last refresh was when it opened, so it stops counting one TTL after that.
    yield* TestClock.adjust("29 seconds");
    assert.isTrue(yield* presence.isWatching(sessionId, stalled));
    yield* TestClock.adjust("1 second");
    assert.isFalse(yield* presence.isWatching(sessionId, stalled));

    for (let minute = 0; minute < 60; minute += 1) yield* TestClock.adjust("1 minute");
    assert.isTrue(yield* presence.isWatching(sessionId, chatId));
    assert.isFalse(yield* presence.isWatching(sessionId, stalled));
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

const seedDirect = Effect.gen(function* () {
  const services = Option.getOrThrow((yield* Kin.KinServer).services);
  const repo = Context.get(services, Repository.KinChatRepository);
  yield* pairSession(sessionId);
  const person = (yield* Context.get(services, KinIdentity).resolve(session))[0];
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
  const direct = yield* Context.get(services, KinChatService).createDirect(person, {
    ...person,
    agentId,
  });
  return { services, repo, direct };
});

it.effect("marks the chat open for the watching session through the real handler", () =>
  Effect.gen(function* () {
    const { services, direct } = yield* seedDirect;
    const chatId = direct.chatId;
    const presence = Context.get(services, Presence.KinPushPresence);
    const handlers = yield* makeKinPushHandlers(session);
    const beat = yield* Deferred.make<void>();
    const watch = yield* handlers["kin.push.watch"]({ chatId }).pipe(
      Stream.runForEach(() => Deferred.succeed(beat, undefined)),
      Effect.forkChild,
    );
    yield* TestClock.adjust("15 seconds");
    yield* Deferred.await(beat);
    assert.isTrue(yield* presence.isWatching(sessionId, chatId));
    assert.isFalse(yield* presence.isWatching(AuthSessionId.make("sess-other"), chatId));

    yield* Fiber.interrupt(watch);
    assert.isFalse(yield* presence.isWatching(sessionId, chatId));
  }).pipe(Effect.provide(root)),
);

it.effect("refuses to watch a chat the caller is not in", () =>
  Effect.gen(function* () {
    const { services, repo, direct } = yield* seedDirect;
    const presence = Context.get(services, Presence.KinPushPresence);
    const handlers = yield* makeKinPushHandlers(session);
    const strangers = KinChatId.make("chat_strangers");
    yield* repo.createChat({
      ...direct,
      chatId: strangers,
      kind: "project_group",
      directKey: null,
    });

    for (const chatId of [strangers, KinChatId.make("chat_missing")]) {
      const refused = yield* handlers["kin.push.watch"]({ chatId }).pipe(
        Stream.runDrain,
        Effect.flip,
      );
      assert.include(refused, { _tag: "KinPushError", reason: "not_member" });
      assert.isFalse(yield* presence.isWatching(sessionId, chatId));
    }
  }).pipe(Effect.provide(root)),
);
