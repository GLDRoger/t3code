import { kinMailRuleBreaks } from "@t3tools/client-runtime/kin/kinMailRules";

/** Each piece of `text` with where it starts, for a key that stays put. */
function piecesOf(text: string) {
  const pieces: Array<{ readonly start: number; readonly part: string }> = [];
  let start = 0;
  for (const part of kinMailRuleBreaks(text)) {
    pieces.push({ start, part });
    start += part.length;
  }
  return pieces;
}

/** An address or domain broken only after `@` and `.`, never cut. */
export function Breakable(props: { readonly text: string }) {
  return (
    <>
      {piecesOf(props.text).map(({ start, part }) => (
        <span key={start}>
          {start === 0 ? null : <wbr />}
          {part}
        </span>
      ))}
    </>
  );
}
