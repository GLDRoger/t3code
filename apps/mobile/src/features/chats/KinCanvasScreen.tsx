import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { kinFailure } from "@t3tools/client-runtime/kin/kinAnswers";
import { kinCanvasFit, type KinCanvasCamera } from "@t3tools/client-runtime/kin/kinCanvasCamera";
import {
  kinCanvasDrop,
  kinCanvasLayout,
  type KinCanvasLayout,
} from "@t3tools/client-runtime/kin/kinCanvasLayout";
import {
  KIN_CANVAS_LENSES,
  kinCanvasLensColumns,
  kinCanvasLensLayout,
  type KinCanvasLensId,
} from "@t3tools/client-runtime/kin/kinCanvasLens";
import {
  KIN_CANVAS,
  kinCanvasAskDraft,
  kinCanvasSinceLine,
} from "@t3tools/client-runtime/kin/kinCanvasView";
import {
  EnvironmentId,
  KinCanvasWidgetId,
  KinOrgId,
  KinRecordKey,
  type KinCanvasActivity,
  type KinCanvasItemKey,
  type KinCanvasWidgetKind,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import type { AppBarAction, AppBarMenu } from "../../components/ui/AppBar.types";
import { EmptyState } from "../../components/ui/EmptyState";
import { Notice } from "../../components/ui/Notice";
import { useBarOverlap } from "../../components/ui/useBarInset";
import { useReduceMotionEnabled } from "../../lib/appState";
import { useAtomCommand } from "../../state/use-atom-command";
import { KinCanvasBoard } from "./canvas/KinCanvasBoard";
import {
  KinCanvasActivityChips,
  KinCanvasNeedsSheet,
  KinCanvasSelectionBar,
  KinCanvasSincePanel,
  KinCanvasZoomControls,
  type KinCanvasNeedsRow,
} from "./canvas/KinCanvasOverlays";
import { KinCanvasPeek, type KinCanvasPeekTarget } from "./canvas/KinCanvasPeek";
import { useCanvasCamera } from "./canvas/useCanvasCamera";
import { KinLoadFailed } from "./components/KinLoadFailed";
import { useKinTab } from "./components/KinTab";
import { kinClient } from "./state/kinClient";
import { useKinWorkLink } from "./state/kinWorkLink";
import { useKinCanvas, type KinCanvasLead } from "./state/useKinCanvas";
import { useKinOpenChat } from "./state/useKinOpenChat";
import type { KinWorkTarget } from "./state/useKinWork";

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);
const decodeWidgetId = Schema.decodeUnknownOption(KinCanvasWidgetId);

