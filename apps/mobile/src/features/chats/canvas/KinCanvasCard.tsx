import type { KinCanvasDetail } from "@t3tools/client-runtime/kin/kinCanvasCamera";
import {
  KIN_CANVAS_CARD_H,
  KIN_CANVAS_CARD_W,
  kinCanvasSnap,
} from "@t3tools/client-runtime/kin/kinCanvasLayout";
import {
  KIN_CANVAS,
  type KinCanvasCardView,
  type KinCanvasWidgetView,
} from "@t3tools/client-runtime/kin/kinCanvasView";
import type { KinRecordState } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { memo, useEffect } from "react";
import { Pressable, View } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, {
  Easing,
  ReduceMotion,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";

import { AppText as Text } from "../../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../../components/ui/AppSymbol";
import { cn } from "../../../lib/cn";
import { KinWorkStateSymbol } from "../components/KinWorkStateSymbol";

/** Half the world view's side: it is centred on the canvas origin so cards far out still take touches. */
export const KIN_CANVAS_WORLD_HALF = 20_000;

const GLIDE = {
  duration: 300,
  easing: Easing.out(Easing.cubic),
  reduceMotion: ReduceMotion.System,
};

const STATE_OF_TONE: Record<KinCanvasCardView["tone"], KinRecordState | null> = {
  late: "open",
  done: "done",
  doing: "doing",
  waiting: "waiting",
  open: "open",
  doc: null,
};

const WIDGET_ICON: Record<KinCanvasWidgetView["widget"]["kind"], AppSymbolName> = {
  progress: "chart.bar.xaxis",
  facts: "list.bullet",
  countdown: "timer",
};

export interface KinCanvasCardProps {
  readonly cardKey: string;
  readonly x: number;
  readonly y: number;
  readonly card: KinCanvasCardView | undefined;
  readonly widget: KinCanvasWidgetView | undefined;
  readonly detail: KinCanvasDetail;
  /** How much larger type is drawn zoomed out, so titles stay readable. */
  readonly inv: number;
  readonly selected: boolean;
  readonly peeked: boolean;
  readonly highlighted: boolean;
  readonly gliding: boolean;
  readonly reduceMotion: boolean;
  readonly draggable: boolean;
  readonly scale: SharedValue<number>;
  readonly onPress: (key: string) => void;
  readonly onMove: (key: string, x: number, y: number) => void;
}

/**
 * One card on the canvas. Its place is a shared value, so a drag moves it on the UI thread and a
 * lens change glides it; React only says where it belongs.
 */
export const KinCanvasCard = memo(function KinCanvasCard(props: KinCanvasCardProps) {
  const { card, widget, x, y, gliding, reduceMotion, scale } = props;
  const px = useSharedValue(x);
  const py = useSharedValue(y);
  const fromX = useSharedValue(x);
  const fromY = useSharedValue(y);
  const lifted = useSharedValue(0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves the card's native place to its layout place, gliding only while a lens changes
  useEffect(() => {
    if (gliding && !reduceMotion) {
      px.set(withTiming(x, GLIDE));
      py.set(withTiming(y, GLIDE));
    } else {
      px.set(x);
      py.set(y);
    }
  }, [x, y, gliding, reduceMotion, px, py]);

  const { onMove, cardKey } = props;
  const lift = () => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  const drop = (atX: number, atY: number) => {
    const at = kinCanvasSnap(atX, atY);
    px.set(at.x);
    py.set(at.y);
    onMove(cardKey, at.x, at.y);
  };
  const drag = usePanGesture({
    enabled: props.draggable,
    activateAfterLongPress: 350,
    onActivate: () => {
      fromX.set(px.get());
      fromY.set(py.get());
      lifted.set(1);
      runOnJS(lift)();
    },
    onUpdate: (event) => {
      px.set(fromX.get() + event.translationX / scale.get());
      py.set(fromY.get() + event.translationY / scale.get());
    },
    onDeactivate: (event) => {
      lifted.set(0);
      if (event.canceled) {
        px.set(fromX.get());
        py.set(fromY.get());
      } else runOnJS(drop)(px.get(), py.get());
    },
  });
  const placed = useAnimatedStyle(() => ({
    zIndex: lifted.get() === 1 ? 10 : 0,
    transform: [
      { translateX: px.get() + KIN_CANVAS_WORLD_HALF },
      { translateY: py.get() + KIN_CANVAS_WORLD_HALF },
      { scale: lifted.get() === 1 ? 1.03 : 1 },
    ],
  }));

  const late = card?.tone === "late" || widget?.tone === "late";
  const label = card?.accessibilityLabel ?? widget?.accessibilityLabel ?? "";
  return (
    <GestureDetector gesture={drag}>
      <Animated.View
        style={[
          {
            position: "absolute",
            left: 0,
            top: 0,
            width: KIN_CANVAS_CARD_W,
            height: KIN_CANVAS_CARD_H,
          },
          placed,
        ]}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={{ selected: props.selected }}
          accessibilityHint={props.draggable ? "Touch and hold to move it" : undefined}
          onPress={() => props.onPress(cardKey)}
          className={cn(
            "size-full overflow-hidden rounded-xl border p-3 active:opacity-80",
            widget !== undefined ? "bg-screen" : card?.tone === "done" ? "bg-card-alt" : "bg-card",
            props.selected || props.peeked
              ? "border-2 border-primary"
              : props.highlighted
                ? "border-2 border-warning"
                : late
                  ? "border-danger-border"
                  : "border-border",
          )}
        >
          {card !== undefined ? (
            <TaskOrDoc card={card} detail={props.detail} inv={props.inv} />
          ) : widget !== undefined ? (
            <Widget widget={widget} detail={props.detail} inv={props.inv} />
          ) : null}
        </Pressable>
      </Animated.View>
    </GestureDetector>
  );
});

function dotTone(card: KinCanvasCardView) {
  if (card.tone === "late") return "bg-danger/40";
  if (card.tone === "done") return "bg-subtle-strong";
  if (card.tone === "doc") return "bg-primary/20";
  if (card.working !== null) return "bg-primary/45";
  return "bg-foreground/15";
}

function TaskOrDoc(props: {
  readonly card: KinCanvasCardView;
  readonly detail: KinCanvasDetail;
  readonly inv: number;
}) {
  const { card, detail } = props;
  if (detail === "dots") return <View className={cn("flex-1 rounded-lg", dotTone(card))} />;
  const state = STATE_OF_TONE[card.tone];
  if (detail === "titles") {
    return (
      <Text
        numberOfLines={3}
        className={cn("font-t3-medium", card.tone === "done" && "text-foreground-muted")}
        style={{ fontSize: 14 * props.inv, lineHeight: 18 * props.inv }}
      >
        {card.title}
      </Text>
    );
  }
  return (
    <View className="flex-1">
      <View className="flex-row items-center gap-1.5">
        {state === null ? (
          <SymbolView name="doc.text" size={14} tintColorClassName="accent-icon-muted" />
        ) : (
          <KinWorkStateSymbol state={state} />
        )}
        <Text
          textRole="caption"
          className="text-foreground-muted"
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {card.key}
        </Text>
        <Text
          textRole="caption"
          numberOfLines={1}
          className={cn(
            "shrink",
            card.tone === "late" ? "text-danger-foreground" : "text-foreground-muted",
          )}
        >
          · {card.tone === "late" ? "Late" : card.status}
        </Text>
        <View className="ml-auto flex-row items-center gap-1">
          {card.needsYou ? (
            <View className="rounded-full bg-warning/15 px-1.5 py-0.5">
              <Text textRole="micro" className="font-t3-medium text-warning-foreground">
                {KIN_CANVAS.needsYou}
              </Text>
            </View>
          ) : null}
          {card.changed !== null ? <View className="size-2 rounded-full bg-primary" /> : null}
        </View>
      </View>
      <Text
        textRole="footnote"
        numberOfLines={2}
        className={cn("mt-1.5 font-t3-medium", card.tone === "done" && "text-foreground-muted")}
      >
        {card.title}
      </Text>
      <Text textRole="caption" numberOfLines={1} className="mt-1 text-foreground-muted">
        {card.line}
      </Text>
      <Text
        textRole="caption"
        numberOfLines={1}
        className={cn(
          "mt-auto",
          card.working !== null ? "font-t3-medium text-foreground" : "text-foreground-muted",
        )}
      >
        {card.working ?? card.changed ?? ""}
      </Text>
    </View>
  );
}

function Widget(props: {
  readonly widget: KinCanvasWidgetView;
  readonly detail: KinCanvasDetail;
  readonly inv: number;
}) {
  const { widget, detail } = props;
  if (detail === "dots") return <View className="flex-1 rounded-lg bg-primary/25" />;
  const fraction = widget.fraction;
  return (
    <View className="flex-1">
      <View className="flex-row items-center gap-1.5">
        <SymbolView
          name={WIDGET_ICON[widget.widget.kind]}
          size={14}
          tintColorClassName="accent-icon-muted"
        />
        <Text textRole="caption" numberOfLines={1} className="shrink text-foreground-muted">
          {widget.title}
        </Text>
      </View>
      <Text
        numberOfLines={1}
        className={cn(
          "mt-2 font-t3-bold",
          widget.tone === "late" && "text-danger-foreground",
          widget.tone === "gone" && "text-foreground-muted",
        )}
        style={
          widget.tone === "gone"
            ? { fontSize: 16 }
            : {
                fontSize: 24 * props.inv,
                lineHeight: 30 * props.inv,
                fontVariant: ["tabular-nums"],
              }
        }
      >
        {widget.headline}
      </Text>
      {detail === "cards" ? (
        <Text textRole="caption" numberOfLines={1} className="mt-0.5 text-foreground-muted">
          {widget.detail}
        </Text>
      ) : null}
      {fraction !== null ? (
        <View
          accessibilityRole="progressbar"
          accessibilityValue={{ min: 0, max: 100, now: Math.round(fraction * 100) }}
          className="mt-auto h-1.5 overflow-hidden rounded-full bg-subtle-strong"
        >
          <View
            className="h-full rounded-full bg-primary"
            style={{ width: `${Math.round(fraction * 100)}%` }}
          />
        </View>
      ) : null}
    </View>
  );
}
