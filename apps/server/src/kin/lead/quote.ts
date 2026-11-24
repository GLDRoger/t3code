/** The most of a message body a lead is shown; past it the prompt cuts the text. */
export const messageBodyLimit = 8_000;
const textFieldLimit = 2_000;

const cut = (field: string, limit: number) => {
  if (field.length <= limit) return field;
  const code = field.charCodeAt(limit - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit;
  return `${field.slice(0, end)}…[truncated ${field.length - end} chars]`;
};

// Markup, control, format (bidi, zero-width) and line-separator characters.
const unsafeCharacter = /[<>&\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const unicodeEscape = (character: string) =>
  character
    .split("")
    .map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`)
    .join("");
// One pass, so JSON's own escapes are read whole and never re-escaped.
const unsafeOrEscape = new RegExp(
  `\\\\(?:["\\\\/bfnrt]|u[\\da-fA-F]{4})|${unsafeCharacter.source}`,
  "gu",
);
const controls: Readonly<Record<string, string>> = {
  "\\b": "\\u0008",
  "\\f": "\\u000c",
  "\\n": "\\u000a",
  "\\r": "\\u000d",
  "\\t": "\\u0009",
};

/** A text field as a lead is shown it in a tool result: cut past `limit`, escaped as `quote()` escapes it. */
export const cappedText = (field: string, limit = textFieldLimit) =>
  cut(field, limit).replace(unsafeCharacter, unicodeEscape);

/** Text fields cut past their limits, but for those named in `whole`, which go in whole. */
export type CapText = boolean | { readonly whole: ReadonlyArray<string> };

export function encoded(value: unknown, capText: CapText = false): string {
  const whole = typeof capText === "object" ? capText.whole : [];
  const json =
    JSON.stringify(value, (key, field: unknown) =>
      !capText || typeof field !== "string" || whole.includes(key)
        ? field
        : cut(field, key === "body" ? messageBodyLimit : textFieldLimit),
    ) ?? "null";
  return json.replace(unsafeOrEscape, (character) =>
    character.startsWith("\\") ? (controls[character] ?? character) : unicodeEscape(character),
  );
}

export const quoteLines = (label: string, lines: ReadonlyArray<string>) =>
  `> BEGIN QUOTE: ${label}\n${lines.map((line) => `> ${line}`).join("\n")}\n> END QUOTE`;

export function quote(label: string, value: unknown, capText: CapText = false): string {
  return quoteLines(label, [encoded(value, capText)]);
}
