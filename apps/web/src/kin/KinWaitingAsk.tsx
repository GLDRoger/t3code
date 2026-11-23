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

import { Button } from "../components/ui/button";
import { randomUUID } from "../lib/utils";
import { useAtomCommand } from "../state/use-atom-command";
import { kinClient } from "./kinClient";

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
        newId: randomUUID,
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
    <div className="flex flex-col gap-1.5 px-2 pb-2">
      <p className="text-xs text-muted-foreground">{ask.line}</p>
      {rereading ? (
        <p role="alert" className="text-xs font-medium text-warning-foreground">
          {KIN_CARD_REREAD_COPY.checking}
        </p>
      ) : canAct ? (
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
          <Button
            size="compact"
            variant="ghost"
            disabled={pending !== null}
            aria-label={KIN_CHOICE_DISMISS_COPY.dismissName}
            onClick={() => void press(KIN_CHOICE_DISMISS_ACTION)}
          >
            {KIN_CHOICE_DISMISS_COPY.dismiss}
          </Button>
        </div>
      ) : null}
      {problem === null || rereading ? null : (
        <p role="alert" className="text-xs font-medium text-destructive-foreground">
          {problem}
        </p>
      )}
    </div>
  );
}
