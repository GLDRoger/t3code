import type { AuthSessionId, KinChatId, KinPushWatchBeat } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

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
     * stops suppressing within the TTL whatever the chat's traffic.
     */
    readonly watch: (
      sessionId: AuthSessionId,
      chatId: KinChatId,
    ) => Stream.Stream<KinPushWatchBeat>;
    readonly isWatching: (sessionId: AuthSessionId, chatId: KinChatId) => Effect.Effect<boolean>;
  }
>()("t3/kin/push/KinPushPresence") {}

const make = Effect.sync(() => {
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
    watch: (sessionId, chatId) =>
      Stream.unwrap(
        Effect.map(mark(slot(sessionId, chatId)), (watcher) =>
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
    isWatching: Effect.fn("KinPushPresence.isWatching")(function* (sessionId, chatId) {
      const watchers = open.get(slot(sessionId, chatId));
      if (watchers === undefined) return false;
      const now = yield* Clock.currentTimeMillis;
      for (const watcher of watchers) if (now - watcher.refreshedAt < ttl) return true;
      return false;
    }),
  });
});

export const layer = Layer.effect(KinPushPresence, make);
