import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, KinPersonId } from "@t3tools/contracts";
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
import { KIN_REACTION_HINT, KIN_REACTION_HINT_LABEL } from "../state/kinReactions";
import {
  KIN_CHOICE_EXPIRED_TEXT,
  kinChoiceAccessibilityLabel,
  kinChoiceActInput,
  kinChoiceAnswerText,
  kinChoicePhase,
  type KinChoiceCardView,
} from "./kinChoicePresentation";
import {
  createKinCardActions,
  visibleKinCardStatus,
  type KinCardStatus,
} from "./kinDeferralPresentation";

/** A lead's question with 2-4 answers. The owner's tap is their reply; it never approves anything. */
export const KinChoiceCard = memo(function KinChoiceCard(props: {
  readonly choice: KinChoiceCardView;
  readonly environmentId: EnvironmentId;
  readonly viewerPersonId: KinPersonId | null;
}) {
  const { choice, environmentId } = props;
  // The shared minute tick: enough to retire an expired card, never a repaint loop.
  const nowMs = useNowMinuteMs();
  const canAct = useAtomValue(kinClient.widgetAction.permissionAtom(environmentId));
  const post = useAtomCommand(kinClient.widgetAction, { reportFailure: false });
  const actions = useRef<ReturnType<typeof createKinCardActions<KinChoiceCardView, string>>>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [lastStatus, setLastStatus] = useState<
    (KinCardStatus & { readonly optionId: string }) | null
  >(null);
  const status = visibleKinCardStatus(lastStatus, choice.revision);
  const phase = kinChoicePhase(choice, nowMs);
  // Until the answered card arrives, the tapped option already reads as chosen.
  const sentOption =
    status?.holding === true
      ? choice.options.find((option) => option.id === lastStatus?.optionId)
      : undefined;

  const press = async (optionId: string) => {
    if (pending !== null) return;
    if (actions.current === null)
      actions.current = createKinCardActions<KinChoiceCardView, string>({
        newId: uuidv4,
        toInput: kinChoiceActInput,
        post: async (input) => {
          const result = await post({ environmentId, input });
          return AsyncResult.isFailure(result)
            ? { ok: false, cause: squashAtomCommandFailure(result) }
            : { ok: true };
        },
      });
    const revision = choice.revision;
    const outcome = await actions.current(choice, optionId, () => {
      setPending(optionId);
      setLastStatus(null);
    });
    if (outcome.status === "ignored") return;
    setPending(null);
    setLastStatus(
      outcome.status === "failed"
        ? { revision, optionId, notice: outcome.notice, holding: false }
        : { revision, optionId, notice: null, holding: true },
    );
  };

  const answerText =
    choice.answer !== null
      ? kinChoiceAnswerText(choice.answer, props.viewerPersonId)
      : sentOption !== undefined
        ? `You chose “${sentOption.label}”`
        : null;

  return (
    <View className="gap-2.5 rounded-[20px] border border-border bg-card-alt p-4">
      <View
        accessible
        accessibilityLabel={kinChoiceAccessibilityLabel(choice, answerText)}
        className="gap-1.5"
      >
        <Text textRole="headline" className="font-t3-bold text-foreground">
          {choice.question}
        </Text>
        {choice.detail === null ? null : (
          <Text textRole="footnote" className="text-foreground-secondary">
            {choice.detail}
          </Text>
        )}
      </View>
      {answerText !== null ? (
        <Text
          textRole="footnote"
          className="font-t3-medium text-foreground-secondary"
          importantForAccessibility="no"
          accessibilityElementsHidden
        >
          {answerText}
        </Text>
      ) : phase === "expired" ? (
        <Text textRole="footnote" className="text-foreground-muted">
          {KIN_CHOICE_EXPIRED_TEXT}
        </Text>
      ) : !canAct ? (
        <Text textRole="footnote" className="text-foreground-muted">
          This device can't answer Kin cards. Pair it again from the Mac.
        </Text>
      ) : (
        <>
          {status?.notice == null ? null : (
            <Text
              accessibilityRole="alert"
              accessibilityLiveRegion="polite"
              textRole="footnote"
              className={cn(
                "font-t3-medium",
                status.notice.kind === "stale"
                  ? "text-warning-foreground"
                  : "text-danger-foreground",
              )}
            >
              {status.notice.text}
            </Text>
          )}
          <View className="gap-2 pt-1">
            {choice.options.map((option) => (
              <Button
                key={option.id}
                label={option.label}
                accessibilityHint="Sends this as your reply"
                tone="secondary"
                size="compact"
                fullWidth
                loading={pending === option.id}
                disabled={pending !== null && pending !== option.id}
                onPress={() => void press(option.id)}
              />
            ))}
          </View>
          {choice.takesReaction ? (
            <Text
              textRole="caption"
              className="text-foreground-muted"
              accessibilityLabel={KIN_REACTION_HINT_LABEL}
            >
              {KIN_REACTION_HINT}
            </Text>
          ) : null}
        </>
      )}
    </View>
  );
});
