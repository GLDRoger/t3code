import type {
  KinChat,
  KinChatId,
  KinMemberId,
  KinMessage,
  KinOrgId,
  KinWaitingItem,
  KinWidget,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

type ChatEvent =
  | { readonly type: "chat.created"; readonly chat: KinChat }
  | { readonly type: "message.posted"; readonly message: KinMessage }
  | { readonly type: "widget.updated"; readonly widget: KinWidget }
  | { readonly type: "waiting.updated"; readonly item: KinWaitingItem }
  | {
      readonly type: "read.updated";
      readonly chatId: KinChatId;
      readonly memberId: KinMemberId;
      readonly seq: number;
    };
export type KinChatHubEvent = ChatEvent & { readonly orgId: KinOrgId };

export class KinChatHub extends Context.Service<
  KinChatHub,
  {
    readonly publish: (event: KinChatHubEvent) => Effect.Effect<void>;
    readonly subscribe: (
      orgId: KinOrgId,
    ) => Effect.Effect<PubSub.Subscription<KinChatHubEvent>, never, Scope.Scope>;
  }
>()("t3/kin/chat/KinChatHub") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const hubs = new Map<KinOrgId, PubSub.PubSub<KinChatHubEvent>>();
  yield* Effect.addFinalizer(() =>
    Effect.forEach(hubs.values(), PubSub.shutdown, { discard: true }),
  );
  return KinChatHub.of({
    publish: Effect.fn("KinChatHub.publish")(function (event) {
      return sql.afterCommit(
        Effect.gen(function* () {
          const hub = hubs.get(event.orgId);
          if (hub !== undefined) yield* PubSub.publish(hub, event);
        }),
      );
    }),
    subscribe: Effect.fn("KinChatHub.subscribe")(function* (orgId) {
      let hub = hubs.get(orgId);
      if (hub === undefined) {
        const created = yield* PubSub.unbounded<KinChatHubEvent>();
        hub = hubs.get(orgId) ?? created;
        hubs.set(orgId, hub);
      }
      return yield* PubSub.subscribe(hub);
    }),
  });
});

export const layer = Layer.effect(KinChatHub, make);
