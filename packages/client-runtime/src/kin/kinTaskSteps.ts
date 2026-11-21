import type { KinWidgetsActInput, KinWorkMoveCard } from "@t3tools/contracts";

import { kinFailureText } from "./kinAnswers.ts";
import { kinChoiceActInput, kinChoiceFailureNotice } from "./kinChoicePresentation.ts";
import { createKinCardActions } from "./kinDeferralPresentation.ts";
import { KIN_TASKS, type KinTaskStep } from "./kinTasksList.ts";

/** What a row's step is doing: on its way, done in the host's words, or refused with its reason. */
export type KinTaskStepStatus =
  | { readonly kind: "busy"; readonly id: string }
  | { readonly kind: "done"; readonly text: string; readonly widgetId?: string }
  | { readonly kind: "failed"; readonly text: string; readonly widgetId?: string };

export interface KinTaskStepsState {
  readonly status: Readonly<Record<string, KinTaskStepStatus>>;
  readonly nudged: ReadonlySet<string>;
}

export const KIN_TASK_STEPS_START: KinTaskStepsState = { status: {}, nudged: new Set() };

type Sent = Promise<{ readonly ok: true } | { readonly ok: false; readonly cause: unknown }>;

/**
 * A Tasks row's step: a draft's Confirm and a question's answer go through the chat card's own
 * action (`kin.widgets.act`), a nudge through `kin.work.nudge`. What each row's step is doing is
 * kept by task until the list reads it again. A row already nudged, or still busy, is not nudged
 * again.
 */
export function createKinTaskSteps(options: {
  readonly newId: () => string;
  readonly post: (input: KinWidgetsActInput) => Sent;
  readonly onChange: (state: KinTaskStepsState) => void;
}) {
  let state = KIN_TASK_STEPS_START;
  const set = (next: KinTaskStepsState) => {
    state = next;
    options.onChange(next);
  };
  const mark = (key: string, next: KinTaskStepStatus | null) => {
    const rest = { ...state.status };
    delete rest[key];
    set({ ...state, status: next === null ? rest : { ...rest, [key]: next } });
  };
  const act = createKinCardActions<KinWorkMoveCard, string>({
    newId: options.newId,
    toInput: kinChoiceActInput,
    failureNotice: kinChoiceFailureNotice,
    post: options.post,
  });
  return {
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
    nudge: async (key: string, send: () => Sent) => {
      if (state.nudged.has(key) || state.status[key]?.kind === "busy") return;
      mark(key, { kind: "busy", id: "nudge" });
      const result = await send();
      if (result.ok) {
        set({ ...state, nudged: new Set([...state.nudged, key]) });
        return mark(key, null);
      }
      mark(key, { kind: "failed", text: kinFailureText(result.cause, KIN_TASKS.nudgeFailed) });
    },
  };
}
