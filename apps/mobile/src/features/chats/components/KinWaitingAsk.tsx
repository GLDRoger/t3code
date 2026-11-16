import { useAtomValue } from "@effect/atom-react";
import {
  kinChoiceActInput,
  kinChoiceFailureNotice,
} from "@t3tools/client-runtime/kin/kinChoicePresentation";
import { createKinCardActions } from "@t3tools/client-runtime/kin/kinDeferralPresentation";
import type { KinWaitingAskView } from "@t3tools/client-runtime/kin/kinWaitingAsk";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { uuidv4 } from "../../../lib/uuid";
import { useAtomCommand } from "../../../state/use-atom-command";
import { kinClient } from "../state/kinClient";

/**
 * An agent's open question in Waiting on you: what it will do and when, and its answers to tap
 * here. A tap answers it as the card's own would; the row leaves once the host settles it.
 */
export function KinWaitingAsk(props: {
  readonly ask: KinWaitingAskView;
  readonly environmentId: EnvironmentId;
}) {
  const { ask, environmentId } = props;
  const canAct = useAtomValue(kinClient.widgetAction.permissionAtom(environmentId));
  const post = useAtomCommand(kinClient.widgetAction, { reportFailure: false });
  const actions = useRef<ReturnType<
    typeof createKinCardActions<KinWaitingAskView["target"], string>
  > | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const press = async (optionId: string) => {
    actions.current ??= createKinCardActions<KinWaitingAskView["target"], string>({
      newId: uuidv4,
      toInput: kinChoiceActInput,
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
      setProblem(outcome.notice.text);
    }
  };
  return (
    <View className="gap-2 px-4 pb-3">
      <Text textRole="footnote" className="text-foreground-muted">
        {ask.line}
      </Text>
      {canAct ? (
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
        </View>
      ) : null}
      {problem === null ? null : (
        <Text accessibilityRole="alert" textRole="footnote" className="text-danger-foreground">
          {problem}
        </Text>
      )}
    </View>
  );
}
