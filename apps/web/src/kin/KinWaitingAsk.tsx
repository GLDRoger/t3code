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

import { Button } from "../components/ui/button";
import { randomUUID } from "../lib/utils";
import { useAtomCommand } from "../state/use-atom-command";
import { kinClient } from "./kinClient";

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
      newId: randomUUID,
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
    <div className="flex flex-col gap-1.5 px-2 pb-2">
      <p className="text-xs text-muted-foreground">{ask.line}</p>
      {canAct ? (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Answer">
          {ask.options.map((option) => (
            <Button
              key={option.optionId}
              size="compact"
              variant="outline"
              disabled={pending !== null}
              aria-label={option.isDefault ? `${option.label}, the default` : option.label}
              onClick={() => void press(option.optionId)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      ) : null}
      {problem === null ? null : (
        <p role="alert" className="text-xs font-medium text-destructive-foreground">
          {problem}
        </p>
      )}
    </div>
  );
}
