import { kinCanvasFit } from "@t3tools/client-runtime/kin/kinCanvasCamera";
import { kinCanvasLayout, type KinCanvasLayout } from "@t3tools/client-runtime/kin/kinCanvasLayout";
import {
  KIN_CANVAS_LENSES,
  kinCanvasLensColumns,
  kinCanvasLensLayout,
  type KinCanvasLensId,
} from "@t3tools/client-runtime/kin/kinCanvasLens";
import {
  KIN_CANVAS,
  KIN_CANVAS_WIDGET_KINDS,
  kinCanvasActivityText,
  kinCanvasAskDraft,
  kinCanvasSinceLine,
} from "@t3tools/client-runtime/kin/kinCanvasView";
import { kinFailure } from "@t3tools/client-runtime/kin/kinAnswers";
import type { KinCanvasWidgetKind, KinRecordKey } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  BellDotIcon,
  CheckIcon,
  LayoutGridIcon,
  MaximizeIcon,
  MinusIcon,
  PlusIcon,
  HistoryIcon,
  XIcon,
} from "lucide-react";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";

import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../../components/WorkspaceBreadcrumb";
import { Button } from "../../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../../components/ui/empty";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../components/ui/menu";
import { Spinner } from "../../components/ui/spinner";
import { toastManager } from "../../components/ui/toast";
import { isElectron } from "../../env";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useAtomCommand } from "../../state/use-atom-command";
import { kinClient } from "../kinClient";
import { KinLoadFailed } from "../KinWorkParts";
import { useKinOpenChat } from "../useKinOpenChat";
import type { KinWorkTarget } from "../useKinWork";
import { AskMenu } from "./KinCanvasAsk";
import { KinCanvasBoard } from "./KinCanvasBoard";
import { KinCanvasController } from "./kinCanvasController";
import { KinCanvasMinimap } from "./KinCanvasMinimap";
import { KinCanvasPeek, type KinCanvasPeekTarget } from "./KinCanvasPeek";
import { useKinCanvas } from "./useKinCanvas";
import { WorkspacePageHeader } from "../../components/WorkspacePageHeader";

const CAMERA_KEY = (target: KinWorkTarget) => `kin:canvas:camera:${target.environmentId}:${target.orgId}`;

function savedCamera(target: KinWorkTarget) {
  try {
    const raw = sessionStorage.getItem(CAMERA_KEY(target));
    if (raw === null) return null;
    const camera = JSON.parse(raw) as { x: number; y: number; scale: number };
    return Number.isFinite(camera.x) && Number.isFinite(camera.y) && Number.isFinite(camera.scale)
      ? camera
      : null;
  } catch {
    return null;
  }
}

const KIN_CANVAS_LOOK_MS = 1500;

