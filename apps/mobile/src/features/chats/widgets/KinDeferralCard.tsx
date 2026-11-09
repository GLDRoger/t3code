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
import { kinClient } from "../state/kinClient";
import {
  createKinCardActions,
  kinActionFailureNotice,
  kinDeferralActInput,
  kinCardStatusAfter,
  kinDeferralCountdown,
  visibleKinCardStatus,
  type KinCardNotice,
  type KinCardStatus,
  type KinCountdownKind,
  type KinDeferralActionId,
  type KinDeferralCardView,
} from "./kinDeferralPresentation";

const NOTICE_CLASSES: Record<KinCardNotice["kind"], string> = {
  sent: "text-foreground-muted",
  stale: "text-warning-foreground",
  error: "text-danger-foreground",
};

/** A deferral at any phase: when Kin will act, and the owner's ways to change that. */
export const KinDeferralCard = memo(function KinDeferralCard(props: {
  readonly deferral: KinDeferralCardView;
  readonly environmentId: EnvironmentId;
}) {
  const { deferral, environmentId } = props;
  const canAct = useAtomValue(kinClient.widgetAction.permissionAtom(environmentId));
  const post = useAtomCommand(kinClient.widgetAction, { reportFailure: false });
  const actions =
    useRef<ReturnType<typeof createKinCardActions<KinDeferralCardView, KinDeferralActionId>>>(null);
  const [pending, setPending] = useState<KinDeferralActionId | null>(null);
  const [lastStatus, setLastStatus] = useState<KinCardStatus | null>(null);
  const status = visibleKinCardStatus(lastStatus, deferral.revision);

  const press = async (actionId: KinDeferralActionId) => {
    if (pending !== null) return;
    if (actions.current === null)
      actions.current = createKinCardActions({
        toInput: kinDeferralActInput,
        failureNotice: kinActionFailureNotice,
        newId: uuidv4,
        post: async (input) => {
          const result = await post({ environmentId, input });
          return AsyncResult.isFailure(result)
            ? { ok: false, cause: squashAtomCommandFailure(result) }
            : { ok: true };
        },
      });
    const revision = deferral.revision;
    const outcome = await actions.current(deferral, actionId, () => {
      setPending(actionId);
      setLastStatus(null);
    });
    if (outcome.status === "ignored") return;
    setPending(null);
    setLastStatus(kinCardStatusAfter(outcome, actionId, revision));
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
      {deferral.countdown === null ? null : (
        <KinCountdownLine targetMs={deferral.countdown.to} kind={deferral.countdown.kind} />
      )}
      {status?.notice == null ? null : (
        <Text
          accessibilityRole={status.notice.kind === "sent" ? undefined : "alert"}
          accessibilityLiveRegion="polite"
          textRole="footnote"
          className={cn("font-t3-medium", NOTICE_CLASSES[status.notice.kind])}
        >
          {status.notice.text}
        </Text>
      )}
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
              disabled={status?.holding === true || (pending !== null && pending !== action.id)}
              onPress={() => void press(action.id)}
            />
          ))}
        </View>
      )}
    </View>
  );
});

/** Subscribes to the shared minute tick only while a countdown shows; never repaints faster. */
function KinCountdownLine(props: { readonly targetMs: number; readonly kind: KinCountdownKind }) {
  const nowMs = useNowMinuteMs();
  return (
    <Text textRole="footnote" className="font-t3-medium text-foreground-muted">
      {kinDeferralCountdown(props.targetMs, nowMs, props.kind)}
    </Text>
  );
}
