import type { KinCanvasLayout } from "@t3tools/client-runtime/kin/kinCanvasLayout";
import {
  KIN_CANVAS,
  type KIN_CANVAS_WIDGET_KINDS,
  type KinCanvasModel,
} from "@t3tools/client-runtime/kin/kinCanvasView";
import type { KinCanvasWidgetKind } from "@t3tools/contracts";
import { CalendarClockIcon, ExternalLinkIcon, Trash2Icon, Undo2Icon, XIcon } from "lucide-react";

import { Button } from "../../components/ui/button";
import { AskMenu } from "./KinCanvasAsk";

export type KinCanvasPeekTarget =
  | { readonly type: "card"; readonly key: string }
  | { readonly type: "group"; readonly key: string };

interface Lead {
  readonly agentId: string;
  readonly name: string;
  readonly ownerChatId: string;
}

/**
 * What one card says in full, beside the canvas on a wide window and over its foot on a narrow
 * one, with what can be done to it from here.
 */
export function KinCanvasPeek(props: {
  readonly target: KinCanvasPeekTarget;
  readonly model: KinCanvasModel;
  readonly layout: KinCanvasLayout;
  readonly canArrange: boolean;
  readonly placed: boolean;
  readonly leads: ReadonlyArray<Lead>;
  readonly widgetKinds: typeof KIN_CANVAS_WIDGET_KINDS;
  readonly onClose: () => void;
  readonly onOpen: (key: string, kind?: "task" | "doc" | "project") => void;
  readonly onAsk: (agent: { readonly ownerChatId: string }, key: string) => void;
  readonly onAddWidget: (kind: KinCanvasWidgetKind, source: string) => void;
  readonly onRemoveWidget: (id: string) => void;
  readonly onPutBack: (key: string) => void;
  readonly onShowSources: (keys: ReadonlyArray<string>) => void;
}) {
  const { target, model } = props;
  const card = target.type === "card" ? model.cards.get(target.key) : undefined;
  const widget = target.type === "card" ? model.widgets.get(target.key) : undefined;
  const group =
    target.type === "group" ? model.groups.find((g) => g.key === target.key) : undefined;
  if (card === undefined && widget === undefined && group === undefined) return null;

  const membersOf = (groupKey: string) =>
    [...props.layout.cards.values()]
      .filter((box) => box.group === groupKey && model.cards.has(box.key))
      .map((box) => box.key);

  return (
    <aside
      aria-label={card?.title ?? widget?.title ?? group?.title}
      data-canvas-control=""
      className="absolute inset-y-0 end-0 z-20 flex w-full max-w-sm flex-col border-s bg-popover text-popover-foreground shadow-lg max-md:inset-x-0 max-md:top-auto max-md:max-h-[65%] max-md:max-w-none max-md:rounded-t-2xl max-md:border-t max-md:border-s-0"
    >
      <div className="flex items-center gap-2 px-4 pt-3">
        <span className="text-muted-foreground text-xs tabular-nums">
          {card?.key ?? widget?.sourceKey ?? group?.key}
        </span>
        <Button
          className="ms-auto"
          size="icon-sm"
          variant="ghost"
          aria-label="Close"
          onClick={props.onClose}
        >
          <XIcon />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {card !== undefined ? (
          <>
            <h2 className="font-semibold text-base leading-snug">{card.title}</h2>
            <p className="mt-1 text-muted-foreground text-sm">{card.line}</p>
            <dl className="mt-3 space-y-1.5 text-sm">
              <Row
                label="State"
                value={card.tone === "late" ? `${card.status}, late` : card.status}
              />
              {card.working !== null ? <Row label="Now" value={card.working} /> : null}
              {card.changed !== null ? <Row label="New" value={card.changed} /> : null}
              {card.needsYou ? <Row label="Needs you" value={KIN_CANVAS.onYourList} /> : null}
            </dl>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button size="sm" onClick={() => props.onOpen(card.key, card.kind)}>
                <ExternalLinkIcon />
                {KIN_CANVAS.open}
              </Button>
              <AskMenu
                variant="outline"
                label={KIN_CANVAS.askWho}
                leads={props.leads}
                onAsk={(agent) => props.onAsk(agent, card.key)}
              />
              {props.canArrange && card.kind === "task" ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => props.onAddWidget("countdown", card.key)}
                >
                  <CalendarClockIcon />
                  {KIN_CANVAS.countDown}
                </Button>
              ) : null}
              {props.canArrange && props.placed ? (
                <Button size="sm" variant="ghost" onClick={() => props.onPutBack(card.key)}>
                  <Undo2Icon />
                  {KIN_CANVAS.resetPlace}
                </Button>
              ) : null}
            </div>
          </>
        ) : null}

        {widget !== undefined ? (
          <>
            <h2 className="font-semibold text-base leading-snug">{widget.title}</h2>
            <p className="mt-2 font-semibold text-2xl tabular-nums tracking-tight">
              {widget.headline}
            </p>
            <p className="text-muted-foreground text-sm">{widget.detail}</p>
            <p className="mt-3 text-muted-foreground text-xs">
              {KIN_CANVAS.countedFrom(widget.sourceKey)}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {widget.widget.kind !== "countdown" ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => props.onShowSources(membersOf(widget.sourceKey))}
                >
                  Show its tasks
                </Button>
              ) : model.cards.has(widget.sourceKey) ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => props.onShowSources([widget.sourceKey])}
                >
                  Show the task
                </Button>
              ) : null}
              {widget.tone !== "gone" ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    props.onOpen(
                      widget.sourceKey,
                      widget.widget.kind === "countdown" ? "task" : "project",
                    )
                  }
                >
                  <ExternalLinkIcon />
                  Open {widget.sourceKey}
                </Button>
              ) : null}
              {props.canArrange ? (
                <Button size="sm" variant="ghost" onClick={() => props.onRemoveWidget(widget.key)}>
                  <Trash2Icon />
                  {KIN_CANVAS.removeWidget}
                </Button>
              ) : null}
            </div>
          </>
        ) : null}

        {group !== undefined && group.key !== null ? (
          <>
            <h2 className="font-semibold text-base leading-snug">{group.title}</h2>
            <p className="mt-1 text-muted-foreground text-sm">
              {membersOf(group.key).length} on the canvas
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button size="sm" onClick={() => props.onOpen(group.key!, "project")}>
                <ExternalLinkIcon />
                Open project
              </Button>
              <AskMenu
                variant="outline"
                label={KIN_CANVAS.askWho}
                leads={props.leads}
                onAsk={(agent) => props.onAsk(agent, group.key!)}
              />
            </div>
            {props.canArrange ? (
              <>
                <h3 className="mt-5 font-medium text-sm">{KIN_CANVAS.addWidget}</h3>
                <ul className="mt-1.5 space-y-1">
                  {props.widgetKinds
                    .filter((kind) => kind.kind !== "countdown")
                    .map((kind) => (
                      <li key={kind.kind}>
                        <button
                          type="button"
                          className="flex w-full flex-col items-start rounded-lg px-3 py-2 text-start hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none"
                          onClick={() => props.onAddWidget(kind.kind, group.key!)}
                        >
                          <span className="font-medium text-sm">{kind.label}</span>
                          <span className="text-muted-foreground text-xs">{kind.detail}</span>
                        </button>
                      </li>
                    ))}
                  <li>
                    <button
                      type="button"
                      className="flex w-full flex-col items-start rounded-lg px-3 py-2 text-start hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none"
                      onClick={() => props.onAddWidget("countdown", group.key!)}
                    >
                      <span className="font-medium text-sm">Countdown</span>
                      <span className="text-muted-foreground text-xs">
                        {KIN_CANVAS.projectCountdown}
                      </span>
                    </button>
                  </li>
                </ul>
              </>
            ) : null}
          </>
        ) : null}
      </div>
    </aside>
  );
}

function Row(props: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex gap-3">
      <dt className="w-20 shrink-0 text-muted-foreground">{props.label}</dt>
      <dd className="min-w-0 flex-1">{props.value}</dd>
    </div>
  );
}
