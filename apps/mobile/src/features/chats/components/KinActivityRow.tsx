import type { KinChatActivity } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { View } from "react-native";

import { AppActivityIndicator } from "../../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../../components/ui/AppText";
import { useReduceMotionEnabled } from "../../../lib/appState";
import { kinActivityCopy, kinActivityWorking, kinStillWorkingIn } from "../state/kinChatFeed";

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const formatTime = (epochMs: number) => timeFormat.format(new Date(epochMs));

/** The row's spoken text, also announced by the feed. */
export const kinActivityLabel = (
  activity: KinChatActivity,
  agentName: string,
  stillWorking = false,
) => `${agentName}: ${kinActivityCopy({ activity, agentName, stillWorking, formatTime })}`;

/** The lead's status at the feed's end, in its bubble position. The feed announces it. */
export function KinActivityRow(props: {
  readonly activity: KinChatActivity;
  readonly agentName: string;
}) {
  const { activity } = props;
  const reduceMotion = useReduceMotionEnabled();
  const phaseKey = `${activity.agentId}:${activity.phase}:${activity.since}`;
  const [stillKey, setStillKey] = useState<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- one timer per phase marks it long-running; no interval or animation
  useEffect(() => {
    const wait = kinStillWorkingIn(activity, Date.now());
    if (wait === null) return;
    const timer = setTimeout(() => setStillKey(phaseKey), wait);
    return () => clearTimeout(timer);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- the key names the phase the timer belongs to
  }, [phaseKey]);
  const copy = kinActivityCopy({
    activity,
    agentName: props.agentName,
    stillWorking: stillKey === phaseKey,
    formatTime,
  });
  const busy = activity.phase === "queued" || kinActivityWorking(activity);

  return (
    <View
      accessible
      accessibilityLabel={kinActivityLabel(activity, props.agentName, stillKey === phaseKey)}
      className="items-start gap-1 px-4 pb-1.5"
    >
      <Text textRole="caption" className="px-1 pt-2 font-t3-medium text-foreground-muted">
        {props.agentName}
      </Text>
      <View className="max-w-[85%] flex-row items-center gap-2 px-1">
        {busy && !reduceMotion ? <AppActivityIndicator size="small" /> : null}
        <Text textRole="body" className="shrink text-foreground-muted">
          {copy}
        </Text>
      </View>
    </View>
  );
}
