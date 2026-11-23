import type {
  KinActionId,
  KinAgentId,
  KinChatId,
  KinMessageId,
  KinOrgId,
  KinWakeupId,
  KinWidget,
  KinWidgetId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import { ApproverKeys } from "../approvals/ApproverKeys.ts";
import { KinPendingActions } from "../approvals/PendingActions.ts";
import { KinChatHub, type KinChatHubEvent } from "../chat/KinChatHub.ts";
import { KinPushSender } from "./KinPushSender.ts";
import { approvalTopic, cardTopic, chatTopic, taskTopic } from "./KinPushTopics.ts";

const phaseOf = (widget: KinWidget) =>
  typeof widget.state === "object" && widget.state !== null && "phase" in widget.state
    ? String(widget.state.phase)
    : "";
const actionOf = (widget: KinWidget) =>
  typeof widget.state === "object" &&
  widget.state !== null &&
  "actionId" in widget.state &&
  typeof widget.state.actionId === "string"
    ? (widget.state.actionId as KinActionId)
    : null;

/**
 * Turns committed chat events into pushes. Every post path publishes to the hub, so this is
 * the one place that decides when to ask; the sender decides who hears it and how loudly.
 */
const make = Effect.gen(function* () {
  const hub = yield* KinChatHub;
  const sender = yield* KinPushSender;
  // What each open card last pushed for. A card redraws often; it rings again only when it
  // starts waiting on someone new or changes phase. Lost on restart: at most one repeat.
  const announced = new Map<
    KinWidgetId,
    { readonly phase: string; readonly awaiting: Set<string> }
  >();

  // An agent's turn in a chat, from its presence line to the line's end. A card the turn posts
  // waits for the turn's end: whoever its words rang heard of the card with them.
  type Turn = {
    /** Each agent showing a line here, and the wake-up it shows; null for a queue line. */
    readonly agents: Map<KinAgentId, KinWakeupId | null>;
    said: Array<KinMessageId>;
    readonly cards: Map<KinWidgetId, KinWidget>;
  };
  const turns = new Map<string, Turn>();
  const turnKey = (orgId: KinOrgId, chatId: KinChatId) => `${orgId}\u0000${chatId}`;

  const release = Effect.fn("KinPushDispatch.release")(function* (orgId: KinOrgId, turn: Turn) {
    if (turn.cards.size > 0)
      yield* Effect.logInfo("Kin push sends the cards a turn held", {
        orgId,
        widgetIds: [...turn.cards.keys()],
      });
    for (const card of turn.cards.values())
      yield* sender.notify({
        _tag: "widget",
        orgId,
        widgetId: card.widgetId,
        covered: turn.said,
      });
  });

  const onPresence = Effect.fn("KinPushDispatch.onPresence")(function* (
    orgId: KinOrgId,
    chatId: KinChatId,
    agentId: KinAgentId,
    wakeupId: KinWakeupId | null | undefined,
  ) {
    const key = turnKey(orgId, chatId);
    const turn = turns.get(key);
    if (wakeupId !== undefined) {
      if (turn === undefined) {
        turns.set(key, { agents: new Map([[agentId, wakeupId]]), said: [], cards: new Map() });
        return;
      }
      const showing = turn.agents.get(agentId);
      // A line that moves on to the next wake-up with no end between: the last one's turn is over.
      if (showing !== undefined && showing !== null && wakeupId !== null && showing !== wakeupId) {
        yield* release(orgId, turn);
        turn.said = [];
        turn.cards.clear();
      }
      if (wakeupId !== null || showing === undefined) turn.agents.set(agentId, wakeupId);
      return;
    }
    if (turn === undefined) return;
    turn.agents.delete(agentId);
    if (turn.agents.size > 0) return;
    turns.delete(key);
    yield* release(orgId, turn);
  });

  const onWidget = Effect.fn("KinPushDispatch.onWidget")(function* (widget: KinWidget) {
    const previous = announced.get(widget.widgetId);
    const turn = turns.get(turnKey(widget.orgId, widget.chatId));
    // Closed, answered, or no longer waiting on someone: what its push told them may be settled.
    if (
      widget.closedAt !== null ||
      widget.awaiting.length === 0 ||
      [...(previous?.awaiting ?? [])].some(
        (person) => !new Set<string>(widget.awaiting).has(person),
      )
    ) {
      const actionId = actionOf(widget);
      yield* sender.settle(widget.orgId, {
        topics: [
          cardTopic(widget.widgetId),
          ...(actionId === null ? [] : [approvalTopic(actionId)]),
        ],
        messageIds: [widget.messageId],
      });
    }
    if (widget.closedAt !== null || widget.awaiting.length === 0) {
      announced.delete(widget.widgetId);
      turn?.cards.delete(widget.widgetId);
      return;
    }
    const phase = phaseOf(widget);
    announced.set(widget.widgetId, { phase, awaiting: new Set(widget.awaiting) });
    const fresh =
      previous === undefined ||
      previous.phase !== phase ||
      widget.awaiting.some((person) => !previous.awaiting.has(person));
    if (!fresh) return;
    if (widget.type !== "approval") {
      if (turn !== undefined && turn.said.includes(widget.messageId)) {
        if (!turn.cards.has(widget.widgetId))
          yield* Effect.logInfo("Kin push holds a card for its turn's end", {
            orgId: widget.orgId,
            widgetId: widget.widgetId,
          });
        turn.cards.set(widget.widgetId, widget);
        return;
      }
      yield* sender.notify({ _tag: "widget", orgId: widget.orgId, widgetId: widget.widgetId });
      return;
    }
    // An approval rings once, when its card first waits; the action's own push says the rest.
    const actionId = actionOf(widget);
    if (actionId !== null && previous === undefined)
      yield* sender.notify({ _tag: "approval", orgId: widget.orgId, actionId });
  });

  // Subscribed before the first pass, so a change committed during it is sent after it.
  const keyChanges = yield* (yield* ApproverKeys).changes;
  yield* sender.flushKeyPushes.pipe(
    Effect.andThen(
      Effect.forever(PubSub.take(keyChanges).pipe(Effect.andThen(sender.flushKeyPushes))),
    ),
    Effect.forkScoped,
  );

  // An approval decided, withdrawn or run out, whether or not a card shows it.
  const actionChanges = yield* (yield* KinPendingActions).changes;
  yield* Effect.forever(
    PubSub.take(actionChanges).pipe(
      Effect.flatMap((ref) => sender.settle(ref.orgId, { topics: [approvalTopic(ref.actionId)] })),
    ),
  ).pipe(Effect.forkScoped);

  const onMessage = (event: Extract<KinChatHubEvent, { type: "message.posted" }>) => {
    const { message } = event;
    const turn = turns.get(turnKey(event.orgId, message.chatId));
    if (message.author._tag === "agent" && turn?.agents.has(message.author.agentId) === true)
      turn.said.push(message.messageId);
    return sender.notify({ _tag: "message", orgId: event.orgId, messageId: message.messageId });
  };

  const events = yield* hub.subscribeAll;
  yield* Stream.runForEach(events, (event) =>
    event.type === "message.posted" && event.message.status === "posted"
      ? onMessage(event)
      : event.type === "widget.updated"
        ? onWidget(event.widget)
        : event.type === "presence.updated"
          ? onPresence(event.orgId, event.chatId, event.agentId, event.presence?.wakeupId)
          : event.type === "read.updated"
            ? sender.notify({
                _tag: "read",
                orgId: event.orgId,
                chatId: event.chatId,
                memberId: event.memberId,
              })
            : event.type === "chat.cleared"
              ? sender.settle(event.orgId, {
                  chatId: event.chatId,
                  topics: [chatTopic(event.chatId)],
                })
              : event.type === "member.removed" && event.member.principal._tag === "person"
                ? sender.settle(event.orgId, {
                    chatId: event.member.chatId,
                    topics: [chatTopic(event.member.chatId)],
                    personId: event.member.principal.personId,
                  })
                : event.type === "message.changed" && event.message.status !== "posted"
                  ? sender.settle(event.orgId, {
                      messageIds: [event.message.messageId],
                      topics: [chatTopic(event.message.chatId)],
                    })
                  : Effect.void,
  ).pipe(Effect.forkScoped);
});

/**
 * A task done, dropped or handed on settles what pushes told of it: its own topic, and Kin's
 * notices that name several. Runs for as long as the caller's scope, from Kin's layer, which holds
 * the tasks service this layer sits beside.
 */
export const settleTasks = Effect.fn("KinPushDispatch.settleTasks")(function* <E>(
  orgId: KinOrgId,
  changes: Stream.Stream<{ readonly key?: string | undefined }, E>,
) {
  const sender = yield* KinPushSender;
  yield* Stream.runForEach(changes, (tick) =>
    tick.key === undefined
      ? Effect.void
      : sender.settle(orgId, { topics: [taskTopic(tick.key)], kinds: ["f"] }),
  ).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Kin push stopped following tasks", { cause })),
    Effect.forkScoped,
  );
});

export const layer = Layer.effectDiscard(make);
