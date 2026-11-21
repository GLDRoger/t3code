/** The most of a message body a lead is shown; past it the prompt cuts the text. */
export const messageBodyLimit = 8_000;
const textFieldLimit = 2_000;

export function encoded(value: unknown, capText = false): string {
  const json =
    JSON.stringify(value, (key, field: unknown) => {
      if (!capText || typeof field !== "string") return field;
      const limit = key === "body" ? messageBodyLimit : textFieldLimit;
      if (field.length <= limit) return field;
      const code = field.charCodeAt(limit - 1);
      const cut = code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit;
      return `${field.slice(0, cut)}…[truncated ${field.length - cut} chars]`;
    }) ?? "null";
  return json.replace(
    /\\(?:["\\/bfnrt]|u[\da-fA-F]{4})|[<>&\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
    (character) => {
      const controls: Readonly<Record<string, string>> = {
        "\\b": "\\u0008",
        "\\f": "\\u000c",
        "\\n": "\\u000a",
        "\\r": "\\u000d",
        "\\t": "\\u0009",
      };
      if (character.startsWith("\\")) return controls[character] ?? character;
      return character
        .split("")
        .map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`)
        .join("");
    },
  );
}

export const quoteLines = (label: string, lines: ReadonlyArray<string>) =>
  `> BEGIN QUOTE: ${label}\n${lines.map((line) => `> ${line}`).join("\n")}\n> END QUOTE`;

export function quote(label: string, value: unknown, capText = false): string {
  return quoteLines(label, [encoded(value, capText)]);
}
