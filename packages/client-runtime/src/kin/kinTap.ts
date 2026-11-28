import { KIN_CHOICE_CARD_ACTION } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeTap = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      text: Schema.optional(Schema.String),
      actionId: Schema.optional(Schema.String),
      widgetId: Schema.optional(Schema.String),
    }),
  ),
);

// The host writes a tap for the lead as `Chose "Yes" on "Ship?"` or `Tapped "Done" on the reminder "…"`.
const TAP_LABEL = /^(?:Chose|Tapped) "(.+?)" on /;

const KIN_TAP_FALLBACK_TEXT = "Tapped a button";

/**
 * A card tap as the button the person pressed ("Done", "In 1 hour"), the way a quick reply reads
 * in any messenger. Never the stored JSON: a body this build can't read becomes a plain phrase.
 */
export function kinTapText(body: string): string {
  const tap = Option.getOrNull(decodeTap(body));
  if (tap === null) return KIN_TAP_FALLBACK_TEXT;
  const text = tap.text?.trim() ?? "";
  const label = TAP_LABEL.exec(text)?.[1];
  if (label !== undefined) return label;
  if (text !== "") return text;
  const action = tap.actionId?.replace(/_/g, " ").trim() ?? "";
  return action === "" ? KIN_TAP_FALLBACK_TEXT : action.charAt(0).toUpperCase() + action.slice(1);
}

// The card's title closes the host's words: `on "Ship?"`, `on the reminder "Send the quote"`.
const TAP_CARD_TITLE = /^(?:Chose|Tapped) ".+?" on (?:the [a-z ]+ )?"(.+)"$/;

/**
 * A tap as its bubble reads in the chat, naming the card it was on ("Done · Send the quote"):
 * the card may be far above it. A tap whose words name no title keeps the label alone.
 */
export function kinTapLine(body: string): string {
  const label = kinTapText(body);
  const text = Option.getOrNull(decodeTap(body))?.text?.trim() ?? "";
  const title = TAP_CARD_TITLE.exec(text)?.[1];
  return title === undefined ? label : `${label} · ${title}`;
}

/**
 * A tap the card itself answers: a choice card says what was chosen or done, and a statement
 * card what it recorded or took back, so the tap needs no bubble of its own.
 */
export function kinTapAnswersChoice(body: string): boolean {
  const tap = Option.getOrNull(decodeTap(body));
  return (
    tap?.actionId === KIN_CHOICE_CARD_ACTION || tap?.widgetId?.startsWith("kin-statement:") === true
  );
}
