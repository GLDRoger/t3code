import { KIN_CHAT_COPY } from "@t3tools/client-runtime/kin/kinChatFeed";
import { useEffect, useState, type ReactNode } from "react";
import { AccessibilityInfo, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";

import { ComposerActionButton, ComposerToolbarButton } from "../../../components/ComposerToolbar";
import { AppText as Text } from "../../../components/ui/AppText";
import { useReduceMotionEnabled } from "../../../lib/appState";
import { KinAvatar } from "./KinAvatar";
import { kinAgentAvatar } from "@t3tools/client-runtime/kin/kinScreenState";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { useVisibleSecondClock } from "../../threads/use-visible-second-clock";
import type { KinPresence } from "@t3tools/contracts";

import {
  KIN_PRESENCE_TICK_MS,
  kinPresenceNeedsClock,
  kinPresenceTimerStart,
  kinWorkingLines,
  type KinWorkingLine,
} from "@t3tools/client-runtime/kin/kinLive";

/**
 * Wall-clock ms, refreshed on 15 s boundaries while `active`, so every reader of one presence
 * changes text on the same tick. Static text in between: nothing repaints.
 */
export function useKinPresenceNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a timer for the presence line's elapsed text
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const wait = KIN_PRESENCE_TICK_MS - (Date.now() % KIN_PRESENCE_TICK_MS);
      timer = setTimeout(() => {
        setNow(Date.now());
        schedule();
      }, wait);
    };
    schedule();
    return () => clearTimeout(timer);
  }, [active]);
  return now;
}

export type KinStopState = "idle" | "stopping" | "failed";

/**
 * What each working agent is doing, one line each above the composer: pulsing dots while it is
 * queued or starting, else its avatar and a gently breathing line while it works. The row keeps
 * its height when empty, so a reply landing never shifts the feed.
 */
export function KinPresenceLines(props: {
  readonly presence: ReadonlyArray<KinPresence>;
  /** The row is on screen: the chat is focused and its end shows. Motion stops otherwise. */
  readonly visible: boolean;
  readonly mayStop: (agentId: string) => boolean;
  readonly agentNames: ReadonlyMap<string, string>;
  readonly stops: ReadonlyMap<string, KinStopState>;
  /** Null when nothing here can be stopped. */
  readonly onStop: ((wakeupId: string) => void) | null;
}) {
  const now = useKinPresenceNow(props.presence.some(kinPresenceNeedsClock));
  const rows = kinWorkingLines(props.presence, now, props.onStop === null ? noStop : props.mayStop);
  if (rows.length === 0) return <View className="h-8" />;
  return rows.map((row) => (
    <KinPresenceLine
      key={row.presence.agentId}
      row={row}
      name={props.agentNames.get(row.presence.agentId) ?? "the agent"}
      visible={props.visible}
      stop={
        row.presence.wakeupId === null ? "idle" : (props.stops.get(row.presence.wakeupId) ?? "idle")
      }
      onStop={props.onStop}
    />
  ));
}

const noStop = () => false;

