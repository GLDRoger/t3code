import { useAtomValue } from "@effect/atom-react";
import { KIN_DEVICE_COPY } from "@t3tools/client-runtime/kin/kinDevice";
import {
  visibleKinCardStatus,
  type KinCardNotice,
  type KinCardStatus,
} from "@t3tools/client-runtime/kin/kinDeferralPresentation";
import {
  createKinMailRuleCardActions,
  kinMailRuleCardView,
  kinMailRuleListsAfterTurnOn,
  type KinMailRuleCardAction,
} from "@t3tools/client-runtime/kin/kinMailRules";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, KinWidget } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { memo, useRef, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { cn } from "../../../lib/cn";
import { useNowMinuteMs } from "../../../lib/clock";
import { uuidv4 } from "../../../lib/uuid";
import { appAtomRegistry } from "../../../state/atom-registry";
import { useAtomCommand } from "../../../state/use-atom-command";
import { kinPhoneBreakable } from "../connections/kinMailRuleText";
import { kinClient } from "../state/kinClient";

const NOTICE_CLASSES: Record<KinCardNotice["kind"], string> = {
  sent: "text-foreground-muted",
  stale: "text-warning-foreground",
  error: "text-danger-foreground",
};

/** A lead's proposed mail rule: exactly what Turn on would store, and the tap that stores it. */
export const KinMailRuleCard = memo(function KinMailRuleCard(props: {
  readonly widget: KinWidget;
  readonly environmentId: EnvironmentId;
  readonly ownerLevel: boolean | undefined;
  readonly readOnly: boolean;
}) {
  const { environmentId } = props;
  const nowMs = useNowMinuteMs();
  const canAct = useAtomValue(kinClient.widgetAction.permissionAtom(environmentId));
  const post = useAtomCommand(kinClient.widgetAction, { reportFailure: false });
  const actions = useRef<ReturnType<typeof createKinMailRuleCardActions>>(null);
  const [pending, setPending] = useState<KinMailRuleCardAction | null>(null);
  const [lastStatus, setLastStatus] = useState<KinCardStatus | null>(null);
  const card = kinMailRuleCardView(props.widget, {
    nowMs,
    ownerLevel: props.ownerLevel,
    readOnly: props.readOnly,
  });
  if (card === null) return null;
  const status = visibleKinCardStatus(lastStatus, card.revision);

  const press = async (actionId: KinMailRuleCardAction) => {
    if (pending !== null) return;
    if (actions.current === null)
      actions.current = createKinMailRuleCardActions({
        newId: uuidv4,
        post: async (input) => {
          const result = await post({ environmentId, input });
          return AsyncResult.isFailure(result)
            ? { ok: false, cause: squashAtomCommandFailure(result) }
            : { ok: true };
        },
        onTurnedOn: () => {
          for (const input of kinMailRuleListsAfterTurnOn(card))
            appAtomRegistry.refresh(kinClient.mailRules({ environmentId, input }));
        },
      });
    const next = await actions.current(card, actionId, () => {
      setPending(actionId);
      setLastStatus(null);
    });
    if (next === null) return;
    setPending(null);
    setLastStatus(next);
  };

  return (
    <View className="gap-2 rounded-[20px] border border-border bg-card-alt p-4">
      <Text
        textRole="caption"
        className="font-t3-medium text-foreground-muted"
        importantForAccessibility="no"
        accessibilityElementsHidden
      >
        {card.eyebrow}
      </Text>
      <View accessible accessibilityLabel={card.accessibilityLabel} className="gap-1.5">
        <Text textRole="body" className="font-t3-medium text-foreground">
          {kinPhoneBreakable(card.title)}
        </Text>
        {card.facts.map((fact) => (
          <Text key={fact.label} textRole="footnote" className="text-foreground-secondary">
            {`${fact.label}: ${fact.value}`}
          </Text>
        ))}
        <Text textRole="footnote" className="text-foreground-muted">
          {card.whatLabel}
        </Text>
        <Text textRole="body" className="text-foreground">
          {card.what}
        </Text>
        <Text textRole="footnote" className="text-foreground-muted">
          {card.status}
        </Text>
      </View>
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
      {card.actions.length === 0 ? null : !canAct ? (
        <Text textRole="footnote" className="text-foreground-muted">
          {KIN_DEVICE_COPY.cantAct("phone", "answer")}
        </Text>
      ) : (
        <View className="flex-row flex-wrap gap-2 pt-1">
          {card.actions.map((action, index) => (
            <Button
              key={action.id}
              label={action.label}
              tone={index === 0 ? "primary" : "outline"}
              size="compact"
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
