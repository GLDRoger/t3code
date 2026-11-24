import { kinDraftOpeningLine } from "@t3tools/contracts";

/** A draft up to this long travels whole on its cards; a longer one as its opening and version. */
export const DRAFT_TEXT_MAX = 1800;
/** A long draft's opening, as its cards carry it: at most this many characters. */
export const OPENING_MAX = 1000;

/**
 * The one rule for whether a draft is long: bound to its doc's version wherever it goes, and
 * carried as its opening. Its text past `DRAFT_TEXT_MAX`, or a card already holding only an opening.
 */
export const isLongDraft = (text: string, card?: { readonly whole?: unknown }) =>
  text.trim().length > DRAFT_TEXT_MAX || card?.whole !== undefined;

const SENTENCE_END = /[.!?。！？](?=["'”’)\]]*(\s|$))|[。！？]|\n\s*\n/g;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * The last place at or before `at` where `text` may be cut without splitting a character; inside a
 * first character longer than that, the last place that splits no code point.
 */
const cutAt = (text: string, at: number) => {
  if (at >= text.length) return text.length;
  let last = 0;
  // Segmented whole, lazily: a slice would end a cluster where the text does not.
  for (const { index } of graphemes.segment(text)) {
    if (index > at) break;
    last = index;
  }
  if (last > 0) return last;
  const next = text.charCodeAt(at);
  return next >= 0xdc00 && next <= 0xdfff ? at - 1 : at;
};

/**
 * The start of `text`, at most `max` characters, ending where a sentence or paragraph ends when
 * one does in its second half, else at a word's end; a first word longer than `max` is cut between
 * characters and ends "…".
 */
export const draftOpening = (text: string, max = OPENING_MAX) => {
  const whole = text.trim();
  if (whole.length <= max) return whole;
  const head = whole.slice(0, max + 1);
  let sentence = -1;
  for (const found of head.matchAll(SENTENCE_END)) {
    const end = found[0].startsWith("\n") ? found.index : found.index + found[0].length;
    if (end <= max) sentence = end;
  }
  if (sentence >= max / 2) return whole.slice(0, cutAt(whole, sentence)).trimEnd();
  const space = head.search(/\s\S*$/);
  if (space > 0) return whole.slice(0, cutAt(whole, space)).trimEnd();
  return `${whole.slice(0, cutAt(whole, max - 1))}…`;
};

/**
 * What a draft's doc card carries of a version's text: all of it, or its opening, with a line an
 * older client shows and copies with it, and how long the whole is.
 */
export const draftOnCard = (body: string, version: number, key: string) =>
  isLongDraft(body)
    ? {
        text: `${draftOpening(body)}\n\n${kinDraftOpeningLine(key)}`,
        whole: { version, chars: body.trim().length },
      }
    : { text: body };
