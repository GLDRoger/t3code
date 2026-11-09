import type {
  KinAgentId,
  KinChat,
  KinChatActivity,
  KinChatActivityPhase,
  KinChatId,
  KinMemberId,
  KinChatMember,
  KinMessage,
  KinOrgId,
  KinWaitingItem,
  KinWidget,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
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
      readonly type: "activity.updated";
      readonly chatId: KinChatId;
      readonly activity: KinChatActivity;
    }
  | {
      readonly type: "read.updated";
      readonly chatId: KinChatId;
      readonly memberId: KinMemberId;
      readonly seq: number;
    };
export type KinChatHubEvent = ChatEvent & { readonly orgId: KinOrgId };

/** Phases a running wake-up reports; MCP tool calls move only these. */
export const WORKING_PHASES: ReadonlySet<KinChatActivityPhase> = new Set([
  "started",
  "notes_read",
  "notes_write",
  "delegating",
  "approval",
  "scheduling",
]);
export interface ActivityInput {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly chatIds: Iterable<KinChatId>;
  readonly phase: KinChatActivityPhase;
  readonly resumesAt?: number | undefined;
}

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
    /** The chat's current activity, held in memory: a restart ends every wake-up. */
    readonly activity: (
      orgId: KinOrgId,
      chatId: KinChatId,
    ) => Effect.Effect<KinChatActivity | null>;
    /** Sets each chat's activity, publishing only a changed phase. `idle` clears it. */
    readonly setActivity: (input: ActivityInput) => Effect.Effect<void>;
    /** Moves every chat the agent is working on to `phase`; others keep theirs. */
    readonly setWorkingPhase: (
      orgId: KinOrgId,
      agentId: KinAgentId,
      phase: KinChatActivityPhase,
    ) => Effect.Effect<void>;
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
  const deliver = Effect.fnUntraced(function* (event: KinChatHubEvent) {
    const hub = hubs.get(event.orgId);
    if (hub !== undefined) yield* PubSub.publish(hub, event);
    if (all !== undefined) yield* PubSub.publish(all, event);
  });
  const activities = new Map<
    string,
    { readonly orgId: KinOrgId; readonly chatId: KinChatId; readonly activity: KinChatActivity }
  >();
  const activityKey = (orgId: KinOrgId, chatId: KinChatId) => `${orgId}:${chatId}`;
  const setActivity = Effect.fn("KinChatHub.setActivity")(function* (input: ActivityInput) {
    const since = yield* Clock.currentTimeMillis;
    for (const chatId of new Set(input.chatIds)) {
      const key = activityKey(input.orgId, chatId);
      const held = activities.get(key)?.activity;
      const unchanged =
        input.phase === "idle"
          ? held === undefined
          : held?.phase === input.phase &&
            held.agentId === input.agentId &&
            held.resumesAt === input.resumesAt;
      if (unchanged) continue;
      const activity: KinChatActivity = {
        agentId: input.agentId,
        phase: input.phase,
        since,
        ...(input.resumesAt === undefined ? {} : { resumesAt: input.resumesAt }),
      };
      if (input.phase === "idle") activities.delete(key);
      else activities.set(key, { orgId: input.orgId, chatId, activity });
      // Activity is memory-only, so it publishes at once rather than after a commit.
      yield* deliver({ type: "activity.updated", orgId: input.orgId, chatId, activity });
    }
  });
  return KinChatHub.of({
    publish: Effect.fn("KinChatHub.publish")(function (event) {
      return sql.afterCommit(deliver(event));
    }),
    activity: Effect.fn("KinChatHub.activity")(function* (orgId, chatId) {
      return activities.get(activityKey(orgId, chatId))?.activity ?? null;
    }),
    setActivity,
    setWorkingPhase: Effect.fn("KinChatHub.setWorkingPhase")(function* (orgId, agentId, phase) {
      const chatIds = [...activities.values()]
        .filter(
          (held) =>
            held.orgId === orgId &&
            held.activity.agentId === agentId &&
            WORKING_PHASES.has(held.activity.phase),
        )
        .map((held) => held.chatId);
      if (chatIds.length > 0) yield* setActivity({ orgId, agentId, chatIds, phase });
    }),
    subscribeAll: Effect.gen(function* () {
      const created = yield* PubSub.unbounded<KinChatHubEvent>();
      all ??= created;
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