export function KinCanvasPage(props: KinWorkTarget) {
  const target = props;
  const data = useKinCanvas(target);
  const navigate = useNavigate();
  const openChat = useKinOpenChat();
  const narrow = useMediaQuery("(max-width: 767px)");
  const [controller] = useState(() => new KinCanvasController());
  const [lens, setLens] = useState<KinCanvasLensId | null>(null);
  const [gliding, setGliding] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [selecting, setSelecting] = useState(false);
  const [peek, setPeek] = useState<KinCanvasPeekTarget | null>(null);
  const [highlight, setHighlight] = useState<ReadonlySet<string>>(new Set());
  const [needsOpen, setNeedsOpen] = useState(false);
  const [sinceOpen, setSinceOpen] = useState(true);
  const [pending, setPending] = useState<ReadonlyMap<string, { x: number; y: number }>>(new Map());
  const place = useAtomCommand(kinClient.canvasPlace, { reportFailure: false });
  const unplace = useAtomCommand(kinClient.canvasUnplace, { reportFailure: false });
  const widgetAdd = useAtomCommand(kinClient.canvasWidgetAdd, { reportFailure: false });
  const widgetRemove = useAtomCommand(kinClient.canvasWidgetRemove, { reportFailure: false });
  const seen = useAtomCommand(kinClient.canvasSeen, { reportFailure: false });
  const openedRecord = useRef(false);
  const canArrange = data.canvas?.canArrange === true && lens === null;

  const places = new Map<string, { x: number; y: number }>();
  for (const held of data.canvas?.places ?? []) places.set(held.key, held);
  for (const [key, at] of pending) places.set(key, at);

  const stored: KinCanvasLayout = kinCanvasLayout({
    groups: data.model.groups,
    items: data.model.items,
    places,
    aspect: narrow ? 0.6 : 1.6,
  });
  const layout: KinCanvasLayout =
    lens === null
      ? stored
      : kinCanvasLensLayout(kinCanvasLensColumns(lens, data.model.lensTasks, data.nowMs), [
          ...data.model.widgets.keys(),
        ]);

  const fitAll = (instant = false) => {
    const camera = kinCanvasFit(layout.bounds, controller.width, controller.height, {
      // The return panel and agent chips sit over the top of the board.
      top: (data.canvas?.since.changes.length ?? 0) > 0 && sinceOpen ? 220 : 120,
      right: peek !== null && !narrow ? 380 : 0,
      bottom: narrow ? 96 : 24,
      left: 0,
    });
    if (instant) controller.set(camera);
    else controller.flyTo(camera);
  };

  // Where this person left the canvas in this tab, else everything in view.
  const onSized = useStableCallback(() => {
    const held = savedCamera(target);
    if (held === null) fitAll(true);
    else {
      controller.set(held);
      controller.keep();
    }
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps this person's view of the canvas in the tab's storage, for Back from a card they opened
  useEffect(
    () =>
      controller.settled((camera) => {
        try {
          sessionStorage.setItem(CAMERA_KEY(target), JSON.stringify(camera));
        } catch {
          // Storage can be blocked; the canvas fits everything next time instead.
        }
      }),
    [controller, target],
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the host this person has looked when they leave the canvas, unless for a card they opened from it; stops the camera
  useEffect(() => {
    const shownAt = performance.now();
    return () => {
      controller.dispose();
      // A glance shorter than this (or a dev remount) isn't a look.
      if (!openedRecord.current && performance.now() - shownAt > KIN_CANVAS_LOOK_MS)
        void seen({ environmentId: target.environmentId, input: { orgId: target.orgId } });
    };
  }, [controller, seen, target.environmentId, target.orgId]);

  const focusOn = (key: string, open = true) => {
    const box = layout.cards.get(key);
    if (box === undefined) return false;
    controller.flyTo({
      x: box.x + box.w / 2 + (!narrow && open ? 160 / Math.max(controller.camera.scale, 0.75) : 0),
      y: box.y + box.h / 2,
      scale: Math.max(controller.camera.scale, 0.9),
    });
    if (open) setPeek({ type: "card", key });
    return true;
  };

  // The peek covers the board's right edge on a wide window; a card under it slides into view.
  const revealBesidePeek = (key: string) => {
    const box = layout.cards.get(key);
    if (box === undefined || narrow) return;
    const { camera, width } = controller;
    const right = (box.x + box.w - camera.x) * camera.scale + width / 2;
    const room = width - 400;
    if (right > room) controller.flyTo({ ...camera, x: camera.x + (right - room) / camera.scale });
  };

  const openRecord = (key: string, kind: "task" | "doc" | "project" = data.model.cards.get(key)?.kind ?? "task") => {
    openedRecord.current = true;
    const params = { environmentId: target.environmentId, orgId: target.orgId };
    const recordKey = key as KinRecordKey;
    if (kind === "doc")
      void navigate({ to: "/kin/$environmentId/$orgId/docs", params, search: { doc: recordKey } });
    else if (kind === "project")
      void navigate({ to: "/kin/$environmentId/$orgId/clients", params, search: { project: recordKey } });
    else void navigate({ to: "/kin/$environmentId/$orgId/tasks", params, search: { task: recordKey } });
  };

  const ask = (agent: { readonly ownerChatId: string }, keys: ReadonlyArray<string>) => {
    const cards = keys.flatMap((key) => {
      const card = data.model.cards.get(key);
      const widget = data.model.widgets.get(key);
      return card !== undefined
        ? [{ key: card.key, title: card.title }]
        : widget !== undefined
          ? [{ key: widget.sourceKey, title: widget.title }]
          : [];
    });
    openedRecord.current = true;
    openChat(target.environmentId, target.orgId, agent.ownerChatId as never, kinCanvasAskDraft(cards));
  };

  const problem = (cause: unknown, what: string) =>
    toastManager.add({ type: "error", title: kinFailure(cause, what).text });

  const onMove = async (key: string, x: number, y: number) => {
    setPending((held) => new Map(held).set(key, { x, y }));
    const result = await place({
      environmentId: target.environmentId,
      input: { orgId: target.orgId, places: [{ key: key as never, x, y }] },
    });
    // The host's places carry it from here, or it goes back where it was.
    setPending((held) => {
      const next = new Map(held);
      next.delete(key);
      return next;
    });
    if (AsyncResult.isFailure(result)) problem(result.cause, KIN_CANVAS.movedFailed);
  };

  const addWidget = async (kind: KinCanvasWidgetKind, source: string) => {
    const result = await widgetAdd({
      environmentId: target.environmentId,
      input: { orgId: target.orgId, kind, source: source as KinRecordKey },
    });
    if (AsyncResult.isFailure(result)) problem(result.cause, "Couldn't add the widget");
    else if (AsyncResult.isSuccess(result)) setPeek({ type: "card", key: result.value.id });
  };

  const removeWidget = async (id: string) => {
    const result = await widgetRemove({
      environmentId: target.environmentId,
      input: { orgId: target.orgId, id: id as never },
    });
    if (AsyncResult.isFailure(result)) problem(result.cause, "Couldn't remove the widget");
    else setPeek(null);
  };

  const putBack = async (key: string) => {
    const result = await unplace({
      environmentId: target.environmentId,
      input: { orgId: target.orgId, keys: [key as never] },
    });
    if (AsyncResult.isFailure(result)) problem(result.cause, KIN_CANVAS.movedFailed);
  };

  const toggleSelect = (key: string) =>
    setSelected((held) => {
      const next = new Set(held);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const chooseLens = (id: KinCanvasLensId | null) => {
    setGliding(true);
    setLens(id);
    setPeek(null);
    window.setTimeout(() => setGliding(false), 340);
    requestAnimationFrame(() => requestAnimationFrame(() => fitAll()));
  };

  const needsCount = (data.needsRows?.needs.length ?? 0) + (data.needsRows?.attention.length ?? 0);
  const since = data.canvas?.since;
  const sinceLine = data.canvas === null ? null : kinCanvasSinceLine(data.canvas, data.names);
  const activity = data.canvas?.activity ?? [];
  const empty = !data.loading && data.model.items.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <WorkspacePageHeader electron={isElectron}>
        <WorkspaceBreadcrumb ariaLabel="Kin">
          <WorkspaceBreadcrumbItem current>
            <h1 className="truncate">{KIN_CANVAS.title}</h1>
          </WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
        <div className="ms-auto flex items-center gap-1">
          <Button
            size="sm"
            variant={needsOpen ? "secondary" : "ghost"}
            aria-pressed={needsOpen}
            onClick={() => {
              setNeedsOpen((open) => !open);
              setPeek(null);
            }}
          >
            <BellDotIcon />
            <span className="max-sm:sr-only">{KIN_CANVAS.needsYou}</span>
            {needsCount > 0 ? <span className="tabular-nums">{needsCount}</span> : null}
          </Button>
          <Menu>
            <MenuTrigger render={<Button size="sm" variant={lens === null ? "ghost" : "secondary"} />}>
              <LayoutGridIcon />
              <span className="max-sm:sr-only">
                {lens === null ? KIN_CANVAS.lens : KIN_CANVAS_LENSES.find((l) => l.id === lens)?.label}
              </span>
            </MenuTrigger>
            <MenuPopup align="end">
              {KIN_CANVAS_LENSES.map((option) => (
                <MenuItem key={option.id} onClick={() => chooseLens(option.id)}>
                  {option.label}
                  {lens === option.id ? <CheckIcon className="ms-auto" /> : null}
                </MenuItem>
              ))}
              {lens !== null ? <MenuItem onClick={() => chooseLens(null)}>{KIN_CANVAS.backToCanvas}</MenuItem> : null}
            </MenuPopup>
          </Menu>
          <Button
            size="sm"
            variant={selecting ? "secondary" : "ghost"}
            aria-pressed={selecting}
            onClick={() => {
              setSelecting((on) => !on);
              setSelected(new Set());
            }}
          >
            {selecting ? KIN_CANVAS.selectDone : KIN_CANVAS.select}
          </Button>
        </div>
      </WorkspacePageHeader>

      <div className="relative min-h-0 flex-1">
        {data.canvasFailed && data.model.items.length === 0 ? (
          <KinLoadFailed
            className="absolute inset-0 items-center justify-center p-6"
            what={KIN_CANVAS.loadFailed}
            cause={null}
            onRetry={data.retry}
          />
        ) : data.loading ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <Spinner aria-label="Loading the canvas" />
          </div>
        ) : empty ? (
          <Empty className="absolute inset-0">
            <EmptyHeader>
              <EmptyTitle>{KIN_CANVAS.empty}</EmptyTitle>
              <EmptyDescription>{KIN_CANVAS.emptyDetail}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <KinCanvasBoard
            controller={controller}
            layout={layout}
            model={data.model}
            selected={selected}
            peek={peek?.type === "card" ? peek.key : null}
            highlight={highlight}
            gliding={gliding}
            groupMenus={lens === null}
            canArrange={canArrange && !selecting}
            onPeek={(key) => {
              setHighlight(new Set());
              if (key === null) {
                setPeek(null);
                return;
              }
              if (selecting) toggleSelect(key);
              else {
                setNeedsOpen(false);
                setPeek({ type: "card", key });
                revealBesidePeek(key);
              }
            }}
            onToggleSelect={toggleSelect}
            onMove={(key, x, y) => void onMove(key, x, y)}
            onSized={onSized}
            onGroup={(key) => {
              setNeedsOpen(false);
              setPeek(key === null ? null : { type: "group", key });
            }}
          >
            {/* Overlays: inside the board so the camera's size is the board's. */}
            <div data-canvas-control="" className="pointer-events-none absolute inset-x-3 top-3 flex flex-col items-start gap-2">
              {lens !== null ? (
                <div className="pointer-events-auto flex items-center gap-2 rounded-full border bg-popover px-3 py-1.5 text-sm shadow-sm">
                  <span>{KIN_CANVAS_LENSES.find((l) => l.id === lens)?.label}</span>
                  <Button size="compact" variant="ghost" onClick={() => chooseLens(null)}>
                    {KIN_CANVAS.backToCanvas}
                  </Button>
                </div>
              ) : null}
              {sinceLine !== null && lens === null ? (
                <section
                  aria-label={KIN_CANVAS.sinceTitle}
                  className="pointer-events-auto w-full max-w-sm rounded-xl border bg-popover p-3 text-popover-foreground text-sm shadow-sm"
                >
                  <div className="flex items-start gap-2">
                    <HistoryIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <p className="min-w-0 flex-1">{sinceLine}</p>
                    {since !== undefined && since.changes.length > 0 ? (
                      <Button size="compact" variant="ghost" onClick={() => setSinceOpen((open) => !open)}>
                        {sinceOpen ? "Hide" : "Show"}
                      </Button>
                    ) : null}
                  </div>
                  {sinceOpen && since !== undefined && since.changes.length > 0 ? (
                    <ul className="mt-2 max-h-48 space-y-0.5 overflow-y-auto" data-canvas-control="">
                      {since.changes.slice(0, 12).map((change) => {
                        const on = data.model.cards.has(change.key);
                        return (
                          <li key={change.key}>
                            <button
                              type="button"
                              className="flex w-full items-baseline gap-2 rounded-md px-1.5 py-1 text-start hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none"
                              onClick={() => (on ? focusOn(change.key) : openRecord(change.key))}
                            >
                              <span className="shrink-0 text-muted-foreground text-xs tabular-nums">{change.key}</span>
                              <span className="min-w-0 flex-1 truncate">{change.title}</span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                  {since !== undefined && since.seenAt !== null && since.changes.length > 0 ? (
                    <Button
                      className="mt-2"
                      size="compact"
                      variant="outline"
                      onClick={async () => {
                        await seen({ environmentId: target.environmentId, input: { orgId: target.orgId } });
                        data.retry();
                      }}
                    >
                      {KIN_CANVAS.markSeen}
                    </Button>
                  ) : null}
                </section>
              ) : null}
              {activity.length > 0 ? (
                <ul aria-label="Agents working" className="pointer-events-auto flex flex-wrap gap-1.5">
                  {activity.map((entry) => (
                    <li key={`${entry.agentId}:${entry.chatId}`}>
                      <button
                        type="button"
                        className="inline-flex h-8 items-center gap-1.5 rounded-full border bg-popover px-3 text-sm shadow-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none"
                        onClick={() => {
                          const first = entry.keys.find((key) => layout.cards.has(key));
                          if (first !== undefined) focusOn(first);
                          else openChat(target.environmentId, target.orgId, entry.chatId);
                        }}
                      >
                        <span aria-hidden className="size-2 rounded-full bg-primary" />
                        {kinCanvasActivityText(entry)}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>

            <div data-canvas-control="" className="absolute bottom-3 left-3 flex items-center gap-1 rounded-lg border bg-popover p-1 shadow-sm max-md:bottom-24">
              <Button size="icon-sm" variant="ghost" aria-label={KIN_CANVAS.zoomOut} onClick={() => controller.zoomAt(0.8)}>
                <MinusIcon />
              </Button>
              <Button size="icon-sm" variant="ghost" aria-label={KIN_CANVAS.zoomIn} onClick={() => controller.zoomAt(1.25)}>
                <PlusIcon />
              </Button>
              <Button size="sm" variant="ghost" onClick={() => fitAll()}>
                <MaximizeIcon />
                {KIN_CANVAS.showAll}
              </Button>
            </div>

            {!narrow ? <KinCanvasMinimap controller={controller} layout={layout} /> : null}

            {selected.size > 0 ? (
              <div data-canvas-control="" className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border bg-popover py-1 ps-4 pe-1 text-sm shadow-md max-md:bottom-24">
                <span className="tabular-nums">{selected.size} selected</span>
                <AskMenu leads={data.leads} onAsk={(agent) => ask(agent, [...selected])} />
                <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                  {KIN_CANVAS.clearSelection}
                </Button>
              </div>
            ) : null}
          </KinCanvasBoard>
        )}

        {needsOpen ? (
          <aside
            aria-label={KIN_CANVAS.needsYou}
            className="absolute inset-y-0 end-0 z-20 flex w-full max-w-sm flex-col border-s bg-popover shadow-lg max-md:inset-x-0 max-md:top-auto max-md:max-h-[70%] max-md:max-w-none max-md:rounded-t-2xl max-md:border-t max-md:border-s-0"
          >
            <div className="flex items-center gap-2 border-b px-4 py-3">
              <h2 className="font-semibold text-sm">{KIN_CANVAS.needsYou}</h2>
              <Button className="ms-auto" size="icon-sm" variant="ghost" aria-label="Close" onClick={() => setNeedsOpen(false)}>
                <XIcon />
              </Button>
            </div>
            <ul className="min-h-0 flex-1 overflow-y-auto p-2">
              {needsCount === 0 ? <li className="p-3 text-muted-foreground text-sm">Nothing needs you right now.</li> : null}
              {[
                ...(data.needsRows?.needs ?? []).map((row) => ({
                  id: row.id,
                  title: row.title,
                  detail: row.detail,
                  urgent: row.late,
                  key: row.open.type === "task" ? (row.open.key as string) : null,
                  chat: row.open.type === "chat" ? row.open.chatId : null,
                })),
                ...(data.needsRows?.attention ?? []).map((row) => ({
                  id: row.id,
                  title: row.title,
                  detail: row.detail,
                  urgent: row.urgent,
                  key: row.open.type === "record" ? (row.open.key as string) : null,
                  chat: null,
                })),
              ].map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    className="flex w-full flex-col items-start gap-0.5 rounded-lg px-3 py-2 text-start hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none"
                    onClick={() => {
                      if (row.key !== null && focusOn(row.key)) {
                        setNeedsOpen(false);
                        setHighlight(new Set([row.key]));
                      } else if (row.key !== null) openRecord(row.key);
                      else if (row.chat !== null) openChat(target.environmentId, target.orgId, row.chat);
                    }}
                  >
                    <span className="font-medium text-sm">{row.title}</span>
                    <span className={row.urgent ? "text-destructive-foreground text-xs" : "text-muted-foreground text-xs"}>
                      {row.detail}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </aside>
        ) : null}

        {peek !== null ? (
          <KinCanvasPeek
            target={peek}
            model={data.model}
            layout={layout}
            canArrange={data.canvas?.canArrange === true}
            placed={peek.type === "card" && places.has(peek.key) && lens === null}
            leads={data.leads}
            onClose={() => setPeek(null)}
            onOpen={openRecord}
            onAsk={(agent, key) => ask(agent, [key])}
            onAddWidget={(kind: KinCanvasWidgetKind, source: string) => void addWidget(kind, source)}
            onRemoveWidget={(id) => void removeWidget(id)}
            onPutBack={(key) => void putBack(key)}
            onShowSources={(keys) => {
              setHighlight(new Set(keys));
              const first = keys.find((key) => layout.cards.has(key));
              if (first !== undefined) focusOn(first, false);
            }}
            widgetKinds={KIN_CANVAS_WIDGET_KINDS}
          />
        ) : null}
      </div>
    </div>
  );
}
