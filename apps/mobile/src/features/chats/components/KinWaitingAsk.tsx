import { useAtomValue } from "@effect/atom-react";
import {
  KIN_CARD_REREAD_COPY,
  KIN_CHOICE_DISMISS_COPY,
  kinChoiceFailureNotice,
} from "@t3tools/client-runtime/kin/kinChoicePresentation";
import { createKinCardActions } from "@t3tools/client-runtime/kin/kinDeferralPresentation";
import {
  kinWaitingAskInput,
  type KinWaitingAskView,
} from "@t3tools/client-runtime/kin/kinWaitingAsk";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  KIN_CHOICE_DISMISS_ACTION,
  type EnvironmentId,
  type KinWaitingItem,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { uuidv4 } from "../../../lib/uuid";
import { useAtomCommand } from "../../../state/use-atom-command";
import { kinClient } from "../state/kinClient";

/**
 * An agent's open question in Waiting on you: what it will do and when, its answers to tap here,
 * and Dismiss. A tap answers it as the card's own would; the row leaves once the host settles it.
 * A tap the host refuses as settled or changed hides the answers and reads the list again.
 */
export function KinWaitingAsk(props: {
  readonly ask: KinWaitingAskView;
  /** The row as the host last sent it; a new one is a fresh read. */
  readonly item: KinWaitingItem;
  readonly environmentId: EnvironmentId;
  /** Reads Waiting on you again from the host. */
  readonly onReread: () => void;
}) {
  const { ask, environmentId } = props;
  const canAct = useAtomValue(kinClient.widgetAction.permissionAtom(environmentId));
  const post = useAtomCommand(kinClient.widgetAction, { reportFailure: false });
  const actions = useRef<ReturnType<
    typeof createKinCardActions<KinWaitingAskView["target"], string>
  > | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // Held for the row the refused tap saw: the host's next read of it clears this.
  const [behind, setBehind] = useState<KinWaitingItem | null>(null);
  const rereading = behind === props.item;
  const press = async (optionId: string) => {
    if (actions.current === null)
      actions.current = createKinCardActions<KinWaitingAskView["target"], string>({
        newId: uuidv4,
        toInput: kinWaitingAskInput,
        failureNotice: kinChoiceFailureNotice,
        post: async (input) => {
          const result = await post({ environmentId, input });
          return AsyncResult.isFailure(result)
            ? { ok: false, cause: squashAtomCommandFailure(result) }
            : { ok: true };
        },
      });
    const outcome = await actions.current(ask.target, optionId, () => {
      setPending(optionId);
      setProblem(null);
    });
    if (outcome.status === "ignored") return;
    if (outcome.status === "failed") {
      setPending(null);
      if (outcome.behind === true) {
        setBehind(props.item);
        props.onReread();
      } else setProblem(outcome.notice.text);
    }
  };
  return (
    <View className="gap-2 px-4 pb-3">
      <Text textRole="footnote" className="text-foreground-muted">
        {ask.line}
      </Text>
      {rereading ? (
        <Text
          accessibilityRole="alert"
          textRole="footnote"
          className="font-t3-medium text-warning-foreground"
        >
          {KIN_CARD_REREAD_COPY.checking}
        </Text>
      ) : canAct ? (
        <View className="flex-row flex-wrap gap-2" accessibilityLabel="Answer">
          {ask.options.map((option) => (
            <Button
              key={option.optionId}
              label={option.label}
              accessibilityHint={
                option.isDefault
                  ? "The default; sends this as your answer"
                  : "Sends this as your answer"
              }
              tone="outline"
              size="compact"
              loading={pending === option.optionId}
              disabled={pending !== null}
              onPress={() => void press(option.optionId)}
            />
          ))}
          <Button
            label={KIN_CHOICE_DISMISS_COPY.dismiss}
            accessibilityLabel={KIN_CHOICE_DISMISS_COPY.dismissName}
            tone="text"
            size="compact"
            loading={pending === KIN_CHOICE_DISMISS_ACTION}
            disabled={pending !== null}
            onPress={() => void press(KIN_CHOICE_DISMISS_ACTION)}
          />
        </View>
      ) : null}
      {problem === null || rereading ? null : (
        <Text accessibilityRole="alert" textRole="footnote" className="text-danger-foreground">
          {problem}
        </Text>
      )}
    </View>
  );
}
