import { EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import { subscribe, subscribeDynamic } from "@t3tools/client-runtime/rpc";
import { persistQuery } from "@t3tools/client-runtime/state/query-persistence";
import { queryPersistenceKey } from "@t3tools/client-runtime/state/runtime";
import {
  KIN_CHAT_WS_METHODS,
  KinChatError,
  type EnvironmentId,
  type KinChatHistoryInput,
  type KinChatHistoryResult,
  type KinChatId,
  type KinChatsSubscribeInput,
  type KinChatStreamEvent,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { removeKinCacheEntry, withKinCache } from "./kinCache";
import {
  applyKinChatEvent,
  applyKinChatHistory,
  applyKinInboxEvent,
  emptyKinChat,
  emptyKinInbox,
  KIN_CACHED_MESSAGE_LIMIT,
  KinChatState,
  KinInboxState,
  trimKinChatForCache,
  type KinChatClosedReason,
  type KinInboxEvent,
} from "./kinInboxModel";

/** A stream's folded state, seeded from the device cache until the host answers. */
export interface KinSynced<A> {
  readonly value: A;
  /** False while only the cache has been read. */
  readonly live: boolean;
  /** When the shown value was last saved or received, ISO time; null with no cache. */
  readonly savedAt: string | null;
}

export const KIN_INBOX_LABEL = "kin:inbox";
export const KIN_CHAT_LABEL = "kin:chat";
/** Streams save at most this often; the last change is flushed when the stream stops. */
export const KIN_CACHE_SAVE_INTERVAL = Duration.millis(1500);

const inboxCache = persistQuery(Schema.Struct({ inbox: KinInboxState, savedAt: Schema.String }));
const chatCache = persistQuery(Schema.Struct({ chat: KinChatState, savedAt: Schema.String }));

const isKinChatError = Schema.is(KinChatError);

/** `unavailable` is the host's only retryable Kin error; `disabled` waits for the next session. */
export const isKinRetryable = (error: unknown): boolean =>
  isKinChatError(error) && error.reason === "unavailable";
const isKinRefusal = (
  error: unknown,
): error is KinChatError & { readonly reason: KinChatClosedReason } =>
  isKinChatError(error) && error.reason !== "unavailable";

export const KIN_RETRY_BASE_DELAY = Duration.seconds(1);
export const KIN_RETRY_MAX_DELAY = Duration.seconds(30);

/** The wait before retry `attempt`, counting from 0: 1 s, doubling to 30 s. */
const kinRetryDelay = (attempt: number) =>
  Duration.min(Duration.times(KIN_RETRY_BASE_DELAY, 2 ** attempt), KIN_RETRY_MAX_DELAY);

/** Waits for the next connected session after the current one. */
const nextSession = EnvironmentSupervisor.EnvironmentSupervisor.pipe(
  Effect.flatMap((supervisor) =>
    SubscriptionRef.changes(supervisor.session).pipe(
      Stream.drop(1),
      Stream.filter(Option.isSome),
      Stream.runHead,
    ),
  ),
);

/** Sleeps `delay`, cut short by the next connected session. True when a session ended it. */
const sleepUntilNextSession = (delay: Duration.Duration) =>
  Effect.race(Effect.sleep(delay).pipe(Effect.as(false)), nextSession.pipe(Effect.as(true)));

const isKinDisabled = (error: unknown): error is KinChatError =>
  isKinChatError(error) && error.reason === "disabled";

/** The next change of session: the current one ended, replaced or not. */
const sessionEnded = EnvironmentSupervisor.EnvironmentSupervisor.pipe(
  Effect.flatMap((supervisor) =>
    SubscriptionRef.changes(supervisor.session).pipe(Stream.drop(1), Stream.runHead),
  ),
);

/**
 * Kin is turned off until the host restarts, so after `disabled` the stream shows `onDisabled`.
 * That answer holds only for its session: when the session ends the stream shows `onSessionEnd`,
 * then resubscribes on the next connected session instead of ending.
 */
function resubscribeWhenKinReturns<A, E, R>(
  stream: Stream.Stream<A, E, R>,
  onDisabled: Stream.Stream<A>,
  onSessionEnd: Stream.Stream<A>,
): Stream.Stream<A, E, R | EnvironmentSupervisor.EnvironmentSupervisor> {
  const run = (): Stream.Stream<A, E, R | EnvironmentSupervisor.EnvironmentSupervisor> =>
    stream.pipe(
      Stream.catchIf(isKinDisabled, () =>
        onDisabled.pipe(
          Stream.concat(
            Stream.fromEffect(sessionEnded).pipe(
              Stream.flatMap((next) =>
                onSessionEnd.pipe(
                  Stream.concat(
                    Option.exists(next, Option.isSome)
                      ? Stream.empty
                      : Stream.fromEffect(nextSession).pipe(Stream.drain),
                  ),
                ),
              ),
            ),
          ),
          Stream.concat(Stream.suspend(run)),
        ),
      ),
    );
  return run();
}

/**
 * Resubscribes after `unavailable`: 1 s, doubling to 30 s, starting over once events flow again
 * or a new session comes up.
 */
export function retryWhileKinUnavailable<A, E, R>(stream: Stream.Stream<A, E, R>) {
  let attempt = 0;
  const run = (): Stream.Stream<A, E, R | EnvironmentSupervisor.EnvironmentSupervisor> =>
    stream.pipe(
      Stream.onFirst(() =>
        Effect.sync(() => {
          attempt = 0;
        }),
      ),
      Stream.catchIf(isKinRetryable, () => {
        const delay = kinRetryDelay(attempt);
        attempt += 1;
        return Stream.fromEffect(
          sleepUntilNextSession(delay).pipe(
            Effect.map((newSession) => {
              if (newSession) attempt = 0;
            }),
          ),
        ).pipe(Stream.drain, Stream.concat(Stream.suspend(run)));
      }),
    );
  return Stream.suspend(run);
}

/**
 * Re-reads `kin.orgs.list` after `unavailable` with the streams' backoff, for a host known to be
 * Kin. Any other host, or a `disabled` answer, fails at once.
 */
export function retryKinProbe<A, E, R>(
  probe: Effect.Effect<A, E, R>,
  isKnownKin: () => boolean,
): Effect.Effect<A, E, R> {
  const run = (attempt: number): Effect.Effect<A, E, R> =>
    probe.pipe(
      Effect.catchIf(
        (error: E) => isKinRetryable(error) && isKnownKin(),
        () => Effect.sleep(kinRetryDelay(attempt)).pipe(Effect.andThen(run(attempt + 1))),
      ),
    );
  return run(0);
}

// The viewer's chat stream learns it left a chat; the list stream never says so.
const leftChatsByEnvironment = new Map<EnvironmentId, PubSub.PubSub<KinChatId>>();
function leftChats(environmentId: EnvironmentId): PubSub.PubSub<KinChatId> {
  let pubsub = leftChatsByEnvironment.get(environmentId);
  if (pubsub === undefined) {
    pubsub = Effect.runSync(PubSub.unbounded<KinChatId>());
    leftChatsByEnvironment.set(environmentId, pubsub);
  }
  return pubsub;
}

const currentEnvironmentId = EnvironmentSupervisor.EnvironmentSupervisor.pipe(
  Effect.map((supervisor) => supervisor.target.environmentId),
);

const nowIso = () => new Date().toISOString();

/** Keeps the latest value and saves it on an interval, then once more when the scope closes. */
const throttledSave = Effect.fnUntraced(function* <A, R>(
  save: (value: A) => Effect.Effect<void, never, R>,
) {
  let pending = Option.none<A>();
  const flush = Effect.suspend(() => {
    if (Option.isNone(pending)) return Effect.void;
    const value = pending.value;
    pending = Option.none();
    return save(value);
  });
  yield* Effect.addFinalizer(() => flush);
  yield* flush.pipe(Effect.delay(KIN_CACHE_SAVE_INTERVAL), Effect.forever, Effect.forkScoped);
  return {
    offer: (value: A) => {
      pending = Option.some(value);
    },
    discard: () => {
      pending = Option.none();
    },
  };
});

export function kinInboxStream(input: KinChatsSubscribeInput) {
  return Stream.unwrap(
    Effect.gen(function* () {
      const environmentId = yield* currentEnvironmentId;
      const key = queryPersistenceKey(KIN_INBOX_LABEL, input);
      const cached = yield* withKinCache(inboxCache.load(environmentId, key));
      let state = Option.match(cached, { onNone: () => emptyKinInbox, onSome: (c) => c.inbox });
      let live = false;
      const saver = yield* throttledSave((value: { inbox: KinInboxState; savedAt: string }) =>
        withKinCache(inboxCache.save(environmentId, key, value)),
      );
      const events: Stream.Stream<
        KinInboxEvent,
        unknown,
        EnvironmentSupervisor.EnvironmentSupervisor
      > = Stream.merge(
        resubscribeWhenKinReturns(
          retryWhileKinUnavailable(subscribe(KIN_CHAT_WS_METHODS.chatsSubscribe, input)),
          Stream.empty,
          Stream.empty,
        ),
        Stream.fromPubSub(leftChats(environmentId)).pipe(
          Stream.map((chatId) => ({ _tag: "left", chatId }) as const),
        ),
      );
      const updates = events.pipe(
        Stream.map((event): ReadonlyArray<KinSynced<KinInboxState>> => {
          const next = applyKinInboxEvent(state, event);
          if (next === state && live) return [];
          const savedAt = nowIso();
          if (next !== state) saver.offer({ inbox: next, savedAt });
          state = next;
          live = true;
          return [{ value: next, live: true, savedAt }];
        }),
        Stream.flattenIterable,
      );
      return Option.match(cached, {
        onNone: () => updates,
        onSome: (c) =>
          Stream.succeed<KinSynced<KinInboxState>>({
            value: c.inbox,
            live: false,
            savedAt: c.savedAt,
          }).pipe(Stream.concat(updates)),
      });
    }),
  );
}

/** Reads one page of `kin.chat.history`; the client wires in its scope-checked command. */
export type KinReadHistory<E, R> = (
  input: KinChatHistoryInput,
) => Effect.Effect<KinChatHistoryResult, E, R>;

export function makeKinChatStream<E, R>(readHistory: KinReadHistory<E, R>) {
  return (input: { readonly chatId: KinChatId }) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const environmentId = yield* currentEnvironmentId;
        const key = queryPersistenceKey(KIN_CHAT_LABEL, input);
        const cached = yield* withKinCache(chatCache.load(environmentId, key));
        let state = Option.match(cached, { onNone: () => emptyKinChat, onSome: (c) => c.chat });
        let live = false;
        let shownAt = Option.match(cached, { onNone: () => null, onSome: (c) => c.savedAt });
        let savedMessages = Option.exists(cached, (c) => c.chat.messages.length > 0);
        const saver = yield* throttledSave((value: { chat: KinChatState; savedAt: string }) =>
          withKinCache(chatCache.save(environmentId, key, value)),
        );
        const forget = Effect.suspend(() => {
          saver.discard();
          return withKinCache(removeKinCacheEntry(environmentId, key));
        });

        // Set while a `disabled` or session-ended view shows, so the next event shows live.
        let shownClosed = false;
        const step = (next: KinChatState): ReadonlyArray<KinSynced<KinChatState>> => {
          if (next === state && live && !shownClosed) return [];
          shownClosed = false;
          const savedAt = nowIso();
          shownAt = savedAt;
          if (next !== state) {
            const trimmed = trimKinChatForCache(next);
            // A reset empties the feed until history refills it; keep the cached messages.
            if (trimmed.messages.length > 0 || !savedMessages) {
              saver.offer({ chat: trimmed, savedAt });
              savedMessages = trimmed.messages.length > 0;
            }
          }
          state = next;
          live = true;
          return [{ value: next, live: true, savedAt }];
        };

        const onEvent = Effect.fnUntraced(function* (event: KinChatStreamEvent) {
          const views = [...step(applyKinChatEvent(state, event))];
          if (state.left) {
            yield* forget;
            yield* PubSub.publish(leftChats(environmentId), input.chatId);
            return views;
          }
          if (event._tag === "reset") {
            const page = yield* readHistory({
              chatId: input.chatId,
              beforeSeq: state.contiguousSeq + 1,
              limit: KIN_CACHED_MESSAGE_LIMIT,
            }).pipe(
              Effect.asSome,
              Effect.catchCause((cause) =>
                Effect.logWarning("Kin latest page reload after reset failed", cause).pipe(
                  Effect.as(Option.none<KinChatHistoryResult>()),
                ),
              ),
            );
            if (Option.isSome(page)) views.push(...step(applyKinChatHistory(state, page.value)));
          }
          return views;
        });

        const closedView = (reason: KinChatClosedReason): KinSynced<KinChatState> => ({
          value: { ...state, closed: reason },
          live: true,
          savedAt: nowIso(),
        });
        const subscription = retryWhileKinUnavailable(
          subscribeDynamic(KIN_CHAT_WS_METHODS.chatSubscribe, () =>
            Effect.sync(() =>
              state.contiguousSeq > 0 || state.messages.length > 0
                ? {
                    chatId: input.chatId,
                    afterSeq: state.contiguousSeq,
                    afterChangeSeq: state.changeSeq,
                  }
                : { chatId: input.chatId },
            ),
          ).pipe(Stream.mapEffect(onEvent), Stream.flattenIterable),
        );
        const updates = resubscribeWhenKinReturns(
          subscription,
          Stream.sync(() => {
            shownClosed = true;
            return closedView("disabled");
          }),
          // Kin may be back on the next session; show the feed as last received until it answers.
          Stream.sync(() => ({ value: state, live: false, savedAt: shownAt })),
        ).pipe(
          Stream.catchIf(isKinRefusal, (error) =>
            Stream.fromEffect(
              Effect.gen(function* () {
                if (error.reason === "not_found" || error.reason === "not_allowed") yield* forget;
                return closedView(error.reason);
              }),
            ),
          ),
          Stream.takeUntil(
            (view) =>
              view.value.left || (view.value.closed !== null && view.value.closed !== "disabled"),
          ),
        );
        return Option.match(cached, {
          onNone: () => updates,
          onSome: (c) =>
            Stream.succeed<KinSynced<KinChatState>>({
              value: state,
              live: false,
              savedAt: c.savedAt,
            }).pipe(Stream.concat(updates)),
        });
      }),
    );
}
