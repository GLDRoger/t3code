import {
  kinCanvasDetail,
  kinCanvasVisible,
  type KinCanvasCamera,
  type KinCanvasDetail,
} from "@t3tools/client-runtime/kin/kinCanvasCamera";
import { kinDocPieces } from "@t3tools/client-runtime/kin/kinDocs";
import { kinDocMarkdown } from "@t3tools/client-runtime/kin/kinChatFeed";
import {
  kinCanvasOverlaps,
  type KinCanvasLayout,
} from "@t3tools/client-runtime/kin/kinCanvasLayout";
import {
  KIN_CANVAS,
  type KinCanvasCardView,
  type KinCanvasModel,
  type KinCanvasTone,
} from "@t3tools/client-runtime/kin/kinCanvasView";
import { kinWorkAvatar } from "@t3tools/client-runtime/kin/kinWork";
import type { KinRecordKey, KinRecordState, KinWorkPrincipal } from "@t3tools/contracts";
import { BotIcon, FileTextIcon } from "lucide-react";
import { memo, startTransition, useEffect, useRef, useState } from "react";

import ChatMarkdown from "../../components/ChatMarkdown";
import { useStableCallback } from "../../hooks/useStableCallback";
import { observeResize } from "../../lib/observeResize";
import { cn } from "../../lib/utils";
import { KinAvatar } from "../KinAvatar";
import { fileImageAttachment, fileImageSource } from "../KinDocReader";
import { KinWorkStateIcon } from "../KinWorkStateIcon";
import { useKinDoc } from "../useKinDocs";
import type { KinWorkTarget } from "../useKinWork";
import { attachKinCanvasGestures, type KinCanvasController } from "./kinCanvasController";

/** Docs read whole at the nearest zoom at once, nearest the middle first. */
const NEAR_READS = 3;
/** How far past the screen cards stay mounted, as a share of the screen, so small pans add none. */
const CULL_MARGIN = 0.5;
/** Text read in place stops about here; the peek has the rest. */
const NEAR_TEXT = 3000;

const STATE_OF_TONE: Record<KinCanvasTone, KinRecordState | null> = {
  late: "open",
  doing: "doing",
  waiting: "waiting",
  open: "open",
  done: "done",
  doc: null,
};

const TONE_FILL: Record<KinCanvasTone, string> = {
  late: "bg-destructive/70",
  doing: "bg-info/70",
  waiting: "bg-warning/70",
  open: "bg-muted-foreground/40",
  done: "bg-success/40",
  doc: "bg-primary/45",
};

/** How much bigger than the card's own type labels are drawn, so they stay readable zoomed out. */
const inflation = (detail: KinCanvasDetail, scale: number) =>
  detail === "dots" ? Math.min(5, 1 / scale) : detail === "titles" ? Math.min(3.2, 1 / scale) : 1;

const sameKeys = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && a.every((key, i) => key === b[i]);

export interface KinCanvasBoardProps extends KinWorkTarget {
  readonly controller: KinCanvasController;
  readonly layout: KinCanvasLayout;
  readonly model: KinCanvasModel;
  readonly holders: ReadonlyMap<string, KinWorkPrincipal>;
  readonly peek: string | null;
  readonly onPeek: (key: string | null) => void;
  readonly onOpen: (key: string) => void;
  /** The board has a size: place the camera. */
  readonly onSized: (width: number, height: number) => void;
}

/**
 * The map's surface. The camera moves one transform per frame; cards mount only near the screen,
 * and how much each says changes only when the zoom crosses a step.
 */
