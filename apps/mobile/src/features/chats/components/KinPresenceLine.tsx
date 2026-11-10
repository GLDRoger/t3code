import { useEffect, useState } from "react";
import { AccessibilityInfo, View } from "react-native";

import { ComposerActionButton } from "../../../components/ComposerToolbar";
import { AppText as Text } from "../../../components/ui/AppText";
import { formatWorkingDuration } from "../../threads/floating-working-control";
import { useVisibleSecondClock } from "../../threads/use-visible-second-clock";
import type { KinPresence } from "@t3tools/contracts";

import {
  KIN_PRESENCE_TICK_MS,
  kinPresenceLine,
  kinPresenceNeedsClock,
  kinPresenceTimerStart,
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
 * What the lead is doing, in one line under the feed. Its row keeps its height when empty, so a
 * reply landing never shifts the feed.
 */
export function KinPresenceLine(props: {
  readonly presence: KinPresence | undefined;
  /** Null when the viewer can't stop this lead. */
  readonly onStop: (() => void) | null;
  readonly stop: KinStopState;
}) {
  const now = useKinPresenceNow(kinPresenceNeedsClock(props.presence));
  const line = kinPresenceLine(props.presence, now);
  const announcement = line?.announcement ?? null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- announces a change of state to screen readers, not every tick
  useEffect(() => {
    if (announcement !== null) AccessibilityInfo.announceForAccessibility(announcement);
  }, [announcement]);

  const { onStop } = props;
  const stoppable = line?.stalled === true && onStop !== null;
  const timerStart = kinPresenceTimerStart(props.presence);
  return (
    <View className="h-8 flex-row items-center gap-2 px-5">
      {line === null ? null : (
        <Text textRole="caption" className="shrink text-foreground-muted" numberOfLines={1}>
          {line.text}
        </Text>
      )}
      {timerStart === null ? null : <KinWorkingTimer startedAt={timerStart} />}
      {stoppable ? (
        <>
          {props.stop === "idle" ? null : (
            <Text
              textRole="caption"
              className={
                props.stop === "failed" ? "text-danger-foreground" : "text-foreground-muted"
              }
            >
              {props.stop === "failed" ? "Couldn't stop" : "Stopping…"}
            </Text>
          )}
          {/* The 44 pt target overhangs the 32 pt row, so the row keeps its height. */}
          <View className="-my-1.5">
            <ComposerActionButton
              accessibilityLabel={props.stop === "failed" ? "Try stopping again" : "Stop"}
              icon="stop.fill"
              variant="danger"
              disabled={props.stop === "stopping"}
              onPress={onStop}
            />
          </View>
        </>
      ) : null}
    </View>
  );
}

/** T3's working timer, in the presence line's Dynamic Type role. Ticks once a second, no animation. */
function KinWorkingTimer(props: { readonly startedAt: string }) {
  const nowMs = useVisibleSecondClock(true);
  return (
    <Text
      textRole="caption"
      className="shrink-0 text-foreground-muted"
      style={{ fontVariant: ["tabular-nums"] }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {formatWorkingDuration(props.startedAt, nowMs)}
    </Text>
  );
}
