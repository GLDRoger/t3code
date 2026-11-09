import {
  KIN_CHOICE_CARD_ACTION,
  KIN_CHOICE_CARD_TTL_MS,
  KinChoiceCardState,
  type KinPersonId,
  type KinWidget,
  type KinWidgetsActInput,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { kinSentences } from "../state/kinScreenState";

export const KIN_CHOICE_EXPIRED_TEXT = "This question expired. Answer in the chat instead.";

export interface KinChoiceCardView {
  readonly widgetId: KinWidget["widgetId"];
  readonly revision: number;
  readonly question: string;
  readonly detail: string | null;
  readonly options: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  readonly answer: {
    readonly optionId: string;
    readonly label: string;
    readonly personId: KinPersonId;
    readonly emoji: string | null;
  } | null;
  /** When an unanswered card stops taking taps; the host refuses later ones. */
  readonly expiresAtMs: number;
  readonly closed: boolean;
}

const decode = Schema.decodeUnknownOption(KinChoiceCardState);
// The lead writes these, so they are shown as plain text on one line.
const line = (text: string) => text.replace(/\s+/g, " ").trim();

export function kinChoiceCardView(widget: KinWidget): KinChoiceCardView | null {
  const state = decode(widget.state);
  if (Option.isNone(state)) return null;
  const card = state.value;
  const options = card.options.map((option) => ({
    id: option.optionId,
    label: line(option.label),
  }));
  const chosen =
    card.answer === null
      ? undefined
      : options.find((option) => option.id === card.answer?.optionId);
  return {
    widgetId: widget.widgetId,
    revision: widget.revision,
    question: line(card.question),
    detail: card.detail === null || card.detail.trim() === "" ? null : card.detail.trim(),
    options,
    answer:
      card.answer === null
        ? null
        : {
            optionId: card.answer.optionId,
            label: chosen?.label ?? card.answer.optionId,
            personId: card.answer.personId,
            emoji: card.answer.via === "reaction" ? card.answer.emoji : null,
          },
    // Unanswered cards are never rewritten, so `updatedAt` is still the time it was posted.
    expiresAtMs: Date.parse(widget.updatedAt) + KIN_CHOICE_CARD_TTL_MS,
    closed: widget.closedAt !== null,
  };
}

export type KinChoicePhase = "open" | "answered" | "expired";

export function kinChoicePhase(view: KinChoiceCardView, nowMs: number): KinChoicePhase {
  if (view.answer !== null) return "answered";
  return view.closed || nowMs >= view.expiresAtMs ? "expired" : "open";
}

/** "You chose “Ship it”", or with a reaction "You chose “Yes” with 👍". */
export function kinChoiceAnswerText(
  answer: NonNullable<KinChoiceCardView["answer"]>,
  viewerPersonId: KinPersonId | null,
): string {
  const who = answer.personId === viewerPersonId ? "You chose" : "Chose";
  return `${who} “${answer.label}”${answer.emoji === null ? "" : ` with ${answer.emoji}`}`;
}

export function kinChoiceAccessibilityLabel(view: KinChoiceCardView, status: string | null) {
  return kinSentences(["Question", view.question, view.detail, status]);
}

export function kinChoiceActInput(
  view: Pick<KinChoiceCardView, "widgetId" | "revision">,
  optionId: string,
  clientActionId: string,
): KinWidgetsActInput {
  return {
    widgetId: view.widgetId,
    revision: view.revision,
    actionId: KIN_CHOICE_CARD_ACTION,
    value: optionId,
    clientActionId,
  };
}

const decodeTap = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ text: Schema.String })),
);

/** A choice tap's own words (`Chose "Ship it" on "…"`), shown in place of its JSON. */
export function kinTapText(body: string): string | null {
  return Option.match(decodeTap(body), {
    onNone: () => null,
    onSome: (tap) => (tap.text.trim() === "" ? null : tap.text),
  });
}
