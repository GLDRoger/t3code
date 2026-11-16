import {
  type AuthSessionId,
  type KinChatId,
  KinPushError,
  type KinPushWatchBeat,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { KinChatRepository } from "../chat/KinChatRepository.ts";
import type { KinPushCaller } from "./KinPushDevices.ts";

/** A watcher not refreshed for this long no longer counts as on screen. */
const KIN_PUSH_PRESENCE_TTL = Duration.seconds(45);
const KIN_PUSH_BEAT_INTERVAL = Duration.seconds(15);

/**
 * Which sessions have a chat open right now. Upstream owns the phone's foreground handler,
 * so the server skips a push for a chat the device is already showing (mobile spec, correction 8).
 */
export class KinPushPresence extends Context.Service<
  KinPushPresence,
  {
    /**
     * Marks the chat open for the session while the stream runs. Each pull refreshes the mark,
     * and the RPC server pulls only after the client acks the last beat, so a half-open socket
     * stops suppressing within the TTL whatever the chat's traffic. Slots are keyed by the
     * chat id, so only a chat the caller is still in gets one.
     */
    readonly watch: (
      caller: KinPushCaller,
      chatId: KinChatId,
    ) => Stream.Stream<KinPushWatchBeat, KinPushError>;
    readonly isWatching: (sessionId: AuthSessionId, chatId: KinChatId) => Effect.Effect<boolean>;
  }
>()("t3/kin/push/KinPushPresence") {}

/** Fails `not_member` unless one of the caller's people is still in the open chat. */
export type KinPushChatMember = (
  caller: KinPushCaller,
  chatId: KinChatId,
) => Effect.Effect<void, KinPushError>;

const notMember = new KinPushError({ reason: "not_member", message: "You aren't in this chat." });

const chatMember = Effect.gen(function* () {
  const chats = yield* KinChatRepository;
  const unavailable = (cause: unknown) =>
    Effect.logWarning("KinPushPresence.chatMember failed", cause).pipe(
      Effect.andThen(
        Effect.fail(
          new KinPushError({ reason: "unavailable", message: "Couldn't check the chat." }),
        ),
      ),
    );
  return Effect.fn("KinPushPresence.chatMember")(
    function* (caller: KinPushCaller, chatId: KinChatId) {
      for (const person of caller.people) {
        const chat = yield* chats.getChat({ orgId: person.orgId, chatId });
        if (Option.isNone(chat) || chat.value.archivedAt !== null) continue;
        const member = yield* chats.activeMember({
          orgId: person.orgId,
          chatId,
          principal: person,
        });
        if (Option.isSome(member)) return;
      }
      return yield* notMember;
    },
    Effect.catchTags({
      PersistenceSqlError: unavailable,
      PersistenceDecodeError: unavailable,
      KinChatError: unavailable,
    }),
  ) satisfies KinPushChatMember;
});

export const makeWith = (member: KinPushChatMember) =>
  Effect.sync(() => {
    type Watcher = { refreshedAt: number };
    const open = new Map<string, Set<Watcher>>();
    const slot = (sessionId: AuthSessionId, chatId: KinChatId) => `${sessionId}\u0000${chatId}`;
    const ttl = Duration.toMillis(KIN_PUSH_PRESENCE_TTL);

    const mark = Effect.fn("KinPushPresence.mark")(function* (key: string) {
      const watcher: Watcher = { refreshedAt: yield* Clock.currentTimeMillis };
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const watchers = open.get(key) ?? new Set();
          watchers.add(watcher);
          open.set(key, watchers);
        }),
        () =>
          Effect.sync(() => {
            const watchers = open.get(key);
            watchers?.delete(watcher);
            if (watchers?.size === 0) open.delete(key);
          }),
      );
      return watcher;
    });

    return KinPushPresence.of({
      watch: (caller, chatId) =>
        Stream.unwrap(
          Effect.andThen(member(caller, chatId), mark(slot(caller.session.sessionId, chatId))).pipe(
            Effect.map((watcher) =>
              // Refresh first, then wait: the refresh marks the moment the previous beat was acked.
              Stream.fromEffectRepeat(
                Clock.currentTimeMillis.pipe(
                  Effect.map((now) => {
                    watcher.refreshedAt = now;
                  }),
                  Effect.andThen(Effect.sleep(KIN_PUSH_BEAT_INTERVAL)),
                  Effect.as("beat" as const),
                ),
              ),
            ),
          ),
        ),
      isWatching: Effect.fn("KinPushPresence.isWatching")(function* (sessionId, chatId) {
        const watchers = open.get(slot(sessionId, chatId));
        if (watchers === undefined) return false;
        const now = yield* Clock.currentTimeMillis;
        for (const watcher of watchers) if (now - watcher.refreshedAt < ttl) return true;
        return false;
      }),
    });
  });

export const layer = Layer.effect(KinPushPresence, Effect.flatMap(chatMember, makeWith));
