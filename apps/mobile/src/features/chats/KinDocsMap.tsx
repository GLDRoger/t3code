import { kinCanvasFit, type KinCanvasCamera } from "@t3tools/client-runtime/kin/kinCanvasCamera";
import { kinCanvasLayout } from "@t3tools/client-runtime/kin/kinCanvasLayout";
import {
  KIN_CANVAS,
  kinCanvasHeadline,
  type KinCanvasCardView,
} from "@t3tools/client-runtime/kin/kinCanvasView";
import { KIN_RETRY } from "@t3tools/client-runtime/kin/kinAnswers";
import { KIN_WORK_HOME } from "@t3tools/client-runtime/kin/kinWorkHome";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { useBarOverlap } from "../../components/ui/useBarInset";
import { useReduceMotionEnabled } from "../../lib/appState";
import { KinCanvasBoard } from "./canvas/KinCanvasBoard";
import {
  KinCanvasPartial,
  KinCanvasShowSwitch,
  KinCanvasZoomControls,
} from "./canvas/KinCanvasOverlays";
import { KinCanvasPeek } from "./canvas/KinCanvasPeek";
import { useCanvasCamera } from "./canvas/useCanvasCamera";
import { KinWorkLoading } from "./components/KinWorkPieces";
import { useKinTab } from "./components/KinTab";
import { useKinWorkLink } from "./state/kinWorkLink";
import { useKinCanvas } from "./state/useKinCanvas";
import type { KinWorkTarget } from "./state/useKinWork";

/** The bar's switch between Docs' two views. */
export function kinDocsViewAction(view: "list" | "map", onPress: () => void) {
  return view === "list"
    ? { accessibilityLabel: `Show ${KIN_CANVAS.title}`, icon: "map" as const, onPress }
    : { accessibilityLabel: `Show ${KIN_CANVAS.list}`, icon: "list.bullet" as const, onPress };
}

/**
 * Docs as a map: every project an area with its tasks in progress and its docs, zoomed like a
 * map. Close in, a doc shows its text on the card; a tap reads it over the map.
 */
export function KinDocsMap(props: KinWorkTarget & { readonly onList: () => void }) {
  const target = { environmentId: props.environmentId, orgId: props.orgId };
  const data = useKinCanvas(target);
  const tab = useKinTab();
  const bar = (
    <AppBar title={KIN_WORK_HOME.places.docs} actions={[kinDocsViewAction("map", props.onList)]} />
  );
  const message = (body: React.ReactNode) => (
    <View collapsable={false} className="flex-1 bg-screen">
      {bar}
      <View
        className="flex-1 justify-center p-4"
        style={{ paddingBottom: tab?.bottomClearance ?? 0 }}
      >
        {body}
      </View>
    </View>
  );
  if (data.status === "offline")
    return message(
      <EmptyState
        variant="plain"
        title={KIN_CANVAS.offlineTitle}
        detail={KIN_CANVAS.offlineDetail}
      />,
    );
  if (data.status === "refused")
    return message(
      <EmptyState
        variant="plain"
        title={KIN_CANVAS.refusedTitle}
        detail={KIN_CANVAS.refusedDetail}
      />,
    );
  if (data.status === "failed")
    return message(
      <EmptyState
        variant="plain"
        title={KIN_CANVAS.loadFailed}
        detail={KIN_CANVAS.loadFailedDetail}
        action={<Button tone="secondary" label={KIN_RETRY} onPress={data.retry} />}
      />,
    );
  if (data.status === "loading") return message(<KinWorkLoading label={KIN_CANVAS.loading} />);
  return <KinDocsMapReady {...target} data={data} bar={bar} />;
}

