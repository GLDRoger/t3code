import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { memo, useRef, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { cn } from "../../../lib/cn";
import { useNowMinuteMs } from "../../../lib/clock";
import { uuidv4 } from "../../../lib/uuid";
import { useAtomCommand } from "../../../state/use-atom-command";
import { CustomSnoozeSheet } from "../../threads/CustomSnoozeSheet";
import { kinClient } from "../state/kinClient";
import {
  KIN_SENT_CARD_TEXT,
  createKinCardActions,
  kinDeferralCountdown,
  type KinCardNotice,
  type KinDeferralActionId,
  type KinDeferralCardView,
  type KinDeferralTap,
} from "./kinDeferralPresentation";

/** A deferral: when Kin will act, and the owner's ways to change that. One action per tap. */
export const KinDeferralCard = memo(function KinDeferralCard(props: {
  readonly deferral: KinDeferralCardView;
  readonly environmentId: EnvironmentId;
}) {
  const { deferral, environmentId } = props;
  const canAct = useAtomValue(kinClient.widgetAction.permissionAtom(environmentId));
  const post = useAtomCommand(kinClient.widgetAction, { reportFailure: false });
  const actions = useRef<ReturnType<typeof createKinCardActions>>(null);
  const [pending, setPending] = useState<KinDeferralActionId | null>(null);
  const [notice, setNotice] = useState<KinCardNotice | null>(null);
  // A sent action holds the buttons until the host answers with a new revision.
  const [sentRevision, setSentRevision] = useState<number | null>(null);
  const [changing, setChanging] = useState(false);
  const sent = sentRevision === deferral.revision;

  const run = async (tap: KinDeferralTap) => {
    actions.current ??= createKinCardActions({
      newId: uuidv4,
      post: async (input) => {
        const result = await post({ environmentId, input });
        return AsyncResult.isFailure(result)
          ? { ok: false, cause: squashAtomCommandFailure(result) }
          : { ok: true };
      },
    });
    const outcome = await actions.current(deferral, tap, () => {
      setPending(tap.id);
      setNotice(null);
    });
    if (outcome.status === "ignored") return;
    setPending(null);
    if (outcome.status === "sent") setSentRevision(deferral.revision);
    else setNotice(outcome.notice);
  };

  const press = (id: KinDeferralActionId) => {
    if (pending !== null) return;
    if (id === "change") setChanging(true);
    else void run({ id });
  };

  return (
    <View className="gap-2.5 rounded-[20px] border border-border bg-card-alt p-4">
      <Text
        className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-foreground-secondary"
        importantForAccessibility="no"
        accessibilityElementsHidden
      >
        {deferral.eyebrow}
      </Text>
      <View accessible accessibilityLabel={deferral.accessibilityLabel} className="gap-1.5">
        <Text textRole="headline" className="font-t3-bold text-foreground">
          {deferral.title}
        </Text>
        {deferral.lines.map((line) => (
          <Text key={line} textRole="footnote" className="text-foreground-secondary">
            {line}
          </Text>
        ))}
      </View>
      {deferral.countdownTo === null || deferral.phase === "closed" ? null : (
        <KinCountdownLine phase={deferral.phase} targetMs={deferral.countdownTo} />
      )}
      {notice === null ? null : (
        <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          textRole="footnote"
          className={cn(
            "font-t3-medium",
            notice.kind === "stale" ? "text-warning-foreground" : "text-danger-foreground",
          )}
        >
          {notice.text}
        </Text>
      )}
      {sent ? (
        <Text
          textRole="footnote"
          accessibilityLiveRegion="polite"
          className="text-foreground-muted"
        >
          {KIN_SENT_CARD_TEXT}
        </Text>
      ) : null}
      {deferral.actions.length === 0 ? null : !canAct ? (
        <Text textRole="footnote" className="text-foreground-muted">
          This device can't answer Kin cards. Pair it again from the Mac.
        </Text>
      ) : (
        <View className="flex-row flex-wrap gap-2 pt-1">
          {deferral.actions.map((action) => (
            <Button
              key={action.id}
              label={action.label}
              accessibilityLabel={action.accessibilityLabel}
              tone={action.tone}
              loading={pending === action.id}
              disabled={sent || (pending !== null && pending !== action.id)}
              onPress={() => press(action.id)}
            />
          ))}
        </View>
      )}
      {changing ? (
        <CustomSnoozeSheet
          title="Change time"
          description="Choose when this should happen instead."
          confirmLabel="Change"
          onClose={() => setChanging(false)}
          onSnooze={(dueAt) => void run({ id: "change", dueAt })}
        />
      ) : null}
    </View>
  );
});

/** Subscribes to the shared minute tick only while a countdown shows; never repaints faster. */
function KinCountdownLine(props: {
  readonly phase: "confirmed" | "heads_up";
  readonly targetMs: number;
}) {
  const nowMs = useNowMinuteMs();
  return (
    <Text
      textRole="footnote"
      className={cn(
        "font-t3-medium",
        props.phase === "heads_up" ? "text-foreground" : "text-foreground-muted",
      )}
    >
      {kinDeferralCountdown(props.phase, props.targetMs, nowMs)}
    </Text>
  );
}
