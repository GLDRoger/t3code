import { useEffect, useState } from "react";
import { AccessibilityInfo, Pressable, View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import type { KinPresence } from "@t3tools/contracts";

import { KIN_PRESENCE_TICK_MS, kinPresenceLine, kinPresenceNeedsClock } from "../state/kinLive";

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
  return (
    <View className="h-8 flex-row items-center gap-2 px-5">
      {line === null ? null : (
        <Text textRole="caption" className="shrink text-foreground-muted" numberOfLines={1}>
          {line.text}
        </Text>
      )}
      {stoppable ? (
        props.stop === "stopping" ? (
          <Text textRole="caption" className="text-foreground-muted">
            · Stopping…
          </Text>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={props.stop === "failed" ? "Couldn't stop. Try again" : "Stop"}
            onPress={onStop ?? undefined}
            hitSlop={12}
            className="flex-row active:opacity-60"
          >
            <Text textRole="caption" className="text-foreground-muted">
              ·{" "}
            </Text>
            <Text
              textRole="caption"
              className={
                props.stop === "failed"
                  ? "font-t3-medium text-danger-foreground"
                  : "font-t3-medium text-foreground"
              }
            >
              {props.stop === "failed" ? "Couldn't stop · Retry" : "Stop"}
            </Text>
          </Pressable>
        )
      ) : null}
    </View>
  );
}
