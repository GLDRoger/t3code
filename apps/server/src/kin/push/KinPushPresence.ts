import type { AuthSessionId, KinChatId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

/**
 * Which sessions have a chat open right now. Upstream owns the phone's foreground handler,
 * so the server skips a push for a chat the device is already showing (mobile spec, correction 8).
 * The phone ends its chat stream when it leaves the foreground, so a live stream means "on screen".
 */
export class KinPushPresence extends Context.Service<
  KinPushPresence,
  {
    /** Marks the chat open for the session until the scope closes. */
    readonly watch: (
      sessionId: AuthSessionId,
      chatId: KinChatId,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly isWatching: (sessionId: AuthSessionId, chatId: KinChatId) => boolean;
  }
>()("t3/kin/push/KinPushPresence") {}

const make = Effect.sync(() => {
  const open = new Map<string, number>();
  const slot = (sessionId: AuthSessionId, chatId: KinChatId) => `${sessionId}\u0000${chatId}`;
  return KinPushPresence.of({
    watch: Effect.fn("KinPushPresence.watch")(function* (sessionId, chatId) {
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const key = slot(sessionId, chatId);
          open.set(key, (open.get(key) ?? 0) + 1);
          return key;
        }),
        (key) =>
          Effect.sync(() => {
            const left = (open.get(key) ?? 1) - 1;
            if (left > 0) open.set(key, left);
            else open.delete(key);
          }),
      );
    }),
    isWatching: (sessionId, chatId) => open.has(slot(sessionId, chatId)),
  });
});

export const layer = Layer.effect(KinPushPresence, make);
