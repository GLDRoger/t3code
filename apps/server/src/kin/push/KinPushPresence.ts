import type { AuthSessionId, KinChatId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

/** A watcher whose last beat is older than this no longer counts as on screen. */
const KIN_PUSH_PRESENCE_TTL = Duration.seconds(90);
const BEAT_INTERVAL = Duration.seconds(30);
const BEAT: unique symbol = Symbol("KinPushPresence.beat");

/**
 * Which sessions have a chat open right now. Upstream owns the phone's foreground handler,
 * so the server skips a push for a chat the device is already showing (mobile spec, correction 8).
 * The phone ends its chat stream when it leaves the foreground, so a live stream means "on screen".
 */
export class KinPushPresence extends Context.Service<
  KinPushPresence,
  {
    /**
     * Marks the chat open for the session while the stream runs. Beats travel through the
     * stream, and the RPC server pulls only after the client acks a chunk, so a half-open
     * socket stops refreshing once a chunk goes unacked.
     */
    readonly watching: (
      sessionId: AuthSessionId,
      chatId: KinChatId,
    ) => <A, E, R>(stream: Stream.Stream<A, E, R>) => Stream.Stream<A, E, R>;
    readonly isWatching: (sessionId: AuthSessionId, chatId: KinChatId) => Effect.Effect<boolean>;
  }
>()("t3/kin/push/KinPushPresence") {}

const make = Effect.sync(() => {
  type Watcher = { refreshedAt: number };
  const open = new Map<string, Set<Watcher>>();
  const slot = (sessionId: AuthSessionId, chatId: KinChatId) => `${sessionId}\u0000${chatId}`;
  const ttl = Duration.toMillis(KIN_PUSH_PRESENCE_TTL);

  const watch = Effect.fn("KinPushPresence.watch")(function* (key: string) {
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
    watching:
      (sessionId, chatId) =>
      <A, E, R>(stream: Stream.Stream<A, E, R>) =>
        Stream.unwrap(
          Effect.map(watch(slot(sessionId, chatId)), (watcher) =>
            stream.pipe(
              Stream.merge(Stream.tick(BEAT_INTERVAL).pipe(Stream.as(BEAT)), {
                haltStrategy: "left",
              }),
              Stream.tap((event) =>
                event === BEAT
                  ? Effect.map(Clock.currentTimeMillis, (now) => {
                      watcher.refreshedAt = now;
                    })
                  : Effect.void,
              ),
              Stream.filter((event): event is A => event !== BEAT),
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
