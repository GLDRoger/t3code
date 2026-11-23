import { kinCanvasLayout } from "@t3tools/client-runtime/kin/kinCanvasLayout";
import { kinCanvasFit } from "@t3tools/client-runtime/kin/kinCanvasCamera";
import { KIN_CANVAS, kinCanvasHeadline } from "@t3tools/client-runtime/kin/kinCanvasView";
import type { KinRecordKey } from "@t3tools/contracts";
import { ExternalLinkIcon, MaximizeIcon, MinusIcon, PlusIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { Button } from "../../components/ui/button";
import { Spinner } from "../../components/ui/spinner";
import { Toggle, ToggleGroup } from "../../components/ui/toggle-group";
import { useStableCallback } from "../../hooks/useStableCallback";
import { cn } from "../../lib/utils";
import type { KinDocWhere } from "../KinDocPage";
import { KinLoadFailed, KinWorkNotice } from "../KinWorkParts";
import type { KinWorkTarget } from "../useKinWork";
import { KinCanvasBoard } from "./KinCanvasBoard";
import { KinCanvasController } from "./kinCanvasController";
import { useKinCanvas, type KinCanvasTasks } from "./useKinCanvas";

/** What is open beside the map: a task, or a doc as the doc page shows it. */
export type KinDocsMapPeek =
  | { readonly kind: "task"; readonly key: KinRecordKey }
  | { readonly kind: "doc"; readonly where: KinDocWhere };

const keyOfPeek = (peek: KinDocsMapPeek) => (peek.kind === "doc" ? peek.where.doc : peek.key);

/** On a narrow window the peek covers this share of the map's foot. */
const SHEET = 0.6;

/**
 * Docs as a map: every task in progress (or open) and every doc, grouped by project, read only.
 * Zooming in says more about each card; a card opens beside the map without leaving it.
 */
export function KinDocsMap(
  props: KinWorkTarget & {
    /** Wide enough for the peek to sit beside the map rather than over its foot. */
    readonly wide: boolean;
    /** The real doc page or task panel for what is peeked; `onPeek` moves the peek or closes it. */
    readonly renderPeek: (
      peek: KinDocsMapPeek,
      onPeek: (next: KinDocsMapPeek | null) => void,
    ) => ReactNode;
    /** Leaves the map for the record's own page. */
    readonly onOpen: (peek: KinDocsMapPeek) => void;
  },
) {
  const { wide } = props;
  const data = useKinCanvas(props);
  const { model } = data;
  const layout = kinCanvasLayout({
    groups: model.groups,
    items: model.items,
    aspect: wide ? 1.6 : 0.6,
  });
  const [controller] = useState(() => new KinCanvasController());
  const [peek, setPeek] = useState<KinDocsMapPeek | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- stops the camera's frames and timers when the map leaves
  useEffect(() => () => controller.dispose(), [controller]);

  const peekOf = (key: string): KinDocsMapPeek | null => {
    const card = model.cards.get(key);
    if (card === undefined) return null;
    return card.kind === "doc"
      ? { kind: "doc", where: { doc: card.key as KinRecordKey } }
      : { kind: "task", key: card.key as KinRecordKey };
  };

  const fitAll = (instant: boolean) => {
    const camera = kinCanvasFit(layout.bounds, controller.width, controller.height, {
      top: 0,
      right: 0,
      bottom: peek !== null && !wide ? controller.height * SHEET : 48,
      left: 0,
    });
    if (instant) controller.set(camera);
    else controller.flyTo(camera);
  };
  const onSized = useStableCallback(() => fitAll(true));

  // The card comes to the middle of what the peek leaves free.
  const bringIn = (key: string) => {
    const box = layout.cards.get(key);
    if (box === undefined) return;
    const scale = Math.max(controller.camera.scale, 0.6);
    const lift = wide ? 0 : (controller.height * SHEET) / 2 / scale;
    controller.flyTo({ x: box.x + box.w / 2, y: box.y + box.h / 2 + lift, scale });
  };

  const show = (next: KinDocsMapPeek | null) => {
    const was = peek;
    setPeek(next);
    if (next !== null) bringIn(keyOfPeek(next));
    else if (was !== null)
      // Focus goes back to the card that was open, when it is still on the map.
      document
        .querySelector<HTMLElement>(`[data-canvas-card][data-key="${keyOfPeek(was)}"] button`)
        ?.focus({ preventScroll: true });
  };
  const onPeek = useStableCallback((key: string | null) => show(key === null ? null : peekOf(key)));
  const onOpen = useStableCallback((key: string) => {
    const target = peekOf(key);
    if (target !== null) props.onOpen(target);
  });

  const headline = data.status === "ready" ? kinCanvasHeadline(model) : "";
  const body =
    data.status === "refused" ? (
      <KinWorkNotice title={KIN_CANVAS.refusedTitle} detail={KIN_CANVAS.refusedDetail} />
    ) : data.status === "offline" ? (
      <KinWorkNotice title={KIN_CANVAS.offlineTitle} detail={KIN_CANVAS.offlineDetail} />
    ) : data.status === "failed" ? (
      <KinLoadFailed
        what={KIN_CANVAS.loadFailed}
        cause={null}
        onRetry={data.retry}
        className="mx-auto w-full max-w-3xl p-4"
      />
    ) : data.status === "loading" ? (
      <div
        role="status"
        aria-label="Loading the map"
        className="flex flex-1 items-center justify-center"
      >
        <Spinner />
      </div>
    ) : model.items.length === 0 ? (
      <KinWorkNotice
        title={data.view === "open" ? KIN_CANVAS.emptyOpen : KIN_CANVAS.empty}
        detail={KIN_CANVAS.emptyDetail}
        action={
          data.tasks && data.view === "doing" ? (
            <Button size="sm" variant="outline" onClick={() => data.setView("open")}>
              {KIN_CANVAS.allOpen}
            </Button>
          ) : undefined
        }
      />
    ) : null;

  return (
    <div
      className="flex min-h-0 flex-1"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented || peek === null) return;
        // Escape in a menu or dialog the peek opened is theirs: those render outside this element.
        if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
        event.preventDefault();
        show(null);
      }}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
          {data.tasks ? (
            <ToggleGroup
              aria-label="Tasks shown"
              value={[data.view]}
              onValueChange={(value) => {
                const next = value[0];
                if (next === "doing" || next === "open")
                  data.setView(next satisfies KinCanvasTasks);
              }}
            >
              <Toggle value="doing">{KIN_CANVAS.doing}</Toggle>
              <Toggle value="open">{KIN_CANVAS.allOpen}</Toggle>
            </ToggleGroup>
          ) : null}
          <p className="min-w-0 truncate text-muted-foreground text-sm tabular-nums">{headline}</p>
        </div>
        <div className="relative min-h-0 flex-1">
          {body ?? (
            <>
              <KinCanvasBoard
                {...props}
                controller={controller}
                layout={layout}
                model={model}
                holders={data.holders}
                peek={peek === null ? null : keyOfPeek(peek)}
                onPeek={onPeek}
                onOpen={onOpen}
                onSized={onSized}
              />
              {data.partial.length === 0 ? null : (
                <p
                  role="status"
                  className="pointer-events-none absolute start-3 bottom-3 max-w-[calc(100%-10rem)] rounded-lg border bg-popover px-2.5 py-1.5 text-muted-foreground text-xs shadow-xs/5"
                >
                  {data.partial.join(" · ")}
                </p>
              )}
              <div
                className={cn(
                  "absolute end-3 bottom-3 flex items-center gap-0.5 rounded-lg border bg-popover p-0.5 shadow-xs/5",
                  peek !== null && !wide && "hidden",
                )}
              >
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={KIN_CANVAS.zoomOut}
                  onClick={() => controller.zoomAt(0.8)}
                >
                  <MinusIcon />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={KIN_CANVAS.showAll}
                  onClick={() => fitAll(false)}
                >
                  <MaximizeIcon />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={KIN_CANVAS.zoomIn}
                  onClick={() => controller.zoomAt(1.25)}
                >
                  <PlusIcon />
                </Button>
              </div>
            </>
          )}
          {peek === null || wide ? null : (
            <Peek
              peek={peek}
              wide={false}
              renderPeek={props.renderPeek}
              onPeek={show}
              onOpen={props.onOpen}
            />
          )}
        </div>
      </div>
      {peek === null || !wide ? null : (
        <Peek peek={peek} wide renderPeek={props.renderPeek} onPeek={show} onOpen={props.onOpen} />
      )}
    </div>
  );
}

function Peek(props: {
  readonly peek: KinDocsMapPeek;
  readonly wide: boolean;
  readonly renderPeek: (
    peek: KinDocsMapPeek,
    onPeek: (next: KinDocsMapPeek | null) => void,
  ) => ReactNode;
  readonly onPeek: (next: KinDocsMapPeek | null) => void;
  readonly onOpen: (peek: KinDocsMapPeek) => void;
}) {
  return (
    <aside
      aria-label={keyOfPeek(props.peek)}
      className={cn(
        "flex min-h-0 flex-col bg-background",
        props.wide
          ? "w-md shrink-0 border-s"
          : "absolute inset-x-0 bottom-0 z-10 h-[60%] rounded-t-2xl border-t shadow-lg",
      )}
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {props.renderPeek(props.peek, props.onPeek)}
      </div>
      <div className="flex shrink-0 items-center justify-end border-t px-3 py-2">
        <Button size="sm" variant="outline" onClick={() => props.onOpen(props.peek)}>
          <ExternalLinkIcon />
          {KIN_CANVAS.open}
        </Button>
      </div>
    </aside>
  );
}
