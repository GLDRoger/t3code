import { EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import { subscribe, subscribeDynamic } from "@t3tools/client-runtime/rpc";
import { persistQuery } from "@t3tools/client-runtime/state/query-persistence";
import {
  createEnvironmentQueryAtomFamily,
  createEnvironmentRpcCommand,
  createEnvironmentSubscriptionAtomFamily,
  queryPersistenceKey,
} from "@t3tools/client-runtime/state/runtime";
import {
  KIN_CHAT_WS_METHODS,
  type EnvironmentId,
  type KinChatId,
  type KinChatsSubscribeInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { connectionAtomRuntime } from "../../../connection/runtime";
import {
  applyKinChatEvent,
  applyKinInboxEvent,
  emptyKinChat,
  emptyKinInbox,
  KinChatState,
  KinInboxState,
  trimKinChatForCache,
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

const INBOX_LABEL = "kin:inbox";
const CHAT_LABEL = "kin:chat";

const inboxCache = persistQuery(Schema.Struct({ inbox: KinInboxState, savedAt: Schema.String }));
const chatCache = persistQuery(Schema.Struct({ chat: KinChatState, savedAt: Schema.String }));

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

function inboxStream(input: KinChatsSubscribeInput) {
  return Stream.unwrap(
    Effect.gen(function* () {
      const environmentId = yield* currentEnvironmentId;
      const key = queryPersistenceKey(INBOX_LABEL, input);
      const cached = yield* inboxCache.load(environmentId, key);
      let state = Option.match(cached, { onNone: () => emptyKinInbox, onSome: (c) => c.inbox });
      const events: Stream.Stream<
        KinInboxEvent,
        unknown,
        EnvironmentSupervisor.EnvironmentSupervisor
      > = Stream.merge(
        subscribe(KIN_CHAT_WS_METHODS.chatsSubscribe, input),
        Stream.fromPubSub(leftChats(environmentId)).pipe(
          Stream.map((chatId) => ({ _tag: "left", chatId }) as const),
        ),
      );
      const live = events.pipe(
        Stream.mapEffect((event) => {
          const next = applyKinInboxEvent(state, event);
          const savedAt = nowIso();
          const view: KinSynced<KinInboxState> = { value: next, live: true, savedAt };
          if (next === state) return Effect.succeed(view);
          state = next;
          return inboxCache
            .save(environmentId, key, { inbox: next, savedAt })
            .pipe(Effect.as(view));
        }),
      );
      return Option.match(cached, {
        onNone: () => live,
        onSome: (c) =>
          Stream.succeed<KinSynced<KinInboxState>>({
            value: c.inbox,
            live: false,
            savedAt: c.savedAt,
          }).pipe(Stream.concat(live)),
      });
    }),
  );
}

function chatStream(input: { readonly chatId: KinChatId }) {
  return Stream.unwrap(
    Effect.gen(function* () {
      const environmentId = yield* currentEnvironmentId;
      const key = queryPersistenceKey(CHAT_LABEL, input);
      const cached = yield* chatCache.load(environmentId, key);
      // A cached feed may hold a stale reset or leave; the next backlog decides again.
      let state = Option.match(cached, {
        onNone: () => emptyKinChat,
        onSome: (c) => ({ ...c.chat, left: false }),
      });
      const holdsAny = () => state.contiguousSeq > 0 || state.messages.length > 0;
      // Every (re)subscription resumes after the highest contiguous seq held at that moment.
      const live = subscribeDynamic(KIN_CHAT_WS_METHODS.chatSubscribe, () =>
        Effect.sync(() =>
          holdsAny()
            ? { chatId: input.chatId, afterSeq: state.contiguousSeq }
            : { chatId: input.chatId },
        ),
      ).pipe(
        Stream.mapEffect(
          Effect.fnUntraced(function* (event) {
            const next = applyKinChatEvent(state, event);
            const savedAt = nowIso();
            if (next !== state) {
              state = next;
              yield* chatCache.save(environmentId, key, {
                chat: trimKinChatForCache(next),
                savedAt,
              });
            }
            if (event._tag === "member" && event.member.leftAt !== null) {
              yield* PubSub.publish(leftChats(environmentId), input.chatId);
            }
            return { value: next, live: true, savedAt } satisfies KinSynced<KinChatState>;
          }),
        ),
      );
      return Option.match(cached, {
        onNone: () => live,
        onSome: (c) =>
          Stream.succeed<KinSynced<KinChatState>>({
            value: state,
            live: false,
            savedAt: c.savedAt,
          }).pipe(Stream.concat(live)),
      });
    }),
  );
}

// Kin reads are client-guarded too, so they go through the command's scope check.
const orgsRead = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "kin:orgs:read",
  tag: KIN_CHAT_WS_METHODS.orgsList,
});
const historyRead = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "kin:history:read",
  tag: KIN_CHAT_WS_METHODS.chatHistory,
});

function guardedRead<Input, A, E>(command: {
  readonly run: (
    registry: AtomRegistry.AtomRegistry,
    target: { readonly environmentId: EnvironmentId; readonly input: Input },
  ) => Promise<AsyncResult.AsyncResult<A, E>>;
}) {
  return (input: Input) =>
    Effect.gen(function* () {
      const registry = yield* AtomRegistry.AtomRegistry;
      const environmentId = yield* currentEnvironmentId;
      const result = yield* Effect.promise(() => command.run(registry, { environmentId, input }));
      return yield* result._tag === "Success"
        ? Effect.succeed(result.value)
        : result._tag === "Failure"
          ? Effect.failCause(result.cause)
          : Effect.never;
    });
}

export const kinClient = {
  /** Orgs, their agents, and the viewer's person per org. An empty `me` means no identity. */
  orgs: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:orgs",
    execute: guardedRead(orgsRead),
    staleTimeMs: 60_000,
  }),
  /** Chat list plus Waiting on you. Reconnecting replaces it with the host's fresh snapshot. */
  inbox: createEnvironmentSubscriptionAtomFamily(connectionAtomRuntime, {
    label: INBOX_LABEL,
    subscribe: inboxStream,
  }),
  chat: createEnvironmentSubscriptionAtomFamily(connectionAtomRuntime, {
    label: CHAT_LABEL,
    subscribe: chatStream,
  }),
  history: createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:history",
    execute: guardedRead(historyRead),
    staleTimeMs: Number.POSITIVE_INFINITY,
  }),
  createDirect: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:create-direct",
    tag: KIN_CHAT_WS_METHODS.chatsCreateDirect,
  }),
  send: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:send",
    tag: KIN_CHAT_WS_METHODS.messagesSend,
    concurrency: { mode: "singleFlight", key: ({ input }) => input.clientMessageId },
  }),
  markRead: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:mark-read",
    tag: KIN_CHAT_WS_METHODS.messagesMarkRead,
  }),
  widgetAction: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:widget-action",
    tag: KIN_CHAT_WS_METHODS.widgetsAct,
    concurrency: { mode: "singleFlight", key: ({ input }) => input.clientActionId },
  }),
};
