import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeTap = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      text: Schema.optional(Schema.String),
      actionId: Schema.optional(Schema.String),
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
