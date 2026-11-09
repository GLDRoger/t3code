import type {
  KinAgentId,
  KinChat,
  KinChatId,
  KinChatStreamEvent,
  KinPresence,
  KinMemberId,
  KinChatMember,
  KinMessage,
  KinOrgId,
  KinWaitingItem,
  KinWidget,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { messageForViewer } from "./messageView.ts";
import * as Repository from "./KinChatRepository.ts";
import type { AgentIdentity, PersonIdentity } from "./KinIdentity.ts";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

type ChatEvent =
  | { readonly type: "chat.created"; readonly chat: KinChat }
  | { readonly type: "message.posted"; readonly message: KinMessage }
  | { readonly type: "widget.updated"; readonly widget: KinWidget }
  | { readonly type: "waiting.updated"; readonly item: KinWaitingItem }
  | { readonly type: "member.removed"; readonly member: KinChatMember }
  | {
      readonly type: "read.updated";
      readonly chatId: KinChatId;
      readonly memberId: KinMemberId;
      readonly seq: number;
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
    };
export type KinChatHubEvent = ChatEvent & { readonly orgId: KinOrgId };

export class KinChatHub extends Context.Service<
  KinChatHub,
  {
    readonly publish: (event: KinChatHubEvent) => Effect.Effect<void>;
    readonly subscribeForViewer: (
      identity: PersonIdentity | AgentIdentity,
    ) => Effect.Effect<
      Stream.Stream<KinChatHubEvent, Repository.RepositoryError>,
      never,
      Scope.Scope
    >;
    /** Every organization's committed events, unfiltered. Server consumers only, never a client. */
    readonly subscribeAll: Effect.Effect<Stream.Stream<KinChatHubEvent>, never, Scope.Scope>;
  }
>()("t3/kin/chat/KinChatHub") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* Repository.KinChatRepository;
  const hubs = new Map<KinOrgId, PubSub.PubSub<KinChatHubEvent>>();
  let all: PubSub.PubSub<KinChatHubEvent> | undefined;
  yield* Effect.addFinalizer(() =>
    Effect.forEach([...hubs.values(), ...(all === undefined ? [] : [all])], PubSub.shutdown, {
      discard: true,
    }),
  );
  const subscribe = Effect.fn("KinChatHub.subscribe")(function* (orgId: KinOrgId) {
    let hub = hubs.get(orgId);
    if (hub === undefined) {
      const created = yield* PubSub.unbounded<KinChatHubEvent>();
      hub = hubs.get(orgId) ?? created;
      hubs.set(orgId, hub);
    }
    return yield* PubSub.subscribe(hub);
  });
  return KinChatHub.of({
    publish: Effect.fn("KinChatHub.publish")(function (event) {
      return sql.afterCommit(
        Effect.gen(function* () {
          const hub = hubs.get(event.orgId);
          if (hub !== undefined) yield* PubSub.publish(hub, event);
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
    subscribeForViewer: Effect.fn("KinChatHub.subscribeForViewer")(function* (identity) {
      const subscription = yield* subscribe(identity.orgId);
      return Stream.fromEffectRepeat(PubSub.take(subscription)).pipe(
        Stream.filterEffect(
          Effect.fn("KinChatHub.canDeliver")(function* (event) {
            if (event.type === "member.removed")
              return identity._tag === "person"
                ? event.member.principal._tag === "person" &&
                    event.member.principal.personId === identity.personId
                : event.member.principal._tag === "agent" &&
                    event.member.principal.agentId === identity.agentId;
            const chatId =
              event.type === "chat.created"
                ? event.chat.chatId
                : event.type === "message.posted"
                  ? event.message.chatId
                  : event.type === "widget.updated"
                    ? event.widget.chatId
                    : event.type === "waiting.updated"
                      ? event.item.chatId
                      : event.chatId;
            if (
              event.type === "waiting.updated" &&
              (identity._tag !== "person" || event.item.personId !== identity.personId)
            )
              return false;
            if (event.type === "waiting.updated" && event.item.resolvedAt !== null) return true;
            const memberOption = yield* repo.activeMember({
              orgId: identity.orgId,
              chatId,
              principal: identity,
            });
            if (Option.isNone(memberOption)) return false;
            const member = memberOption.value;
            const messageId =
              event.type === "widget.updated"
                ? event.widget.messageId
                : event.type === "waiting.updated"
                  ? event.item.messageId
                  : null;
            const message =
              event.type === "message.posted"
                ? Option.some(event.message)
                : messageId === null
                  ? Option.none()
                  : yield* repo.getMessage({ orgId: identity.orgId, messageId });
            if (messageId !== null && Option.isNone(message)) return false;
            return (
              Option.isNone(message) ||
              !["suggested", "dismissed"].includes(message.value.status) ||
              member.role === "owner" ||
              (message.value.author._tag !== "system" &&
                message.value.author.memberId === member.memberId)
            );
          }),
        ),
        Stream.map((event) =>
          event.type === "message.posted"
            ? { ...event, message: messageForViewer(event.message, identity) }
            : event,
        ),
      );
    }),
  });
});

export const layer = Layer.effect(KinChatHub, make);