function KinPresenceLine(props: {
  readonly row: KinWorkingLine;
  readonly name: string;
  readonly visible: boolean;
  readonly onStop: ((wakeupId: string) => void) | null;
  readonly stop: KinStopState;
}) {
  const { presence, line } = props.row;
  const announcement = line.announcement;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- announces a change of state to screen readers, not every tick
  useEffect(() => {
    AccessibilityInfo.announceForAccessibility(announcement);
  }, [announcement]);
  const reduceMotion = useReduceMotionEnabled();
  // Motion only while a run is live and on screen; Reduce Motion leaves the row still.
  const animate = props.visible && !reduceMotion;

  const { onStop, stop } = props;
  const wakeupId = presence.wakeupId;
  const stoppable = props.row.stop !== "none" && onStop !== null && wakeupId !== null;
  const press = () => {
    if (wakeupId !== null) onStop?.(wakeupId);
  };
  const stopLabel = stop === "failed" ? KIN_CHAT_COPY.stopAgain : `Stop ${props.name}`;
  const timerStart = kinPresenceTimerStart(presence);
  return (
    <View className="h-8 flex-row items-center gap-2 px-5">
      {line.motion === "dots" ? (
        <KinPulsingDots animate={animate} />
      ) : (
        <KinAvatar avatar={kinAgentAvatar(presence.agentId)} size="small" />
      )}
      <KinBreathing animate={animate && line.motion === "shimmer"}>
        <Text textRole="footnote" className="text-foreground-muted" numberOfLines={1}>
          {line.text}
        </Text>
      </KinBreathing>
      {timerStart === null ? null : <KinWorkingTimer startedAt={timerStart} />}
      {stoppable ? (
        <>
          {stop === "idle" ? null : (
            <Text
              textRole="caption"
              className={stop === "failed" ? "text-danger-foreground" : "text-foreground-muted"}
            >
              {stop === "failed" ? "Couldn't stop" : "Stopping…"}
            </Text>
          )}
          {/* The 44 pt target overhangs the 32 pt row, so the row keeps its height. */}
          <View className="-my-1.5">
            {props.row.stop === "urgent" ? (
              <ComposerActionButton
                accessibilityLabel={stopLabel}
                icon="stop.fill"
                variant="danger"
                disabled={stop === "stopping"}
                onPress={press}
              />
            ) : (
              <ComposerToolbarButton
                label="Stop"
                accessibilityLabel={stopLabel}
                icon="stop.fill"
                disabled={stop === "stopping"}
                onPress={press}
              />
            )}
          </View>
        </>
      ) : null}
    </View>
  );
}

const PULSE_MS = 700;
const PULSE_EASING = Easing.inOut(Easing.quad);

/**
 * An opacity loop on the UI thread: no React render per frame, and only opacity, so the
 * compositor does the work. Cancelled the moment `animate` turns off; at rest it holds `rest`.
 */
function usePulse(animate: boolean, delayMs: number, low: number, rest: number) {
  const opacity = useSharedValue(rest);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts and cancels a Reanimated loop as the row comes and goes; Reanimated lives outside React
  useEffect(() => {
    if (!animate) {
      cancelAnimation(opacity);
      opacity.set(rest);
      return;
    }
    opacity.set(
      withDelay(
        delayMs,
        withRepeat(
          withSequence(
            withTiming(low, { duration: PULSE_MS, easing: PULSE_EASING }),
            withTiming(1, { duration: PULSE_MS, easing: PULSE_EASING }),
          ),
          -1,
        ),
      ),
    );
    return () => cancelAnimation(opacity);
  }, [animate, delayMs, low, rest, opacity]);
  return useAnimatedStyle(() => ({ opacity: opacity.get() }));
}

function KinBreathing(props: { readonly animate: boolean; readonly children: ReactNode }) {
  const style = usePulse(props.animate, 0, 0.45, 1);
  return <Animated.View style={[{ flexShrink: 1 }, style]}>{props.children}</Animated.View>;
}

function KinPulsingDots(props: { readonly animate: boolean }) {
  return (
    <View
      className="w-7 flex-row items-center justify-center gap-1"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {[0, 1, 2].map((index) => (
        <KinDot key={index} animate={props.animate} delayMs={index * (PULSE_MS / 3)} />
      ))}
    </View>
  );
}

function KinDot(props: { readonly animate: boolean; readonly delayMs: number }) {
  const style = usePulse(props.animate, props.delayMs, 0.25, 0.6);
  return <Animated.View className="size-1.5 rounded-full bg-primary" style={style} />;
}

/** T3's working timer, in the presence line's Dynamic Type role. Ticks once a second, no animation. */
function KinWorkingTimer(props: { readonly startedAt: string }) {
  const nowMs = useVisibleSecondClock(true);
  return (
    <Text
      textRole="footnote"
      className="shrink-0 text-foreground-muted"
      style={{ fontVariant: ["tabular-nums"] }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {formatWorkingDuration(props.startedAt, nowMs)}
    </Text>
  );
}

function formatWorkingDuration(startedAt: string, nowMs: number): string {
  const startedAtMs = Date.parse(startedAt);
  if (!Number.isFinite(startedAtMs) || nowMs <= startedAtMs) {
    return "0s";
  }

  const totalSeconds = Math.floor((nowMs - startedAtMs) / 1_000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  if (totalSeconds >= 3_600) {
    return formatDuration(totalSeconds * 1_000);
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}m ${seconds}s`;
}
