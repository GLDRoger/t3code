import type { KinActionId, KinWidget, KinWidgetId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { KinChatHub } from "../chat/KinChatHub.ts";
import { KinPushSender } from "./KinPushSender.ts";

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

  const onWidget = Effect.fn("KinPushDispatch.onWidget")(function* (widget: KinWidget) {
    const previous = announced.get(widget.widgetId);
    if (widget.closedAt !== null || widget.awaiting.length === 0) {
      announced.delete(widget.widgetId);
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
      yield* sender.notify({ _tag: "widget", orgId: widget.orgId, widgetId: widget.widgetId });
      return;
    }
    // An approval rings once, when its card first waits; the action's own push says the rest.
    const actionId = actionOf(widget);
    if (actionId !== null && previous === undefined)
      yield* sender.notify({ _tag: "approval", orgId: widget.orgId, actionId });
  });

  const events = yield* hub.subscribeAll;
  yield* Stream.runForEach(events, (event) =>
    event.type === "message.posted" && event.message.status === "posted"
      ? sender.notify({ _tag: "message", orgId: event.orgId, messageId: event.message.messageId })
      : event.type === "widget.updated"
        ? onWidget(event.widget)
        : Effect.void,
  ).pipe(Effect.forkScoped);
});

export const layer = Layer.effectDiscard(make);
