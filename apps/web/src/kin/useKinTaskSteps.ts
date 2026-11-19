import { kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import {
  kinChoiceActInput,
  kinChoiceFailureNotice,
} from "@t3tools/client-runtime/kin/kinChoicePresentation";
import { createKinCardActions } from "@t3tools/client-runtime/kin/kinDeferralPresentation";
import { KIN_TASKS, type KinTaskStep } from "@t3tools/client-runtime/kin/kinTasksList";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { KinRecordKey, type KinWorkMoveCard } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { randomUUID } from "../lib/utils";
import { useAtomCommand } from "../state/use-atom-command";
import { kinClient } from "./kinClient";
import type { KinWorkTarget } from "./useKinWork";

/** What a row's step is doing: on its way, done in the host's words, or refused with its reason. */
export type KinTaskStepStatus =
  | { readonly kind: "busy"; readonly id: string }
  | { readonly kind: "done"; readonly text: string; readonly widgetId?: string }
  | { readonly kind: "failed"; readonly text: string; readonly widgetId?: string };

/**
 * A Tasks row's step, taken from the row as the phone takes it: a draft's Confirm and a question's
 * answer go through the chat card's own action (`kin.widgets.act`), a nudge through
 * `kin.work.nudge`. What each row's step is doing is kept by task until the list reads it again.
 */
export function useKinTaskSteps(target: KinWorkTarget) {
  const [status, setStatus] = useState<Readonly<Record<string, KinTaskStepStatus>>>({});
  const [nudged, setNudged] = useState<ReadonlySet<string>>(() => new Set());
  const post = useAtomCommand(kinClient.widgetAction, { reportFailure: false });
  const nudgeHolder = useAtomCommand(kinClient.workNudge, { reportFailure: false });
  const [act] = useState(() =>
    createKinCardActions<KinWorkMoveCard, string>({
      newId: randomUUID,
      toInput: kinChoiceActInput,
      failureNotice: kinChoiceFailureNotice,
      post: async (input) => {
        const result = await post({ environmentId: target.environmentId, input });
        return AsyncResult.isFailure(result)
          ? { ok: false, cause: squashAtomCommandFailure(result) }
          : { ok: true };
      },
    }),
  );
  const mark = (key: string, next: KinTaskStepStatus | null) =>
    setStatus((held) => {
      const rest = { ...held };
      delete rest[key];
      return next === null ? rest : { ...rest, [key]: next };
    });
  return {
    status,
    nudged,
    /** Answers the row's card with one of its options; a confirmed draft can't be taken back. */
    choose: async (
      key: string,
      step: Exclude<KinTaskStep, { readonly kind: "nudge" }>,
      optionId: string,
    ) => {
      const outcome = await act(step.card, optionId, () =>
        mark(key, { kind: "busy", id: optionId }),
      );
      if (outcome.status === "ignored") return;
      if (outcome.status === "failed")
        return mark(key, {
          kind: "failed",
          text: outcome.notice.text,
          widgetId: step.card.widgetId,
        });
      const label = step.card.options.find((option) => option.optionId === optionId)?.label;
      mark(key, {
        kind: "done",
        text:
          step.kind === "send" ? KIN_TASKS.sent(step.to) : KIN_TASKS.answered(label ?? optionId),
        widgetId: step.card.widgetId,
      });
    },
    nudge: async (key: string) => {
      if (nudged.has(key) || status[key]?.kind === "busy") return;
      mark(key, { kind: "busy", id: "nudge" });
      const result = await nudgeHolder({
        environmentId: target.environmentId,
        input: { orgId: target.orgId, key: KinRecordKey.make(key) },
      });
      if (AsyncResult.isSuccess(result)) {
        setNudged((held) => new Set([...held, key]));
        return mark(key, null);
      }
      mark(key, {
        kind: "failed",
        text: kinFailureText(squashAtomCommandFailure(result), KIN_TASKS.nudgeFailed),
      });
    },
  };
}
