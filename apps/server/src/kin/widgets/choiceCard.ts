import {
  KIN_CHOICE_CARD_ACTION,
  KIN_CHOICE_CARD_TTL_MS,
  KinChatError,
  KinChoiceCardState,
  KinChoiceOption,
  KinText,
  KinTrimmedText,
  kinChoiceActionNote,
  type KinPersonId,
  type KinReactionEmoji,
  type KinSendCard,
  type KinWidget,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import { CardActionInput } from "./cardPlans.ts";

/** Why a question with fewer than two answers gets no card, and what to do with it instead. */
export const FEWER_THAN_TWO =
  "A card needs at least two answers, so nothing was asked: send it as a plain message instead.";
/** A card outside one person's direct chat: no question is stored, so nothing times it. */
export const NOTHING_TIMED = "No default and no day were set: this isn't one person's direct chat.";
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
/** What an agent's `kin_ask` takes: the card, the default it takes and when, and what it is about. */
export const LeadAskInput = Schema.Struct({
  ...AskInput.fields,
  options: Schema.Array(
    Schema.Struct({
      label: KinChoiceOption.fields.label,
      kind: KinChoiceOption.fields.kind,
      action: Schema.optional(CardActionInput),
    }),
    // Fewer than two is refused in the handler, with what to do instead (`FEWER_THAN_TWO`).
  ).check(Schema.isMaxLength(4)),
  default: KinTrimmedText.check(Schema.isMaxLength(80)),
  by: Schema.optional(KinTrimmedText.check(Schema.isMaxLength(10))),
  about: Schema.optional(
    Schema.Array(KinTrimmedText.check(Schema.isMaxLength(20))).check(Schema.isMaxLength(8)),
  ),
  intent: Schema.optional(KinTrimmedText.check(Schema.isMaxLength(120))),
});
/**
 * A card Kin itself asks may also show a picture of what it asks about, or exactly what a
 * connection would send; `kin_ask` can't.
 */
export type AskInput = typeof AskInput.Type & {
  readonly image?: { readonly attachmentId: string; readonly mimeType: string };
  readonly send?: KinSendCard;
  /** Asked for someone else: the card's first line (`askedBy` in `openQuestions.ts`). */
  readonly askedBy?: string;
  /** An agent's open question: it takes taps until the question closes. */
  readonly untilAnswered?: true;
  /**
   * The server's button and line for each option that runs a fixed action (`cardActions.ts`), by
   * index: the agent's own label for that option is never shown.
   */
  readonly actions?: ReadonlyArray<{ readonly label: string; readonly line: string } | undefined>;
  /** Runs in the card's own transaction before it is stored: a refusal stores nothing. */
  readonly recheck?: Effect.Effect<void, KinChatError>;
};
export const AskResult = Schema.Struct({
  widgetId: KinTrimmedText,
  messageId: KinTrimmedText,
  /** The open question it stored, when one person was asked. */
  question: Schema.optional(KinTrimmedText),
  /** The day Kin takes the default, or raises it again when there is none. */
  by: Schema.optional(KinTrimmedText),
  /**
   * Why Kin won't take a default on its own (`planAsk`), or `group`: not one person's direct
   * chat, so no question, default or day was stored.
   */
  untaken: Schema.optional(
    Schema.Literals(["none", "money", "leaves", "action", "repeats", "handed_back", "group"]),
  ),
  /** Set when Kin won't take the default on its own: why, and what happens instead. */
  note: Schema.optional(KinTrimmedText),
});
export const CloseInput = Schema.Struct({
  question: KinTrimmedText.check(Schema.isMaxLength(40)),
  outcome: Schema.Literals(["answered", "withdrawn"]),
  answer: Schema.optional(KinTrimmedText.check(Schema.isMaxLength(200))),
});
export const CloseResult = Schema.Struct({ question: KinTrimmedText, state: KinTrimmedText });

const decode = Schema.decodeUnknownEffect(KinChoiceCardState);
const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });

/** A label as a person reads it: two that read the same here look the same on any button. */
export const readAs = (label: string) =>
  label
    .replace(/\p{Default_Ignorable_Code_Point}/gu, "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const DETAIL_MAX = 2000;
/**
 * An option that runs an action shows the server's button and line and has no yes/no kind, so no
 * reaction can pick it. The lines are in `detail` too, for clients that don't read `action`.
 */
export const choiceCardState = (input: AskInput): KinChoiceCardState => {
  const options = input.options.map((option, index) => {
    const action = input.actions?.[index];
    return {
      optionId: `option-${index + 1}`,
      label: action?.label ?? option.label,
      ...(option.kind === undefined || action !== undefined ? {} : { kind: option.kind }),
      ...(action === undefined ? {} : { action: { line: action.line } }),
    };
  });
  const note = kinChoiceActionNote(options);
  const own = input.detail === undefined || input.detail.trim() === "" ? null : input.detail;
  const room = DETAIL_MAX - note.length - 2;
  const detail =
    note === ""
      ? own
      : own === null
        ? note
        : `${own.length <= room ? own : `${own.slice(0, room - 1)}…`}\n\n${note}`;
  return {
    question: input.question,
    detail,
    options,
    ...(input.image === undefined ? {} : { image: input.image }),
    ...(input.send === undefined ? {} : { send: input.send }),
    ...(input.askedBy === undefined ? {} : { askedBy: input.askedBy }),
    ...(input.untilAnswered === true ? { untilAnswered: true as const } : {}),
    answer: null,
  };
};

/**
 * Unanswered cards take taps for a day after they were posted (`KIN_CHOICE_CARD_TTL_MS`); an
 * open question's card takes them until the question closes it.
 */
export const choiceExpired = (widget: Pick<KinWidget, "updatedAt" | "state">, now: number) =>
  !(Predicate.hasProperty(widget.state, "untilAnswered") && widget.state.untilAnswered === true) &&
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
