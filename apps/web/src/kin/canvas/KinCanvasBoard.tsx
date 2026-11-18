import { kinCanvasDetail } from "@t3tools/client-runtime/kin/kinCanvasCamera";
import { kinCanvasSnap, type KinCanvasLayout } from "@t3tools/client-runtime/kin/kinCanvasLayout";
import {
  KIN_CANVAS,
  type KinCanvasCardView,
  type KinCanvasModel,
  type KinCanvasWidgetView,
} from "@t3tools/client-runtime/kin/kinCanvasView";
import type { KinRecordState } from "@t3tools/contracts";
import {
  CalendarClockIcon,
  FileTextIcon,
  GaugeIcon,
  ListTodoIcon,
  MoreHorizontalIcon,
} from "lucide-react";
import { memo, useEffect, useRef, type ReactNode } from "react";

import { useStableCallback } from "../../hooks/useStableCallback";
import { observeResize } from "../../lib/observeResize";
import { cn } from "../../lib/utils";
import { KinWorkStateIcon } from "../KinWorkStateIcon";
import { attachKinCanvasGestures, type KinCanvasController } from "./kinCanvasController";

export interface KinCanvasBoardProps {
  readonly controller: KinCanvasController;
  readonly layout: KinCanvasLayout;
  readonly model: KinCanvasModel;
  readonly selected: ReadonlySet<string>;
  readonly peek: string | null;
  readonly highlight: ReadonlySet<string>;
  /** Cards glide to a lens's places and back; never while dragging or panning. */
  readonly gliding: boolean;
  readonly canArrange: boolean;
  /** Groups are projects (not a lens's columns), so each has a menu. */
  readonly groupMenus: boolean;
  readonly onPeek: (key: string | null) => void;
  readonly onToggleSelect: (key: string) => void;
  readonly onMove: (key: string, x: number, y: number) => void;
  readonly onGroup: (key: string | null, anchor: HTMLElement) => void;
  /** The board has a size for the first time: place the camera. */
  readonly onSized: (width: number, height: number) => void;
  readonly children?: ReactNode;
}

const STATE_OF_TONE: Record<KinCanvasCardView["tone"], KinRecordState | null> = {
  late: "open",
  done: "done",
  doing: "doing",
  waiting: "waiting",
  open: "open",
  doc: null,
};

const WIDGET_ICON = { progress: GaugeIcon, facts: ListTodoIcon, countdown: CalendarClockIcon };

