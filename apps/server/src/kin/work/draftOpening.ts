/** A draft up to this long travels whole on its cards; a longer one as its opening and version. */
export const DRAFT_TEXT_MAX = 1800;
/** A long draft's opening, as its cards carry it: at most this many characters. */
export const OPENING_MAX = 1000;

const SENTENCE_END = /[.!?。！？](?=["'”’)\]]*(\s|$))|[。！？]|\n\s*\n/g;

/**
 * The start of `text`, at most `max` characters, ending where a sentence or paragraph ends when
 * one does in its second half, else at a word's end; mid-word only for one word longer than `max`.
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
  if (sentence >= max / 2) return whole.slice(0, sentence).trimEnd();
  const space = head.search(/\s\S*$/);
  return (space > 0 ? whole.slice(0, space) : whole.slice(0, max)).trimEnd();
};

/** What a draft's doc card carries of a version's text: all of it, or its opening and how long. */
export const draftOnCard = (body: string, version: number) => {
  const chars = body.trim().length;
  return chars <= DRAFT_TEXT_MAX
    ? { text: body }
    : { text: draftOpening(body), whole: { version, chars } };
};