function KinDocsMapReady(
  props: KinWorkTarget & {
    readonly data: ReturnType<typeof useKinCanvas>;
    readonly bar: React.ReactNode;
  },
) {
  const { data, environmentId, orgId } = props;
  const tab = useKinTab();
  const insets = useSafeAreaInsets();
  const barOverlap = useBarOverlap();
  const reduceMotion = useReduceMotionEnabled();
  const openLink = useKinWorkLink();
  const [peek, setPeek] = useState<KinCanvasCardView | null>(null);
  const [heading, setHeading] = useState<KinCanvasCamera | null>(null);
  const camera = useCanvasCamera(`${environmentId}:${orgId}:docs`, reduceMotion, () =>
    setHeading(null),
  );
  const layout = kinCanvasLayout({
    groups: data.model.groups,
    items: data.model.items,
    aspect: 0.7,
  });

  // The map starts below the bar, not under it: a moving map behind the title can't be read.
  const top = 8;
  const bottom = (tab?.bottomClearance ?? insets.bottom) + 12;
  // The switch above and the controls below cover the board's edges; fits keep cards clear of them.
  const free = { top: top + 48, right: 0, bottom: bottom + 64, left: 0 };

  const fly = (to: KinCanvasCamera) => {
    setHeading(to);
    camera.flyTo(to);
  };
  const fitAll = (instant = false, measured?: { readonly w: number; readonly h: number }) => {
    const to = kinCanvasFit(
      layout.bounds,
      measured?.w ?? camera.width.get(),
      measured?.h ?? camera.height.get(),
      free,
      16,
    );
    if (instant) camera.set(to);
    else fly(to);
  };

  const { x: bx, y: by, w: bw, h: bh } = layout.bounds;
  /* oxlint-disable react/exhaustive-effect-dependencies, react/set-state-in-effect -- only a change of
     extent refits; the camera, which lives outside React, and the insets are read as they are then */
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refits the camera to the map as its extent changes, until the person moves it
  useEffect(() => {
    if (camera.moved() || camera.width.get() === 0) return;
    fitAll(true);
  }, [bx, by, bw, bh]);
  /* oxlint-enable react/exhaustive-effect-dependencies, react/set-state-in-effect */

  /** Bring a card to the strip of map the peek sheet leaves showing, at a size to read its title. */
  const reveal = (card: KinCanvasCardView) => {
    const box = layout.cards.get(card.key);
    if (box === undefined) return;
    const scale = Math.min(Math.max(camera.scale.get(), 0.9), 1.2);
    const height = camera.height.get();
    const visibleMiddle = height * 0.25;
    fly({
      x: box.x + box.w / 2,
      y: box.y + box.h / 2 + (height / 2 - visibleMiddle) / scale,
      scale,
    });
  };
  const open = (card: KinCanvasCardView) => {
    setPeek(null);
    const base = { environmentId: String(environmentId), orgId: String(orgId) };
    if (card.kind === "doc") openLink("KinDoc", { ...base, doc: card.key });
    else openLink("KinWorkItem", { ...base, task: card.key });
  };

  const empty = data.model.cards.size === 0;
  const headline = kinCanvasHeadline(data.model);
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      {props.bar}
      <View className="flex-1" style={{ marginTop: barOverlap }}>
        <KinCanvasBoard
          target={props}
          camera={camera}
          layout={layout}
          model={data.model}
          heading={heading}
          peek={peek?.key ?? null}
          onCard={(key) => {
            const card = data.model.cards.get(key);
            if (card === undefined) return;
            setPeek(card);
            reveal(card);
          }}
          onSized={(size) => {
            if (camera.held) camera.settled();
            else fitAll(true, size);
          }}
        >
          <View
            pointerEvents="box-none"
            className="absolute inset-x-0 items-center gap-2 px-3"
            style={{ top }}
          >
            {data.tasks ? <KinCanvasShowSwitch show={data.view} onShow={data.setView} /> : null}
            {headline === "" ? null : (
              <View className="rounded-full bg-card/90 px-3 py-1">
                <Text textRole="caption" className="text-foreground-muted">
                  {headline}
                </Text>
              </View>
            )}
          </View>
          {empty ? (
            <View pointerEvents="none" className="absolute inset-0 justify-center px-8">
              <EmptyState
                variant="plain"
                title={data.view === "doing" ? KIN_CANVAS.empty : KIN_CANVAS.emptyOpen}
                detail={KIN_CANVAS.emptyDetail}
              />
            </View>
          ) : null}
          <View
            pointerEvents="box-none"
            className="absolute inset-x-0 flex-row items-end justify-between gap-2 px-3"
            style={{ bottom }}
          >
            <View className="min-w-0 shrink">
              <KinCanvasPartial lines={data.partial} onRetry={data.failed ? data.retry : null} />
            </View>
            {empty ? null : (
              <KinCanvasZoomControls
                onZoomOut={() => camera.zoomBy(0.7)}
                onZoomIn={() => camera.zoomBy(1.4)}
                onShowAll={() => fitAll()}
              />
            )}
          </View>
        </KinCanvasBoard>
      </View>
      {peek !== null ? (
        <KinCanvasPeek target={props} card={peek} onClose={() => setPeek(null)} onOpen={open} />
      ) : null}
    </View>
  );
}