/** Writes the camera onto the world and tells the cards how much to say, without rendering. */
function useCameraWriter(
  controller: KinCanvasController,
  viewport: React.RefObject<HTMLDivElement | null>,
  world: React.RefObject<HTMLDivElement | null>,
  onSized: (width: number, height: number) => void,
) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes the DOM to the camera, which lives outside React and moves every frame
  useEffect(() => {
    const el = viewport.current;
    const inner = world.current;
    if (el === null || inner === null) return;
    // Type that stays readable zoomed out is resized when the detail changes or the camera rests,
    // never per frame: at full detail it is the card's own size.
    const invert = (scale: number) =>
      inner.style.setProperty(
        "--kc-inv",
        kinCanvasDetail(scale) === "cards" ? "1" : String(Math.min(3.2, 1 / scale)),
      );
    const stopFrames = controller.listen((camera, width, height) => {
      const tx = width / 2 - camera.x * camera.scale;
      const ty = height / 2 - camera.y * camera.scale;
      inner.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${camera.scale})`;
      const detail = kinCanvasDetail(camera.scale);
      if (el.dataset.detail !== detail) {
        el.dataset.detail = detail;
        invert(camera.scale);
      }
    });
    const stopSettle = controller.settled((camera) => invert(camera.scale));
    let sized = false;
    const stopResize = observeResize(el, ([entry]) => {
      if (entry === undefined) return;
      controller.resize(entry.contentRect.width, entry.contentRect.height);
      // Until someone moves it, the view keeps fitting the board as the window changes.
      if (entry.contentRect.width > 0 && (!sized || !controller.touched)) {
        sized = true;
        onSized(entry.contentRect.width, entry.contentRect.height);
      }
    });
    return () => {
      stopFrames();
      stopSettle();
      stopResize();
    };
  }, [controller, viewport, world, onSized]);
}

export function KinCanvasBoard(props: KinCanvasBoardProps) {
  const viewport = useRef<HTMLDivElement | null>(null);
  const world = useRef<HTMLDivElement | null>(null);
  const { controller, canArrange } = props;
  useCameraWriter(controller, viewport, world, props.onSized);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- binds pointer and wheel gestures on the canvas element to the camera
  useEffect(() => {
    const el = viewport.current;
    if (el === null) return;
    return attachKinCanvasGestures(el, controller, (target) => {
      if (target.closest("[data-canvas-control]")) return false;
      return !(canArrange && target.closest("[data-canvas-card]"));
    });
  }, [controller, canArrange]);

  const justDragged = useRef<string | null>(null);
  const drag = useRef<{
    key: string;
    el: HTMLElement;
    startX: number;
    startY: number;
    left: number;
    top: number;
    moved: boolean;
    pointerId: number;
  } | null>(null);

  // Stable, so a board render doesn't render every card again; the card names itself by data-key.
  const onCardDown = useStableCallback((event: React.PointerEvent<HTMLElement>) => {
    if (!canArrange || event.button !== 0 || event.shiftKey || event.metaKey || event.ctrlKey)
      return;
    const key = event.currentTarget.dataset.key ?? "";
    const box = props.layout.cards.get(key);
    if (box === undefined) return;
    drag.current = {
      key,
      el: event.currentTarget,
      startX: event.clientX,
      startY: event.clientY,
      left: box.x,
      top: box.y,
      moved: false,
      pointerId: event.pointerId,
    };
  });
  const onCardMove = useStableCallback((event: React.PointerEvent<HTMLElement>) => {
    const held = drag.current;
    if (held === null || held.pointerId !== event.pointerId) return;
    const dx = event.clientX - held.startX;
    const dy = event.clientY - held.startY;
    if (!held.moved && Math.hypot(dx, dy) < 5) return;
    if (!held.moved) {
      held.moved = true;
      held.el.setPointerCapture(event.pointerId);
      held.el.dataset.dragging = "";
    }
    const scale = controller.camera.scale;
    held.el.style.transform = `translate(${held.left + dx / scale}px, ${held.top + dy / scale}px)`;
  });
  const onCardCancel = useStableCallback(() => {
    const held = drag.current;
    drag.current = null;
    if (held === null || !held.moved) return;
    delete held.el.dataset.dragging;
    held.el.style.transform = `translate(${held.left}px, ${held.top}px)`;
  });
  const onCardUp = useStableCallback((event: React.PointerEvent<HTMLElement>) => {
    const held = drag.current;
    drag.current = null;
    if (held === null || !held.moved) return;
    delete held.el.dataset.dragging;
    const scale = controller.camera.scale;
    const at = kinCanvasSnap(
      held.left + (event.clientX - held.startX) / scale,
      held.top + (event.clientY - held.startY) / scale,
    );
    held.el.style.transform = `translate(${at.x}px, ${at.y}px)`;
    // The click that ends a drag doesn't open the card.
    justDragged.current = held.key;
    setTimeout(() => {
      justDragged.current = null;
    }, 0);
    props.onMove(held.key, at.x, at.y);
  });
  const onCardClick = useStableCallback((event: React.MouseEvent<HTMLElement>) => {
    const key = event.currentTarget.dataset.key ?? "";
    if (justDragged.current === key) return;
    if (event.shiftKey || event.metaKey || event.ctrlKey) props.onToggleSelect(key);
    else props.onPeek(key);
  });

  const onKeyDown = (event: React.KeyboardEvent) => {
    if ((event.target as HTMLElement).closest("[data-canvas-card]") && event.key === "Enter")
      return;
    const step = 80;
    const keys: Record<string, () => void> = {
      ArrowLeft: () => controller.panBy(step, 0),
      ArrowRight: () => controller.panBy(-step, 0),
      ArrowUp: () => controller.panBy(0, step),
      ArrowDown: () => controller.panBy(0, -step),
      "+": () => controller.zoomAt(1.25),
      "=": () => controller.zoomAt(1.25),
      "-": () => controller.zoomAt(0.8),
      Escape: () => props.onPeek(null),
    };
    const run = keys[event.key];
    if (run === undefined || event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    run();
  };

  return (
    <div
      ref={viewport}
      role="application"
      aria-label={KIN_CANVAS.title}
      aria-roledescription="canvas"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onClick={(event) => {
        if (event.target === event.currentTarget || event.target === world.current)
          props.onPeek(null);
      }}
      data-detail="cards"
      className="group/canvas absolute inset-0 cursor-grab touch-none overflow-hidden bg-muted/40 outline-none select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-panning:cursor-grabbing"
    >
      <div
        ref={world}
        className="absolute top-0 left-0 origin-top-left [--kc-inv:1]"
        style={{ willChange: "transform" }}
        onClick={(event) => {
          if (event.target === event.currentTarget) props.onPeek(null);
        }}
      >
        {props.layout.groups.map((group) => (
          <div
            key={group.key ?? "none"}
            className="pointer-events-none absolute rounded-2xl border border-border/70 bg-background/60"
            style={{
              transform: `translate(${group.x}px, ${group.y}px)`,
              width: group.w,
              height: group.h,
            }}
          >
            <div className="pointer-events-auto flex h-[52px] items-center gap-2 px-6">
              <h2
                className="min-w-0 truncate font-semibold text-foreground tracking-tight"
                style={{ fontSize: "min(calc(1.125rem * var(--kc-inv)), 34px)" }}
              >
                {group.title}
              </h2>
              {props.groupMenus ? (
                <button
                  type="button"
                  data-canvas-control=""
                  aria-label={`${group.title}: more`}
                  className="ms-auto inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none group-data-[detail=dots]/canvas:hidden"
                  onClick={(event) => props.onGroup(group.key, event.currentTarget)}
                >
                  <MoreHorizontalIcon className="size-4" />
                </button>
              ) : null}
            </div>
          </div>
        ))}
        {[...props.layout.cards.values()].map((box) => {
          const card = props.model.cards.get(box.key);
          const widget = props.model.widgets.get(box.key);
          if (card === undefined && widget === undefined) return null;
          return (
            <CanvasCard
              key={box.key}
              x={box.x}
              y={box.y}
              card={card}
              widget={widget}
              selected={props.selected.has(box.key)}
              peeked={props.peek === box.key}
              highlighted={props.highlight.has(box.key)}
              gliding={props.gliding}
              draggable={canArrange}
              onPointerDown={onCardDown}
              onPointerMove={onCardMove}
              onPointerUp={onCardUp}
              onPointerCancel={onCardCancel}
              onClick={onCardClick}
            />
          );
        })}
      </div>
      {props.children}
    </div>
  );
}

interface CanvasCardProps {
  readonly x: number;
  readonly y: number;
  readonly card: KinCanvasCardView | undefined;
  readonly widget: KinCanvasWidgetView | undefined;
  readonly selected: boolean;
  readonly peeked: boolean;
  readonly highlighted: boolean;
  readonly gliding: boolean;
  readonly draggable: boolean;
  readonly onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  readonly onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
  readonly onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
  readonly onPointerCancel: () => void;
  readonly onClick: (event: React.MouseEvent<HTMLElement>) => void;
}

const CanvasCard = memo(function CanvasCard(props: CanvasCardProps) {
  const { card, widget } = props;
  const label = card?.accessibilityLabel ?? widget?.accessibilityLabel ?? "";
  const late = card?.tone === "late" || widget?.tone === "late";
  return (
    <button
      type="button"
      data-canvas-card=""
      data-key={card?.key ?? widget?.key}
      aria-label={label}
      aria-pressed={props.selected}
      onPointerDown={props.onPointerDown}
      onPointerMove={props.onPointerMove}
      onPointerUp={props.onPointerUp}
      onPointerCancel={props.onPointerCancel}
      onClick={props.onClick}
      className={cn(
        "absolute top-0 left-0 flex h-[132px] w-[240px] flex-col overflow-hidden rounded-xl border bg-card p-3 text-start text-card-foreground shadow-xs outline-none",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        "data-dragging:z-10 data-dragging:shadow-lg data-dragging:cursor-grabbing",
        props.draggable && "cursor-grab",
        props.gliding && "transition-transform duration-300 ease-out motion-reduce:transition-none",
        late ? "border-destructive/45" : "border-border",
        card?.tone === "done" && "bg-card/70",
        widget !== undefined && "bg-background",
        props.selected && "ring-2 ring-primary",
        props.peeked && !props.selected && "ring-2 ring-ring",
        props.highlighted && !props.selected && !props.peeked && "ring-2 ring-warning",
      )}
      style={{ transform: `translate(${props.x}px, ${props.y}px)` }}
    >
      {card !== undefined ? <TaskOrDoc card={card} /> : <Widget widget={widget!} />}
    </button>
  );
});

function Marks(props: { readonly card: KinCanvasCardView }) {
  return (
    <span className="ms-auto flex shrink-0 items-center gap-1">
      {props.card.needsYou ? (
        <span className="rounded-full bg-warning/15 px-1.5 py-0.5 font-medium text-2xs text-warning-foreground">
          {KIN_CANVAS.needsYou}
        </span>
      ) : null}
      {props.card.changed !== null ? (
        <span aria-hidden className="size-2 rounded-full bg-primary" />
      ) : null}
    </span>
  );
}

function TaskOrDoc(props: { readonly card: KinCanvasCardView }) {
  const { card } = props;
  const state = STATE_OF_TONE[card.tone];
  return (
    <>
      <div className="flex items-center gap-1.5 text-muted-foreground text-xs group-data-[detail=dots]/canvas:hidden group-data-[detail=titles]/canvas:hidden">
        {state === null ? (
          <FileTextIcon aria-hidden className="size-4 shrink-0" />
        ) : (
          <KinWorkStateIcon state={state} />
        )}
        <span className="tabular-nums">{card.key}</span>
        <span aria-hidden>·</span>
        <span className={cn("truncate", card.tone === "late" && "text-destructive-foreground")}>
          {card.tone === "late" ? "Late" : card.status}
        </span>
        <Marks card={card} />
      </div>
      <p
        style={{ fontSize: "calc(0.875rem * var(--kc-inv))" }}
        className={cn(
          "mt-1.5 line-clamp-2 font-medium text-sm leading-snug",
          "group-data-[detail=titles]/canvas:mt-0 group-data-[detail=titles]/canvas:line-clamp-3",
          "group-data-[detail=dots]/canvas:hidden",
          card.tone === "done" && "text-muted-foreground",
        )}
      >
        {card.title}
      </p>
      <p className="mt-1 truncate text-muted-foreground text-xs group-data-[detail=dots]/canvas:hidden group-data-[detail=titles]/canvas:hidden">
        {card.line}
      </p>
      <p
        className={cn(
          "mt-auto truncate text-xs group-data-[detail=dots]/canvas:hidden group-data-[detail=titles]/canvas:hidden",
          card.working !== null ? "font-medium text-foreground" : "text-muted-foreground",
        )}
      >
        {card.working ?? card.changed ?? ""}
      </p>
      <span
        aria-hidden
        className={cn(
          "hidden size-full rounded-lg group-data-[detail=dots]/canvas:block",
          card.tone === "late"
            ? "bg-destructive/40"
            : card.tone === "done"
              ? "bg-muted"
              : card.tone === "doc"
                ? "bg-info/25"
                : card.working !== null
                  ? "bg-primary/40"
                  : "bg-foreground/15",
        )}
      />
    </>
  );
}

function Widget(props: { readonly widget: KinCanvasWidgetView }) {
  const { widget } = props;
  const Icon = WIDGET_ICON[widget.widget.kind];
  return (
    <>
      <div className="flex items-center gap-1.5 text-muted-foreground text-xs group-data-[detail=dots]/canvas:hidden">
        <Icon aria-hidden className="size-4 shrink-0" />
        <span className="truncate">{widget.title}</span>
      </div>
      <p
        style={widget.tone === "gone" ? undefined : { fontSize: "calc(1.5rem * var(--kc-inv))" }}
        className={cn(
          "mt-2 font-semibold text-2xl tabular-nums tracking-tight group-data-[detail=dots]/canvas:hidden",
          widget.tone === "late" && "text-destructive-foreground",
          widget.tone === "gone" && "text-base text-muted-foreground",
        )}
      >
        {widget.headline}
      </p>
      <p className="mt-0.5 truncate text-muted-foreground text-xs group-data-[detail=dots]/canvas:hidden group-data-[detail=titles]/canvas:hidden">
        {widget.detail}
      </p>
      {widget.fraction !== null ? (
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(widget.fraction * 100)}
          aria-label={widget.headline}
          className="mt-auto h-1.5 overflow-hidden rounded-full bg-muted group-data-[detail=dots]/canvas:hidden"
        >
          <div
            className={cn(
              "h-full rounded-full",
              widget.tone === "done" ? "bg-success" : "bg-primary",
            )}
            style={{ width: `${Math.round(widget.fraction * 100)}%` }}
          />
        </div>
      ) : null}
      <span
        aria-hidden
        className="hidden size-full rounded-lg bg-primary/25 group-data-[detail=dots]/canvas:block"
      />
    </>
  );
}
