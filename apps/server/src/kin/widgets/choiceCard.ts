import {
  KIN_CHOICE_CARD_ACTION,
  KIN_CHOICE_CARD_TTL_MS,
  KinChatError,
  KinChoiceCardState,
  KinChoiceOption,
  KinText,
  KinTrimmedText,
  type KinPersonId,
  type KinReactionEmoji,
  type KinWidget,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** What `kin_ask` takes: the server assigns option ids, so a lead can't collide them. */
export const AskInput = Schema.Struct({
  question: KinChoiceCardState.fields.question,
  options: Schema.Array(
    Schema.Struct({
      label: KinChoiceOption.fields.label,
      kind: KinChoiceOption.fields.kind,
    }),
  ).check(Schema.isMinLength(2), Schema.isMaxLength(4)),
  detail: Schema.optional(KinText.check(Schema.isMaxLength(2000))),
});
export type AskInput = typeof AskInput.Type;
export const AskResult = Schema.Struct({
  widgetId: KinTrimmedText,
  messageId: KinTrimmedText,
});

const decode = Schema.decodeUnknownEffect(KinChoiceCardState);
const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });

export const choiceCardState = (input: AskInput): KinChoiceCardState => ({
  question: input.question,
  detail: input.detail === undefined || input.detail.trim() === "" ? null : input.detail,
  options: input.options.map((option, index) => ({
    optionId: `option-${index + 1}`,
    label: option.label,
    ...(option.kind === undefined ? {} : { kind: option.kind }),
  })),
  answer: null,
});

/** Unanswered cards take taps for a day after they were posted; see `KIN_CHOICE_CARD_TTL_MS`. */
const choiceExpired = (widget: Pick<KinWidget, "updatedAt">, now: number) =>
  now - Date.parse(widget.updatedAt) >= KIN_CHOICE_CARD_TTL_MS;

/** The owner's tap as the lead reads it: their reply, in words. */
const choiceResumeText = (label: string, question: string) => `Chose "${label}" on "${question}"`;

/** The option a tap names, and its text. Fixed by the card, so a replayed tap reads the same. */
export const readChoice = Effect.fn("KinChoiceCard.read")(function* (
  widget: KinWidget,
  tap: { readonly actionId: string; readonly value?: unknown },
) {
  const card = yield* decode(widget.state).pipe(
    Effect.mapError(() => invalid("Invalid widget state.")),
  );
  if (tap.actionId !== KIN_CHOICE_CARD_ACTION) return yield* invalid("Unknown card action.");
  const option = card.options.find((candidate) => candidate.optionId === tap.value);
  if (option === undefined) return yield* invalid("Unknown option.");
  return { card, option, text: choiceResumeText(option.label, card.question) };
});

/**
 * The answered state, or why this tap can't settle the card. A choice is ordinary chat input and
 * never grants anything, unlike the signed approval, level and review cards.
 */
export const settleChoice = Effect.fn("KinChoiceCard.settle")(function* (
  widget: KinWidget,
  choice: Effect.Success<ReturnType<typeof readChoice>>,
  // `emoji` is set when an owner's yes/no reaction picked the option instead of a tap.
  by: {
    readonly personId: KinPersonId;
    readonly now: number;
    readonly emoji: KinReactionEmoji | null;
  },
) {
  if (choice.card.answer !== null)
    return yield* new KinChatError({
      reason: "widget_changed",
      message: "This question was already answered.",
    });
  if (!widget.awaiting.includes(by.personId))
    return yield* new KinChatError({
      reason: "not_allowed",
      message: "Chat operation not allowed.",
    });
  if (choiceExpired(widget, by.now)) return yield* invalid("This question expired.");
  return {
    ...choice.card,
    answer: {
      optionId: choice.option.optionId,
      personId: by.personId,
      via: by.emoji === null ? "tap" : "reaction",
      emoji: by.emoji,
      answeredAt: DateTime.formatIso(DateTime.makeUnsafe(by.now)),
    },
  } satisfies KinChoiceCardState;
});
