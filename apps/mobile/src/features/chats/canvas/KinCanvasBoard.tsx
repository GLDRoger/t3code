import {
  KIN_CANVAS_MAX_SCALE,
  KIN_CANVAS_MIN_SCALE,
  kinCanvasVisible,
  type KinCanvasCamera,
  type KinCanvasDetail,
} from "@t3tools/client-runtime/kin/kinCanvasCamera";
import {
  kinCanvasOverlaps,
  type KinCanvasLayout,
} from "@t3tools/client-runtime/kin/kinCanvasLayout";
import { KIN_CANVAS, type KinCanvasModel } from "@t3tools/client-runtime/kin/kinCanvasView";
import { useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import {
  GestureDetector,
  usePanGesture,
  usePinchGesture,
  useSimultaneousGestures,
  useTapGesture,
} from "react-native-gesture-handler";
import Animated, {
  cancelAnimation,
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
} from "react-native-reanimated";

import { AppText as Text } from "../../../components/ui/AppText";
import { SymbolView } from "../../../components/ui/AppSymbol";
import { KinCanvasCard, KIN_CANVAS_WORLD_HALF } from "./KinCanvasCard";
import type { CanvasCamera } from "./useCanvasCamera";

/** Past this many cards, only those near the view are mounted. */
const CULL_FROM = 60;
const DETAILS: ReadonlyArray<KinCanvasDetail> = ["dots", "titles", "cards"];

export interface KinCanvasBoardProps {
  readonly camera: CanvasCamera;
  readonly layout: KinCanvasLayout;
  readonly model: KinCanvasModel;
  /** Where the camera rests, and where a flight is headed: cards near either stay mounted. */
  readonly views: ReadonlyArray<KinCanvasCamera>;
  readonly selected: ReadonlySet<string>;
  readonly peek: string | null;
  readonly highlight: ReadonlySet<string>;
  readonly gliding: boolean;
  readonly reduceMotion: boolean;
  readonly canArrange: boolean;
  readonly onCard: (key: string) => void;
  readonly onGroup: (key: string) => void;
  readonly onMove: (key: string, x: number, y: number) => void;
  /** The board has a size for the first time: place the camera. */
  readonly onSized: () => void;
  readonly children?: ReactNode;
}

export function KinCanvasBoard(props: KinCanvasBoardProps) {
  const { camera, layout, views } = props;
  const { x, y, scale, width, height } = camera;
  const [size, setSize] = useState<{ readonly w: number; readonly h: number } | null>(null);
  const [detail, setDetail] = useState<KinCanvasDetail>("cards");

  // kinCanvasDetail's bands, read on the UI thread; React hears only a change of band.
  useAnimatedReaction(
    () => (scale.get() < 0.22 ? 0 : scale.get() < 0.55 ? 1 : 2),
    (band, previous) => {
      if (band !== previous) runOnJS(setDetail)(DETAILS[band] ?? "cards");
    },
  );

  const { settled } = camera;
  const stop = () => {
    "worklet";
    cancelAnimation(x);
    cancelAnimation(y);
    cancelAnimation(scale);
  };
  const pan = usePanGesture({
    averageTouches: true,
    onActivate: () => stop(),
    onUpdate: (event) => {
      x.set(x.get() - event.changeX / scale.get());
      y.set(y.get() - event.changeY / scale.get());
    },
    onDeactivate: () => runOnJS(settled)(),
  });
  const pinch = usePinchGesture({
    onActivate: () => stop(),
    onUpdate: (event) => {
      const s = scale.get();
      const next = Math.min(
        KIN_CANVAS_MAX_SCALE,
        Math.max(KIN_CANVAS_MIN_SCALE, s * event.scaleChange),
      );
      const fx = event.focalX - width.get() / 2;
      const fy = event.focalY - height.get() / 2;
      x.set(x.get() + fx / s - fx / next);
      y.set(y.get() + fy / s - fy / next);
      scale.set(next);
    },
    onDeactivate: () => runOnJS(settled)(),
  });
  const zoomIn = (sx: number, sy: number) => {
    const s = camera.get();
    const next = Math.min(KIN_CANVAS_MAX_SCALE, s.scale * 1.6);
    const fx = sx - width.get() / 2;
    const fy = sy - height.get() / 2;
    camera.flyTo({
      x: s.x + fx / s.scale - fx / next,
      y: s.y + fy / s.scale - fy / next,
      scale: next,
    });
  };
  const doubleTap = useTapGesture({
    numberOfTaps: 2,
    onActivate: (event) => runOnJS(zoomIn)(event.x, event.y),
  });
  const gestures = useSimultaneousGestures(pan, pinch, doubleTap);

  const world = useAnimatedStyle(() => ({
    transform: [
      { translateX: width.get() / 2 - x.get() * scale.get() },
      { translateY: height.get() / 2 - y.get() * scale.get() },
      { scale: scale.get() },
    ],
  }));

  const rest = views[0];
  const inv = detail === "cards" || rest === undefined ? 1 : Math.min(3.2, 1 / rest.scale);
  const boxes = [...layout.cards.values()];
  const near =
    boxes.length <= CULL_FROM || size === null || views.length === 0
      ? null
      : views.map((view) => {
          const seen = kinCanvasVisible(view, size.w, size.h);
          return { x: seen.x - seen.w, y: seen.y - seen.h, w: seen.w * 3, h: seen.h * 3 };
        });
  const shown =
    near === null ? boxes : boxes.filter((box) => near.some((n) => kinCanvasOverlaps(box, n)));

  return (
    <View
      className="flex-1 overflow-hidden bg-subtle"
      onLayout={(event) => {
        const { width: w, height: h } = event.nativeEvent.layout;
        width.set(w);
        height.set(h);
        if (w === 0) return;
        setSize({ w, h });
        if (size === null) props.onSized();
      }}
    >
      <GestureDetector gesture={gestures}>
        <View
          collapsable={false}
          className="absolute inset-0"
          accessibilityLabel={KIN_CANVAS.title}
          accessibilityHint="Drag to move around, pinch to zoom"
        >
          <Animated.View
            style={[
              {
                position: "absolute",
                left: -KIN_CANVAS_WORLD_HALF,
                top: -KIN_CANVAS_WORLD_HALF,
                width: KIN_CANVAS_WORLD_HALF * 2,
                height: KIN_CANVAS_WORLD_HALF * 2,
              },
              world,
            ]}
          >
            {layout.groups.map((group) => {
              const groupKey = group.key;
              return (
                <View
                  key={group.key ?? "none"}
                  pointerEvents="box-none"
                  className="absolute rounded-2xl border border-border bg-screen/60"
                  style={{
                    left: group.x + KIN_CANVAS_WORLD_HALF,
                    top: group.y + KIN_CANVAS_WORLD_HALF,
                    width: group.w,
                    height: group.h,
                  }}
                >
                  <View className="flex-row items-center gap-2 px-6" style={{ height: group.head }}>
                    <Text
                      numberOfLines={1}
                      className="min-w-0 shrink font-t3-semibold"
                      style={{ fontSize: 18 * inv, lineHeight: 23 * inv }}
                    >
                      {group.title}
                    </Text>
                    {groupKey !== null &&
                    detail !== "dots" &&
                    props.model.groups.some((g) => g.key === groupKey) ? (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`${group.title}: more`}
                        onPress={() => props.onGroup(groupKey)}
                        hitSlop={8}
                        className="ml-auto size-11 items-center justify-center rounded-full active:bg-subtle-strong"
                      >
                        <SymbolView
                          name="ellipsis"
                          size={18}
                          tintColorClassName="accent-icon-muted"
                        />
                      </Pressable>
                    ) : null}
                  </View>
                </View>
              );
            })}
            {shown.map((box) => {
              const card = props.model.cards.get(box.key);
              const widget = props.model.widgets.get(box.key);
              if (card === undefined && widget === undefined) return null;
              return (
                <KinCanvasCard
                  key={box.key}
                  cardKey={box.key}
                  x={box.x}
                  y={box.y}
                  card={card}
                  widget={widget}
                  detail={detail}
                  inv={inv}
                  selected={props.selected.has(box.key)}
                  peeked={props.peek === box.key}
                  highlighted={props.highlight.has(box.key)}
                  gliding={props.gliding}
                  reduceMotion={props.reduceMotion}
                  draggable={props.canArrange}
                  scale={scale}
                  onPress={props.onCard}
                  onMove={props.onMove}
                />
              );
            })}
          </Animated.View>
        </View>
      </GestureDetector>
      {props.children}
    </View>
  );
}