/** The canvas pushed from a link: `kin/:environmentId/:orgId/canvas`. */
export function KinCanvasRouteScreen({
  route,
}: StaticScreenProps<{ readonly environmentId: string; readonly orgId: string }>) {
  const navigation = useNavigation();
  const environmentId = Option.getOrNull(decodeEnvironmentId(route.params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(route.params.orgId));
  if (environmentId === null || orgId === null) {
    return (
      <View collapsable={false} className="flex-1 bg-screen">
        <AppBar title={KIN_CANVAS.title} onBack={() => navigation.goBack()} />
        <View className="flex-1 justify-center p-4">
          <EmptyState
            variant="plain"
            title="This link doesn't open anything"
            detail="Open the canvas from your Kin chats."
          />
        </View>
      </View>
    );
  }
  return <KinCanvasScreen environmentId={environmentId} orgId={orgId} />;
}

/** The canvas: a tab of the Kin home inside a `KinTabContext`, or a pushed page. */
export function KinCanvasScreen(props: KinWorkTarget) {
  const target = { environmentId: props.environmentId, orgId: props.orgId };
  const navigation = useNavigation();
  const tab = useKinTab();
  const data = useKinCanvas(target);
  const onBack = tab === null ? { onBack: () => navigation.goBack() } : {};
  const ready = data.work._tag === "ready";
  const message = (body: React.ReactNode) => (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar title={KIN_CANVAS.title} {...onBack} />
      <View
        className="flex-1 justify-center p-4"
        style={{ paddingBottom: tab?.bottomClearance ?? 0 }}
      >
        {body}
      </View>
    </View>
  );
  if (data.work._tag === "refused")
    return message(
      <EmptyState
        variant="plain"
        title={KIN_CANVAS.refusedTitle}
        detail={KIN_CANVAS.refusedDetail}
      />,
    );
  if (data.work._tag === "offline")
    return message(
      <EmptyState
        variant="plain"
        title={KIN_CANVAS.offlineTitle}
        detail={KIN_CANVAS.offlineDetail}
      />,
    );
  if (data.work._tag === "failed" || (data.canvasFailed && data.model.items.length === 0))
    return message(
      <KinLoadFailed
        title={KIN_CANVAS.loadFailed}
        cause={data.work._tag === "failed" ? null : data.canvasResult}
        onRetry={data.retry}
      />,
    );
  if (!ready || data.loading)
    return message(
      <View
        className="items-center py-12"
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel="Loading the canvas"
      >
        <AppActivityIndicator />
      </View>,
    );
  if (data.model.items.length === 0)
    return message(
      <EmptyState variant="plain" title={KIN_CANVAS.empty} detail={KIN_CANVAS.emptyDetail} />,
    );
  return <KinCanvasLoaded target={target} data={data} onBack={onBack} />;
}

function KinCanvasLoaded(props: {
  readonly target: KinWorkTarget;
  readonly data: ReturnType<typeof useKinCanvas>;
  readonly onBack: { readonly onBack?: () => void };
}) {
  const { target, data } = props;
  const { environmentId, orgId } = target;
  const tab = useKinTab();
  const insets = useSafeAreaInsets();
  const barOverlap = useBarOverlap();
  const reduceMotion = useReduceMotionEnabled();
  const openRecordLink = useKinWorkLink();
  const openChat = useKinOpenChat();
  const [lens, setLens] = useState<KinCanvasLensId | null>(null);
  const [gliding, setGliding] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [selecting, setSelecting] = useState(false);
  const [peek, setPeek] = useState<KinCanvasPeekTarget | null>(null);
  const [highlight, setHighlight] = useState<ReadonlySet<string>>(new Set());
  const [needsOpen, setNeedsOpen] = useState(false);
  const [sinceOpen, setSinceOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<ReadonlyMap<string, { x: number; y: number }>>(new Map());
  const [views, setViews] = useState<ReadonlyArray<KinCanvasCamera>>([]);
  const place = useAtomCommand(kinClient.canvasPlace, { reportFailure: false });
  const unplace = useAtomCommand(kinClient.canvasUnplace, { reportFailure: false });
  const widgetAdd = useAtomCommand(kinClient.canvasWidgetAdd, { reportFailure: false });
  const widgetRemove = useAtomCommand(kinClient.canvasWidgetRemove, { reportFailure: false });
  const seen = useAtomCommand(kinClient.canvasSeen, { reportFailure: false });
  const camera = useCanvasCamera(`${environmentId}:${orgId}`, reduceMotion, (rest) =>
    setViews([rest]),
  );
  const canArrange = data.canvas?.canArrange === true;

  const places = new Map<string, { x: number; y: number }>();
  for (const held of data.canvas?.places ?? []) places.set(held.key, held);
  // A move stays shown as pending until the host's own places carry it.
  const caughtUp = [...pending].filter(([key, at]) => {
    const held = places.get(key);
    return held?.x === at.x && held.y === at.y;
  });
  if (caughtUp.length > 0)
    setPending((held) => {
      const next = new Map(held);
      for (const [key] of caughtUp) next.delete(key);
      return next;
    });
  for (const [key, at] of pending) places.set(key, at);

  const layoutFor = (id: KinCanvasLensId | null): KinCanvasLayout =>
    id === null
      ? kinCanvasLayout({
          groups: data.model.groups,
          items: data.model.items,
          places,
          aspect: 0.6,
        })
      : kinCanvasLensLayout(kinCanvasLensColumns(id, data.model.lensTasks, data.nowMs), [
          ...data.model.widgets.keys(),
        ]);
  const layout = layoutFor(lens);

  const bottomClearance = tab?.bottomClearance ?? insets.bottom;
  const top = barOverlap + 8;
  const bottom = bottomClearance + 12;

  const fly = (to: KinCanvasCamera) => {
    setViews([camera.get(), to]);
    camera.flyTo(to);
  };
  const fitTo = (
    bounds: KinCanvasLayout["bounds"],
    instant = false,
    // A size just measured: the shared values may not read it back on this thread yet.
    measured?: { readonly w: number; readonly h: number },
  ) => {
    const w = measured?.w ?? camera.width.get();
    const h = measured?.h ?? camera.height.get();
    const to = kinCanvasFit(bounds, w, h, {
      top: top + 56,
      right: 0,
      bottom: bottom + 56,
      left: 0,
    });
    if (instant) camera.set(to);
    else fly(to);
  };

  const { x: boundsX, y: boundsY, w: boundsW, h: boundsH } = layout.bounds;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refits the camera, which lives outside React, to the board as its cards arrive, until the person moves it
  useEffect(() => {
    if (camera.moved() || camera.width.get() === 0) return;
    // oxlint-disable-next-line react/set-state-in-effect -- the refit tells the board its new view once, for culling and text size.
    fitTo({ x: boundsX, y: boundsY, w: boundsW, h: boundsH }, true);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- only a change of the board's extent refits; the camera and insets are read as they are then.
  }, [boundsX, boundsY, boundsW, boundsH]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the host this person has looked when the canvas leaves the screen
  useEffect(() => {
    const shownAt = performance.now();
    return () => {
      // A glance shorter than this (or a dev remount) isn't a look.
      if (performance.now() - shownAt > 1500) void seen({ environmentId, input: { orgId } });
    };
  }, [seen, environmentId, orgId]);

  const focusOn = (key: string, open = true) => {
    const box = layout.cards.get(key);
    if (box === undefined) return false;
    const scale = Math.max(camera.scale.get(), 0.9);
    // The peek covers the lower part and the bar and return panel the top; the card rests between.
    const height = camera.height.get();
    const between = (top + 120 + height * 0.55) / 2;
    const lift = open ? (height / 2 - between) / scale : 0;
    fly({ x: box.x + box.w / 2, y: box.y + box.h / 2 + lift, scale });
    if (open) setPeek({ type: "card", key });
    return true;
  };

  const kindOf = (key: string) => data.model.cards.get(key)?.kind ?? "task";
  const openRecord = (key: string, kind: "task" | "doc" | "project" = kindOf(key)) => {
    setPeek(null);
    setNeedsOpen(false);
    const base = { environmentId: String(environmentId), orgId: String(orgId) };
    if (kind === "doc") openRecordLink("KinDoc", { ...base, doc: key });
    else if (kind === "project") openRecordLink("KinProject", { ...base, project: key });
    else openRecordLink("KinWorkItem", { ...base, task: key });
  };

  const ask = (lead: KinCanvasLead, keys: ReadonlyArray<string>) => {
    const cards = keys.flatMap((key) => {
      const card = data.model.cards.get(key);
      const widget = data.model.widgets.get(key);
      return card !== undefined
        ? [{ key: card.key, title: card.title }]
        : widget !== undefined
          ? [{ key: widget.sourceKey, title: widget.title }]
          : [];
    });
    setPeek(null);
    openChat(environmentId, orgId, lead.ownerChatId, kinCanvasAskDraft(cards));
  };

  const problem = (cause: unknown, what: string) => setNotice(kinFailure(cause, what).text);

  const onMove = async (key: string, x: number, y: number) => {
    const dropped = kinCanvasDrop(layout, key, x, y);
    setPending((held) => {
      const next = new Map(held);
      for (const at of dropped) next.set(at.key, at);
      return next;
    });
    const result = await place({
      environmentId,
      input: { orgId, places: dropped.map((at) => ({ ...at, key: at.key as KinCanvasItemKey })) },
    });
    if (!AsyncResult.isFailure(result)) return;
    // They go back where they were.
    setPending((held) => {
      const next = new Map(held);
      for (const at of dropped) next.delete(at.key);
      return next;
    });
    problem(result.cause, KIN_CANVAS.movedFailed);
  };

  const addWidget = async (kind: KinCanvasWidgetKind, source: string) => {
    const result = await widgetAdd({
      environmentId,
      input: { orgId, kind, source: source as KinRecordKey },
    });
    if (AsyncResult.isFailure(result)) problem(result.cause, KIN_CANVAS.widgetAddFailed);
    else if (AsyncResult.isSuccess(result)) setPeek({ type: "card", key: result.value.id });
  };

  const removeWidget = async (id: string) => {
    const widgetId = Option.getOrNull(decodeWidgetId(id));
    if (widgetId === null) return;
    const result = await widgetRemove({ environmentId, input: { orgId, id: widgetId } });
    if (AsyncResult.isFailure(result)) problem(result.cause, KIN_CANVAS.widgetRemoveFailed);
    else setPeek(null);
  };

  const putBack = async (key: string) => {
    const result = await unplace({
      environmentId,
      input: { orgId, keys: [key as KinCanvasItemKey] },
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
    if (!reduceMotion) {
      setGliding(true);
      setTimeout(() => setGliding(false), 340);
    }
    setLens(id);
    setPeek(null);
    fitTo(layoutFor(id).bounds);
  };

  const onActivity = (entry: KinCanvasActivity) => {
    const first = entry.keys.find((key) => layout.cards.has(key));
    if (first !== undefined) focusOn(first);
    else openChat(environmentId, orgId, entry.chatId);
  };

  const needsRows: ReadonlyArray<KinCanvasNeedsRow> = [
    ...data.mine.map((task) => ({
      id: `mine:${task.key}`,
      title: task.title,
      detail: data.model.cards.get(task.key)?.line ?? task.key,
      urgent: task.late,
      key: task.key as string,
      chat: null,
    })),
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
  ];
  const onNeedsRow = (row: KinCanvasNeedsRow) => {
    if (row.key !== null && layout.cards.has(row.key)) {
      setNeedsOpen(false);
      setHighlight(new Set([row.key]));
      focusOn(row.key, false);
    } else if (row.key !== null) openRecord(row.key);
    else if (row.chat !== null) {
      setNeedsOpen(false);
      openChat(environmentId, orgId, row.chat);
    }
  };

  const since = data.canvas?.since;
  const sinceLine = data.canvas === null ? null : kinCanvasSinceLine(data.canvas, data.names);
  const activity = data.canvas?.activity ?? [];

  const actions: ReadonlyArray<AppBarAction> = [
    {
      accessibilityLabel:
        needsRows.length > 0 ? `${KIN_CANVAS.needsYou}: ${needsRows.length}` : KIN_CANVAS.needsYou,
      icon: "bell.badge",
      selected: needsOpen,
      onPress: () => {
        setPeek(null);
        setNeedsOpen((open) => !open);
      },
    },
    {
      accessibilityLabel: selecting ? KIN_CANVAS.selectDone : KIN_CANVAS.select,
      icon: "checkmark.circle",
      selected: selecting,
      onPress: () => {
        setSelecting((on) => !on);
        setSelected(new Set());
      },
    },
  ];
  const menus: ReadonlyArray<AppBarMenu> = [
    {
      title: KIN_CANVAS.lens,
      icon: "square.grid.2x2",
      ...(lens === null ? {} : { status: KIN_CANVAS_LENSES.find((l) => l.id === lens)?.label }),
      items: [
        ...KIN_CANVAS_LENSES.map((option) => ({
          id: option.id,
          title: option.label,
          selected: lens === option.id,
          onPress: () => chooseLens(option.id),
        })),
        ...(lens === null
          ? []
          : [{ id: "canvas", title: KIN_CANVAS.backToCanvas, onPress: () => chooseLens(null) }]),
      ],
    },
  ];

  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar title={KIN_CANVAS.title} {...props.onBack} actions={actions} menus={menus} />
      <KinCanvasBoard
        camera={camera}
        layout={layout}
        model={data.model}
        views={views}
        selected={selected}
        peek={peek?.type === "card" ? peek.key : null}
        highlight={highlight}
        gliding={gliding}
        reduceMotion={reduceMotion}
        canArrange={canArrange && lens === null && !selecting}
        onCard={(key) => {
          setHighlight(new Set());
          if (selecting) toggleSelect(key);
          else {
            setNeedsOpen(false);
            setPeek({ type: "card", key });
          }
        }}
        onGroup={(key) => {
          setNeedsOpen(false);
          setPeek({ type: "group", key });
        }}
        onMove={(key, x, y) => void onMove(key, x, y)}
        onSized={(size) => {
          if (camera.held) camera.settled();
          else fitTo(layout.bounds, true, size);
        }}
      >
        <View pointerEvents="box-none" className="absolute inset-x-0 gap-2 px-3" style={{ top }}>
          {lens !== null ? (
            <View className="flex-row">
              <KinCanvasLensBadge
                label={KIN_CANVAS_LENSES.find((l) => l.id === lens)?.label ?? ""}
                onBack={() => chooseLens(null)}
              />
            </View>
          ) : sinceLine !== null && since !== undefined ? (
            <KinCanvasSincePanel
              line={sinceLine}
              since={since}
              open={sinceOpen}
              onToggle={() => setSinceOpen((open) => !open)}
              onChange={(key) => {
                // Folded, so the card it flies to isn't under the list.
                setSinceOpen(false);
                if (!focusOn(key)) openRecord(key);
              }}
              onMarkSeen={async () => {
                await seen({ environmentId, input: { orgId } });
                data.retry();
              }}
            />
          ) : null}
          <KinCanvasActivityChips activity={activity} onPress={onActivity} />
        </View>
        <View
          pointerEvents="box-none"
          className="absolute inset-x-0 items-start gap-2 px-3"
          style={{ bottom }}
        >
          {notice !== null ? (
            <View className="self-stretch">
              <Notice floating tone="danger" message={notice} onDismiss={() => setNotice(null)} />
            </View>
          ) : null}
          {selected.size > 0 ? (
            <View className="self-center">
              <KinCanvasSelectionBar
                count={selected.size}
                leads={data.leads}
                onAsk={(lead) => ask(lead, [...selected])}
                onClear={() => setSelected(new Set())}
              />
            </View>
          ) : null}
          <KinCanvasZoomControls
            onZoomOut={() => camera.zoomBy(0.8)}
            onZoomIn={() => camera.zoomBy(1.25)}
            onShowAll={() => fitTo(layout.bounds)}
          />
        </View>
      </KinCanvasBoard>

      {needsOpen ? (
        <KinCanvasNeedsSheet
          rows={needsRows}
          onClose={() => setNeedsOpen(false)}
          onRow={onNeedsRow}
        />
      ) : null}
      {peek !== null ? (
        <KinCanvasPeek
          target={peek}
          model={data.model}
          layout={layout}
          canArrange={canArrange}
          placed={peek.type === "card" && places.has(peek.key) && lens === null}
          leads={data.leads}
          onClose={() => setPeek(null)}
          onOpen={openRecord}
          onAsk={(lead, key) => ask(lead, [key])}
          onAddWidget={(kind, source) => void addWidget(kind, source)}
          onRemoveWidget={(id) => void removeWidget(id)}
          onPutBack={(key) => void putBack(key)}
          onShowSources={(keys) => {
            setPeek(null);
            setHighlight(new Set(keys));
            const first = keys.find((key) => layout.cards.has(key));
            if (first !== undefined) focusOn(first, false);
          }}
        />
      ) : null}
    </View>
  );
}

function KinCanvasLensBadge(props: { readonly label: string; readonly onBack: () => void }) {
  return (
    <View className="flex-row items-center gap-1 rounded-full border border-border bg-card py-1 pr-1 pl-4">
      <Text textRole="footnote">{props.label}</Text>
      <Button size="compact" tone="text" label={KIN_CANVAS.backToCanvas} onPress={props.onBack} />
    </View>
  );
}
