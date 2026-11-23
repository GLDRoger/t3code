import {
  KIN_CANVAS_MAX_SCALE,
  KIN_CANVAS_MIN_SCALE,
  kinCanvasDetail,
  kinCanvasVisible,
  type KinCanvasCamera,
  type KinCanvasDetail,
} from "@t3tools/client-runtime/kin/kinCanvasCamera";
import {
  kinCanvasOverlaps,
  type KinCanvasLayout,
} from "@t3tools/client-runtime/kin/kinCanvasLayout";
import type { KinCanvasModel } from "@t3tools/client-runtime/kin/kinCanvasView";
import { useState, type ReactNode } from "react";
import { View } from "react-native";
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
import { cn } from "../../../lib/cn";
import type { KinWorkTarget } from "../state/useKinWork";
import { KinCanvasCard, KIN_CANVAS_WORLD_HALF } from "./KinCanvasCard";
import type { CanvasCamera } from "./useCanvasCamera";

/** Past this many cards, only those near the view are mounted. */
const CULL_FROM = 60;
const DETAILS: ReadonlyArray<KinCanvasDetail> = ["dots", "titles", "cards", "near"];

/** `kinCanvasNearScale` and `kinCanvasMaxScale` again, as worklets for the UI thread. */
const nearScale = (width: number) => {
  "worklet";
  return Math.max(1, Math.min(1.6, (width * 0.75) / 240));
};
const maxScale = (width: number) => {
  "worklet";
  return Math.max(nearScale(width) * 1.15, Math.min(KIN_CANVAS_MAX_SCALE, (width - 24) / 240));
};

export interface KinCanvasBoardProps {
  readonly target: KinWorkTarget;
  readonly camera: CanvasCamera;
  readonly layout: KinCanvasLayout;
  readonly model: KinCanvasModel;
  /** Where a flight is headed: cards near it mount before the camera arrives. */
  readonly heading: KinCanvasCamera | null;
  readonly peek: string | null;
  readonly onCard: (key: string) => void;
  /** The board has a size for the first time: place the camera. */
  readonly onSized: (size: { readonly w: number; readonly h: number }) => void;
  readonly children?: ReactNode;
}

export function KinCanvasBoard(props: KinCanvasBoardProps) {
  const { camera, layout } = props;
  const { x, y, scale, width, height } = camera;
  const [size, setSize] = useState<{ readonly w: number; readonly h: number } | null>(null);
  const [detail, setDetail] = useState<KinCanvasDetail>(() =>
    kinCanvasDetail(camera.get().scale, width.get()),
  );
  // Where the camera is, a step at a time: React re-culls as a pan crosses a quarter screen.
  const [view, setView] = useState<KinCanvasCamera | null>(null);

  // kinCanvasDetail's bands, worked out again on the UI thread; React hears only a change of band.
  useAnimatedReaction(
    () => {
      const s = scale.get();
      return s < 0.22 ? 0 : s < 0.55 ? 1 : s < nearScale(width.get()) ? 2 : 3;
    },
    (band, previous) => {
      if (band !== previous) runOnJS(setDetail)(DETAILS[band] ?? "cards");
    },
  );
  useAnimatedReaction(
    () => {
      const s = scale.get();
      const stepX = Math.max(1, width.get() / s / 4);
      const stepY = Math.max(1, height.get() / s / 4);
      return `${Math.round(x.get() / stepX)}:${Math.round(y.get() / stepY)}:${Math.round(Math.log2(s) * 2)}`;
    },
    (cell, previous) => {
      if (cell !== previous) runOnJS(setView)({ x: x.get(), y: y.get(), scale: scale.get() });
    },
  );

  const { touched } = camera;
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
    onDeactivate: () => runOnJS(touched)(),
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
    onDeactivate: () => runOnJS(touched)(),
  });
  const zoomIn = (sx: number, sy: number) => {
    const s = camera.get();
    const next = Math.min(maxScale(width.get()), s.scale * 1.8);
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

  const at = view ?? camera.get();
  // Zoomed out, type is drawn larger so the names of things stay readable.
  const inv = detail === "cards" || detail === "near" ? 1 : Math.min(3.2, 1 / at.scale);
  const boxes = [...layout.cards.values()];
  const near =
    boxes.length <= CULL_FROM || size === null
      ? null
      : [at, ...(props.heading === null ? [] : [props.heading])].map((one) => {
          const seen = kinCanvasVisible(one, size.w, size.h);
          return { x: seen.x - seen.w / 2, y: seen.y - seen.h / 2, w: seen.w * 2, h: seen.h * 2 };
        });
  const shown =
    near === null ? boxes : boxes.filter((box) => near.some((n) => kinCanvasOverlaps(box, n)));
  const groupOf = new Map(props.model.groups.map((group) => [group.key, group]));

  return (
    <View
      className="flex-1 overflow-hidden bg-subtle"
      onLayout={(event) => {
        const { width: w, height: h } = event.nativeEvent.layout;
        width.set(w);
        height.set(h);
        if (w === 0) return;
        setSize({ w, h });
        if (size === null) props.onSized({ w, h });
      }}
    >
      <GestureDetector gesture={gestures}>
        <View
          collapsable={false}
          className="absolute inset-0"
          accessibilityLabel="Map of tasks and docs"
          accessibilityHint="Drag to move around, pinch or double-tap to zoom"
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
            {layout.groups.map((box) => {
              const group = groupOf.get(box.key);
              return (
                <View
                  key={box.key}
                  pointerEvents="none"
                  className={cn(
                    "absolute rounded-3xl border",
                    group !== undefined && group.working > 0
                      ? "border-primary/30 bg-primary/5"
                      : "border-border bg-screen/70",
                  )}
                  style={{
                    left: box.x + KIN_CANVAS_WORLD_HALF,
                    top: box.y + KIN_CANVAS_WORLD_HALF,
                    width: box.w,
                    height: box.h,
                  }}
                >
                  <View className="justify-center px-6" style={{ height: box.head }}>
                    <Text
                      numberOfLines={1}
                      className="font-t3-semibold"
                      // Zoomed out the name grows to stay readable, never past the band it sits in.
                      style={{
                        fontSize: Math.min(17 * inv, 30),
                        lineHeight: Math.min(22 * inv, 36),
                      }}
                    >
                      {box.title}
                    </Text>
                    {group?.line != null && inv === 1 ? (
                      <Text
                        textRole="caption"
                        numberOfLines={1}
                        className={cn(
                          group.late ? "text-danger-foreground" : "text-foreground-muted",
                        )}
                      >
                        {group.line}
                      </Text>
                    ) : null}
                  </View>
                </View>
              );
            })}
            {shown.map((box) => {
              const card = props.model.cards.get(box.key);
              if (card === undefined) return null;
              return (
                <KinCanvasCard
                  key={box.key}
                  target={props.target}
                  x={box.x}
                  y={box.y}
                  card={card}
                  detail={detail}
                  inv={inv}
                  peeked={props.peek === box.key}
                  onPress={props.onCard}
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
