import {
  KinChatError,
  type KinAgentId,
  type KinAuthor,
  type KinReaction,
  type KinReactionEmoji,
  type KinChat,
  type KinChatId,
  type KinChatStreamEvent,
  type KinPresence,
  type KinMemberId,
  type KinChatMember,
  type KinMessage,
  type KinMessageId,
  type KinOrgId,
  type KinPersonId,
  type KinWaitingItem,
  type KinWakeupId,
  type KinWidget,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { withLinks } from "./messageLinks.ts";
import { messageForViewer } from "./messageView.ts";
import { memberReads } from "./sharing.ts";
import * as Repository from "./KinChatRepository.ts";
import type { AgentIdentity, PersonIdentity } from "./KinIdentity.ts";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

type ChatEvent =
  | { readonly type: "chat.created"; readonly chat: KinChat }
  | { readonly type: "message.posted"; readonly message: KinMessage }
  // A message already delivered reads differently now, such as its receipt after an Undo; nothing
  // new was said, so nothing rings or wakes on it.
  | { readonly type: "message.changed"; readonly message: KinMessage }
  | { readonly type: "widget.updated"; readonly widget: KinWidget }
  | { readonly type: "waiting.updated"; readonly item: KinWaitingItem }
  | { readonly type: "member.removed"; readonly member: KinChatMember }
  // Everything said in the chat was deleted; the cursors are the chat's after the clear.
  | {
      readonly type: "chat.cleared";
      readonly chatId: KinChatId;
      readonly lastSeq: number;
      readonly lastChangeSeq: number;
    }
  // A change to an active member's row, such as a mute; every member of the chat sees it.
  | { readonly type: "member.updated"; readonly chatId: KinChatId; readonly member: KinChatMember }
  | {
      readonly type: "read.updated";
      readonly chatId: KinChatId;
      readonly memberId: KinMemberId;
      readonly seq: number;
    }
  | {
      readonly type: "reaction.updated";
      readonly chatId: KinChatId;
      readonly reaction: KinReaction;
      // An owner's soft reply that should wake the lead; `by` is the reacting member. On a removed
      // reaction, `woke` withdraws a go-ahead; `changedFrom` is the emoji of the wake it reverses.
      readonly woke: boolean;
      readonly changedFrom?: KinReactionEmoji;
      readonly by: KinAuthor;
    }
  // Live only: never persisted, never in a checkpoint.
  | {
      readonly type: "presence.updated";
      readonly chatId: KinChatId;
      readonly agentId: KinAgentId;
      readonly presence: KinPresence | null;
    }
  | {
      readonly type: "draft.updated";
      readonly chatId: KinChatId;
      readonly draft: Omit<Extract<KinChatStreamEvent, { _tag: "draft" }>, "_tag">;
      // Server only. Text goes nowhere once its wake-up is aborted, checked as each viewer
      // takes it; `personId` limits a withheld draft's end to the one person who saw it.
      readonly wakeupId?: KinWakeupId;
      readonly personId?: KinPersonId;
    };
export type KinChatHubEvent = ChatEvent & { readonly orgId: KinOrgId };

export class KinChatHub extends Context.Service<
  KinChatHub,
  {
    readonly publish: (event: KinChatHubEvent) => Effect.Effect<void>;
    /** With `only`, events of that chat alone, dropped before anything is read for them. */
    readonly subscribeForViewer: (
      identity: PersonIdentity | AgentIdentity,
      only?: KinChatId,
    ) => Effect.Effect<
      Stream.Stream<KinChatHubEvent, Repository.RepositoryError>,
      never,
      Scope.Scope
    >;
    /**
     * One org's waiting changes, anyone's, unchecked: only for a server rule that decides what of
     * them a viewer may see (`KinChatRepository.getOwnersOpenWaiting`). Bounded as a screen is.
     */
    readonly subscribeWaiting: (
      orgId: KinOrgId,
    ) => Effect.Effect<Stream.Stream<KinWaitingItem, KinChatError>, never, Scope.Scope>;
    /** Every organization's committed events, unfiltered. Server consumers only, never a client. */
    readonly subscribeAll: Effect.Effect<Stream.Stream<KinChatHubEvent>, never, Scope.Scope>;
  }
>()("t3/kin/chat/KinChatHub") {}

/** Events one screen may have waiting; past this it ends `unavailable` and resumes from its cursor. */
export const KIN_CHAT_HUB_BACKLOG = 1_000;
/** At most this many waiting events are checked together, each read once for all of them. */
const BATCH = 128;
const behind = new KinChatError({
  reason: "unavailable",
  message: "Too many changes waiting. Resume from the last received number.",
});

const chatOf = (event: KinChatHubEvent) =>
  event.type === "chat.created"
    ? event.chat.chatId
    : event.type === "message.posted" || event.type === "message.changed"
      ? event.message.chatId
      : event.type === "widget.updated"
        ? event.widget.chatId
        : event.type === "waiting.updated"
          ? event.item.chatId
          : event.type === "member.removed"
            ? event.member.chatId
            : event.chatId;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* Repository.KinChatRepository;
  const screens = new Map<KinOrgId, Set<Queue.Queue<KinChatHubEvent, KinChatError>>>();
  let all: PubSub.PubSub<KinChatHubEvent> | undefined;
  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      [...screens.values()].flatMap((queues) => [...queues]),
      Queue.shutdown,
      { discard: true },
    ).pipe(Effect.andThen(all === undefined ? Effect.void : PubSub.shutdown(all))),
  );
  const offer = Effect.fn("KinChatHub.offer")(function* (
    queues: Set<Queue.Queue<KinChatHubEvent, KinChatError>>,
    queue: Queue.Queue<KinChatHubEvent, KinChatError>,
    event: KinChatHubEvent,
  ) {
    if (yield* Queue.offer(queue, event)) return;
    // Too far behind: what it held is dropped and it reads again from its own cursor.
    queues.delete(queue);
    yield* Queue.clear(queue).pipe(Effect.ignore);
    yield* Queue.fail(queue, behind);
  });
  return KinChatHub.of({
    publish: Effect.fn("KinChatHub.publish")(function (event) {
      return sql.afterCommit(
        Effect.gen(function* () {
          const queues = screens.get(event.orgId);
          if (queues !== undefined) for (const queue of queues) yield* offer(queues, queue, event);
          if (all !== undefined) yield* PubSub.publish(all, event);
        }),
      );
    }),
    subscribeAll: Effect.gen(function* () {
      if (all === undefined) {
        const created = yield* PubSub.unbounded<KinChatHubEvent>();
        all ??= created;
      }
      return Stream.fromEffectRepeat(PubSub.take(yield* PubSub.subscribe(all)));
    }).pipe(Effect.withSpan("KinChatHub.subscribeAll")),
    subscribeWaiting: Effect.fn("KinChatHub.subscribeWaiting")(function* (orgId) {
      const queue = yield* Queue.dropping<KinChatHubEvent, KinChatError>(KIN_CHAT_HUB_BACKLOG);
      const queues = screens.get(orgId) ?? new Set();
      screens.set(orgId, queues);
      queues.add(queue);
      yield* Effect.addFinalizer(() =>
        Effect.suspend(() => {
          queues.delete(queue);
          if (queues.size === 0 && screens.get(orgId) === queues) screens.delete(orgId);
          return Queue.shutdown(queue);
        }),
      );
      return Stream.fromQueue(queue).pipe(
        Stream.filterMap((event) =>
          event.type === "waiting.updated" ? Result.succeed(event.item) : Result.failVoid,
        ),
      );
    }),
    subscribeForViewer: Effect.fn("KinChatHub.subscribeForViewer")(function* (identity, only) {
      const queue = yield* Queue.dropping<KinChatHubEvent, KinChatError>(KIN_CHAT_HUB_BACKLOG);
      const queues = screens.get(identity.orgId) ?? new Set();
      screens.set(identity.orgId, queues);
      queues.add(queue);
      yield* Effect.addFinalizer(() =>
        Effect.suspend(() => {
          queues.delete(queue);
          if (queues.size === 0 && screens.get(identity.orgId) === queues)
            screens.delete(identity.orgId);
          return Queue.shutdown(queue);
        }),
      );
      /**
       * The events of one batch a viewer may have, each read once for the batch. Every event in
       * it was published before the batch was taken, so the reads are no older than any of them.
       */
      const deliverable = Effect.fn("KinChatHub.deliverable")(function* (
        batch: ReadonlyArray<KinChatHubEvent>,
      ) {
        const members = new Map<KinChatId, Option.Option<KinChatMember>>();
        const aborted = new Map<KinWakeupId, boolean>();
        const reads = new Map<string, boolean>();
        const messages = new Map<KinMessageId, Option.Option<KinMessage>>();
        const memberIn = Effect.fn("KinChatHub.memberIn")(function* (chatId: KinChatId) {
          const held = members.get(chatId);
          if (held !== undefined) return held;
          const read = yield* repo.activeMember({
            orgId: identity.orgId,
            chatId,
            principal: identity,
          });
          members.set(chatId, read);
          return read;
        });
        const canDeliver = Effect.fn("KinChatHub.canDeliver")(function* (event: KinChatHubEvent) {
          const chatId = chatOf(event);
          if (only !== undefined && chatId !== only) return false;
          if (event.type === "member.removed")
            return identity._tag === "person"
              ? event.member.principal._tag === "person" &&
                  event.member.principal.personId === identity.personId
              : event.member.principal._tag === "agent" &&
                  event.member.principal.agentId === identity.agentId;
          if (
            event.type === "waiting.updated" &&
            (identity._tag !== "person" || event.item.personId !== identity.personId)
          )
            return false;
          if (event.type === "waiting.updated" && event.item.resolvedAt !== null) return true;
          if (event.type === "draft.updated") {
            if (
              event.personId !== undefined &&
              (identity._tag !== "person" || identity.personId !== event.personId)
            )
              return false;
            // Read after the viewer's join committed, and the join aborts in the same commit.
            if (event.wakeupId !== undefined && event.draft.text !== "") {
              const wakeupId = event.wakeupId;
              const stopped =
                aborted.get(wakeupId) ??
                (yield* sql`SELECT 1 FROM kin_wakeups WHERE org_id = ${event.orgId}
                  AND wakeup_id = ${wakeupId} AND aborted_at IS NOT NULL LIMIT 1`.pipe(
                  Effect.orElseSucceed(() => [undefined]),
                )).length > 0;
              aborted.set(wakeupId, stopped);
              if (stopped) return false;
            }
          }
          const memberOption = yield* memberIn(chatId);
          if (Option.isNone(memberOption)) return false;
          const member = memberOption.value;
          // A person reads nothing from before they joined: no message, card, tap or reaction.
          const about =
            event.type === "message.posted" || event.type === "message.changed"
              ? event.message.messageId
              : event.type === "widget.updated"
                ? event.widget.messageId
                : event.type === "reaction.updated"
                  ? event.reaction.messageId
                  : event.type === "waiting.updated"
                    ? event.item.messageId
                    : null;
          if (identity._tag === "person" && about !== null) {
            const key = `${member.memberId}:${about}`;
            const readable =
              reads.get(key) ??
              (yield* memberReads(sql, {
                orgId: identity.orgId,
                memberId: member.memberId,
                messageId: about,
              }).pipe(Effect.orElseSucceed(() => false)));
            reads.set(key, readable);
            if (!readable) return false;
          }
          const messageId =
            event.type === "widget.updated"
              ? event.widget.messageId
              : event.type === "waiting.updated"
                ? event.item.messageId
                : null;
          const message =
            event.type === "message.posted" || event.type === "message.changed"
              ? Option.some(event.message)
              : messageId === null
                ? Option.none()
                : (messages.get(messageId) ??
                  (yield* repo.getMessage({ orgId: identity.orgId, messageId })));
          if (messageId !== null) messages.set(messageId, message);
          if (messageId !== null && Option.isNone(message)) return false;
          return (
            Option.isNone(message) ||
            !["suggested", "dismissed"].includes(message.value.status) ||
            member.role === "owner" ||
            (message.value.author._tag !== "system" &&
              message.value.author.memberId === member.memberId)
          );
        });
        return yield* Effect.filter(batch, canDeliver);
      });
      return Stream.fromEffectRepeat(Queue.takeBetween(queue, 1, BATCH)).pipe(
        Stream.mapEffect(deliverable),
        Stream.flattenIterable,
        // One event a chunk, as the chat stream's per-event state expects.
        Stream.rechunk(1),
        Stream.mapEffect((event): Effect.Effect<KinChatHubEvent> =>
          event.type === "message.posted" || event.type === "message.changed"
            ? withLinks(identity.orgId, identity, [messageForViewer(event.message, identity)]).pipe(
                Effect.provideService(SqlClient.SqlClient, sql),
                Effect.map(([message]): KinChatHubEvent => ({ ...event, message: message! })),
                // The words still arrive when the links can't be read; only the links are missing.
                Effect.orElseSucceed((): KinChatHubEvent => ({
                  ...event,
                  message: messageForViewer(event.message, identity),
                })),
              )
            : Effect.succeed(event),
        ),
      );
    }),
  });
});

export const layer = Layer.effect(KinChatHub, make);