export function KinCanvasBoard(props: KinCanvasBoardProps) {
  const viewport = useRef<HTMLDivElement | null>(null);
  const world = useRef<HTMLDivElement | null>(null);
  const { controller, layout, model, onSized } = props;
  const [detail, setDetail] = useState<KinCanvasDetail>("cards");
  const [shown, setShown] = useState<ReadonlyArray<string>>([]);
  const [reading, setReading] = useState<ReadonlyArray<string>>([]);
  const held = useRef({ shown, reading, detail });

  // `given` is the layout just drawn; from a camera frame, the latest one.
  const recull = useStableCallback(
    (camera: KinCanvasCamera, width: number, height: number, given?: KinCanvasLayout) => {
      if (width === 0) return;
      const view = kinCanvasVisible(camera, width, height);
      const margin = Math.max(view.w, view.h) * CULL_MARGIN;
      const near = {
        x: view.x - margin,
        y: view.y - margin,
        w: view.w + margin * 2,
        h: view.h + margin * 2,
      };
      const next: string[] = [];
      const docs: Array<{ key: string; d: number }> = [];
      const step = kinCanvasDetail(camera.scale, width);
      for (const box of (given ?? layout).cards.values()) {
        if (!kinCanvasOverlaps(box, near)) continue;
        next.push(box.key);
        if (
          step === "near" &&
          model.cards.get(box.key)?.kind === "doc" &&
          kinCanvasOverlaps(box, view)
        )
          docs.push({
            key: box.key,
            d: Math.hypot(box.x + box.w / 2 - camera.x, box.y + box.h / 2 - camera.y),
          });
      }
      const read = docs
        .sort((a, b) => a.d - b.d)
        .slice(0, NEAR_READS)
        .map((doc) => doc.key)
        .sort();
      if (!sameKeys(held.current.shown, next)) {
        held.current.shown = next;
        startTransition(() => setShown(next));
      }
      if (!sameKeys(held.current.reading, read)) {
        held.current.reading = read;
        startTransition(() => setReading(read));
      }
    },
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes the DOM to the camera, which lives outside React and moves every frame
  useEffect(() => {
    const el = viewport.current;
    const inner = world.current;
    if (el === null || inner === null) return;
    // Type is resized when the zoom crosses a step or the camera rests, never per frame.
    const retype = (camera: KinCanvasCamera, step: KinCanvasDetail) => {
      inner.style.setProperty("--kc-inv", String(inflation(step, camera.scale)));
      inner.style.setProperty("--kc-zoom", String(camera.scale));
    };
    const stopFrames = controller.listen((camera, width, height) => {
      const tx = width / 2 - camera.x * camera.scale;
      const ty = height / 2 - camera.y * camera.scale;
      inner.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${camera.scale})`;
      inner.style.willChange = "transform";
      const step = kinCanvasDetail(camera.scale, width);
      if (held.current.detail !== step) {
        held.current.detail = step;
        retype(camera, step);
        startTransition(() => setDetail(step));
      }
      recull(camera, width, height);
    });
    // At rest the layer is drawn again at its real size, so text is sharp.
    const stopSettle = controller.settled((camera) => {
      inner.style.willChange = "auto";
      retype(camera, kinCanvasDetail(camera.scale, controller.width));
    });
    let sized = false;
    const stopResize = observeResize(el, ([entry]) => {
      if (entry === undefined) return;
      const { width, height } = entry.contentRect;
      controller.resize(width, height);
      // Until someone moves it, the view keeps fitting the board as the window changes.
      if (width > 0 && (!sized || !controller.touched)) {
        sized = true;
        onSized(width, height);
      }
    });
    return () => {
      stopFrames();
      stopSettle();
      stopResize();
    };
  }, [controller, recull, onSized]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- binds pointer and wheel gestures on the map element to the camera
  useEffect(() => {
    const el = viewport.current;
    if (el === null) return;
    return attachKinCanvasGestures(el, controller, () => true);
  }, [controller]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- new rows move cards, so which are near the screen is worked out again against the camera
  useEffect(() => {
    recull(controller.camera, controller.width, controller.height, layout);
  }, [layout, controller, recull]);

  // Stable, so a board render doesn't render every card again; the card names itself by data-key.
  const keyOf = (event: React.SyntheticEvent<HTMLElement>) =>
    event.currentTarget.closest<HTMLElement>("[data-canvas-card]")?.dataset.key ?? "";
  const onCardClick = useStableCallback((event: React.MouseEvent<HTMLElement>) =>
    props.onPeek(keyOf(event)),
  );
  const onCardOpen = useStableCallback((event: React.MouseEvent<HTMLElement>) =>
    props.onOpen(keyOf(event)),
  );
  const onCardKey = useStableCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    props.onOpen(keyOf(event));
  });
  // A card reached by keyboard comes into view.
  const onCardFocus = useStableCallback((event: React.FocusEvent<HTMLElement>) => {
    if (!event.currentTarget.matches(":focus-visible")) return;
    const box = layout.cards.get(keyOf(event));
    if (box === undefined) return;
    const { camera, width, height } = controller;
    if (kinCanvasOverlaps(box, kinCanvasVisible(camera, width, height), -box.w / 2)) return;
    controller.flyTo({
      x: box.x + box.w / 2,
      y: box.y + box.h / 2,
      scale: Math.max(camera.scale, 0.6),
    });
  });

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.target !== event.currentTarget) return;
    const step = 80;
    const keys: Record<string, () => void> = {
      ArrowLeft: () => controller.panBy(step, 0),
      ArrowRight: () => controller.panBy(-step, 0),
      ArrowUp: () => controller.panBy(0, step),
      ArrowDown: () => controller.panBy(0, -step),
      "+": () => controller.zoomAt(1.25),
      "=": () => controller.zoomAt(1.25),
      "-": () => controller.zoomAt(0.8),
    };
    const run = keys[event.key];
    if (run === undefined || event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    run();
  };

  const readSet = new Set(reading);
  return (
    <div
      ref={viewport}
      role="application"
      aria-label={KIN_CANVAS.title}
      aria-roledescription="map"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onClick={(event) => {
        if (event.target === event.currentTarget || event.target === world.current)
          props.onPeek(null);
      }}
      data-detail={detail}
      className="absolute inset-0 cursor-grab touch-none overflow-hidden bg-background outline-none select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-panning:cursor-grabbing"
    >
      <div
        ref={world}
        className="absolute top-0 left-0 origin-top-left [--kc-inv:1] [--kc-zoom:1]"
        onClick={(event) => {
          if (event.target === event.currentTarget) props.onPeek(null);
        }}
      >
        {layout.groups.map((box) => {
          const group = model.groups.find((held) => held.key === box.key);
          return (
            <section
              key={box.key}
              aria-label={box.title}
              className="pointer-events-none absolute top-0 left-0 rounded-3xl bg-muted/60"
              style={{
                transform: `translate(${box.x}px, ${box.y}px)`,
                width: box.w,
                height: box.h,
              }}
            >
              <div className="flex items-end px-6 pb-2" style={{ height: box.head }}>
                <div className="flex min-w-0 items-baseline gap-2">
                  <h3
                    className="min-w-0 truncate font-semibold text-foreground leading-tight tracking-tight"
                    style={{ fontSize: "calc(1.125rem * var(--kc-inv))" }}
                  >
                    {box.title}
                  </h3>
                  {group?.line == null || detail === "dots" ? null : (
                    <span
                      className={cn(
                        "shrink-0 truncate tabular-nums",
                        group.late ? "text-destructive-foreground" : "text-muted-foreground",
                      )}
                      style={{ fontSize: "calc(0.8125rem * var(--kc-inv))" }}
                    >
                      {group.line}
                    </span>
                  )}
                  {group === undefined || group.working === 0 ? null : (
                    <span
                      role="img"
                      aria-label={KIN_CANVAS.agentWorking}
                      className="flex shrink-0 items-center gap-0.5 self-center text-info-foreground tabular-nums"
                      style={{ fontSize: "calc(0.8125rem * var(--kc-inv))" }}
                    >
                      <BotIcon aria-hidden className="size-[1.1em]" />
                      {group.working}
                    </span>
                  )}
                </div>
              </div>
            </section>
          );
        })}
        {shown.map((key) => {
          const box = layout.cards.get(key);
          const card = model.cards.get(key);
          if (box === undefined || card === undefined) return null;
          return (
            <MapCard
              key={key}
              x={box.x}
              y={box.y}
              card={card}
              holder={props.holders.get(key) ?? null}
              detail={detail}
              read={readSet.has(key)}
              environmentId={props.environmentId}
              orgId={props.orgId}
              peeked={props.peek === key}
              onClick={onCardClick}
              onDoubleClick={onCardOpen}
              onKeyDown={onCardKey}
              onFocus={onCardFocus}
            />
          );
        })}
      </div>
    </div>
  );
}

interface MapCardProps {
  readonly x: number;
  readonly y: number;
  readonly card: KinCanvasCardView;
  readonly holder: KinWorkPrincipal | null;
  readonly detail: KinCanvasDetail;
  /** A doc near enough to read: its text is fetched and shown. */
  readonly read: boolean;
  readonly environmentId: KinWorkTarget["environmentId"];
  readonly orgId: KinWorkTarget["orgId"];
  readonly peeked: boolean;
  readonly onClick: (event: React.MouseEvent<HTMLElement>) => void;
  readonly onDoubleClick: (event: React.MouseEvent<HTMLElement>) => void;
  readonly onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
  readonly onFocus: (event: React.FocusEvent<HTMLElement>) => void;
}

/**
 * One task or doc. A button covers it, so it is one stop for the keyboard and one name for a
 * screen reader; what it shows beneath depends on the zoom.
 */
const MapCard = memo(function MapCard(props: MapCardProps) {
  const { card, detail } = props;
  const dot = detail === "dots";
  return (
    <div
      data-canvas-card=""
      data-key={card.key}
      className={cn(
        "absolute top-0 left-0 h-[132px] w-[240px] overflow-hidden",
        dot
          ? cn("rounded-4xl", TONE_FILL[card.tone])
          : "rounded-xl border bg-card text-card-foreground shadow-xs/5",
        !dot && (card.tone === "late" ? "border-destructive/45" : "border-border"),
        props.peeked && "ring-2 ring-ring",
      )}
      style={{ transform: `translate(${props.x}px, ${props.y}px)` }}
    >
      {dot ? null : detail === "titles" ? (
        <Title card={card} />
      ) : (
        <div
          aria-hidden
          className={cn(
            "flex size-full flex-col",
            // At the nearest zoom the card is drawn at the screen's own size, so its type is real-size.
            detail === "near" &&
              "h-[calc(132px*var(--kc-zoom))] w-[calc(240px*var(--kc-zoom))] origin-top-left scale-[calc(1/var(--kc-zoom))]",
          )}
        >
          {props.read ? (
            <NearDoc
              card={card}
              target={{ environmentId: props.environmentId, orgId: props.orgId }}
            />
          ) : (
            <Full card={card} holder={props.holder} near={detail === "near"} />
          )}
        </div>
      )}
      <button
        type="button"
        aria-label={card.accessibilityLabel}
        aria-pressed={props.peeked}
        onClick={props.onClick}
        onDoubleClick={props.onDoubleClick}
        onKeyDown={props.onKeyDown}
        onFocus={props.onFocus}
        className="absolute inset-0 cursor-pointer rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      />
    </div>
  );
});

function Title(props: { readonly card: KinCanvasCardView }) {
  const { card } = props;
  return (
    <div aria-hidden className="flex size-full flex-col gap-1 p-3">
      <span
        className={cn(
          "tabular-nums",
          card.tone === "late" ? "text-destructive-foreground" : "text-muted-foreground",
        )}
        style={{ fontSize: "calc(0.75rem * var(--kc-inv))" }}
      >
        {card.key}
      </span>
      <p
        className="line-clamp-3 font-medium leading-tight [overflow-wrap:anywhere]"
        style={{ fontSize: "calc(0.875rem * var(--kc-inv))" }}
      >
        {card.title}
      </p>
    </div>
  );
}

function Head(props: { readonly card: KinCanvasCardView }) {
  const { card } = props;
  const state = STATE_OF_TONE[card.tone];
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
      {state === null ? (
        <FileTextIcon aria-hidden className="size-4 shrink-0" />
      ) : (
        <KinWorkStateIcon state={state} />
      )}
      <span className="shrink-0 tabular-nums">{card.key}</span>
      <span aria-hidden>·</span>
      <span className={cn("truncate", card.tone === "late" && "text-destructive-foreground")}>
        {card.tone === "late" ? "Late" : card.status}
      </span>
      {card.working ? (
        <span className="ms-auto flex shrink-0 items-center gap-1 rounded-full bg-info/12 px-1.5 py-0.5 text-2xs text-info-foreground">
          <BotIcon aria-hidden className="size-3" />
          Agent
        </span>
      ) : null}
    </div>
  );
}

function Full(props: {
  readonly card: KinCanvasCardView;
  readonly holder: KinWorkPrincipal | null;
  readonly near: boolean;
}) {
  const { card, holder } = props;
  return (
    <div className="flex size-full flex-col gap-1.5 p-3">
      <Head card={card} />
      <p
        className={cn(
          "font-medium text-sm leading-snug [overflow-wrap:anywhere]",
          props.near ? "line-clamp-4" : "line-clamp-2",
        )}
      >
        {card.title}
      </p>
      <div className="mt-auto flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
        {holder === null ? null : <KinAvatar avatar={kinWorkAvatar(holder)} size="xs" />}
        <span className="truncate">{card.line}</span>
      </div>
      {props.near && card.summary !== null ? (
        <p className="line-clamp-2 text-muted-foreground text-xs">{card.summary}</p>
      ) : null}
      {props.near && card.working ? (
        <p className="text-info-foreground text-xs">{KIN_CANVAS.agentWorking}</p>
      ) : null}
    </div>
  );
}

/** A doc near enough to read: its latest text, as the doc page draws it, cut where the card ends. */
function NearDoc(props: { readonly card: KinCanvasCardView; readonly target: KinWorkTarget }) {
  const { card, target } = props;
  const { state } = useKinDoc(target, card.key as KinRecordKey, null);
  const doc = state._tag === "ready" ? state.value : null;
  let room = NEAR_TEXT;
  const text: string[] = [];
  for (const piece of doc === null ? [] : kinDocPieces(doc.body, doc)) {
    if (room <= 0) break;
    if (piece.type !== "text") continue;
    text.push(piece.text.slice(0, room));
    room -= piece.text.length;
  }
  return (
    <div className="flex size-full flex-col gap-1.5 p-3">
      <Head card={card} />
      <p className="line-clamp-2 font-medium text-sm leading-snug [overflow-wrap:anywhere]">
        {card.title}
      </p>
      <div className="relative min-h-0 flex-1 overflow-hidden text-sm leading-relaxed [mask-image:linear-gradient(to_bottom,black_70%,transparent)]">
        {doc === null ? (
          <p className="text-muted-foreground text-xs">
            {state._tag === "failed" ? KIN_CANVAS.readFailed : (card.summary ?? card.line)}
          </p>
        ) : (
          <ChatMarkdown
            text={kinDocMarkdown(text.join("\n\n"), fileImageSource)}
            cwd={undefined}
            environmentId={target.environmentId}
            imageAttachment={fileImageAttachment}
          />
        )}
      </div>
    </div>
  );
}
