// By sound, not spelling: "a user", "a unit", "a euro", "an hour"; letters by name: "an SVG".
const AN_WORD =
  /^(?!eu|one\b|once\b|u(?:ni|[bcdfgklmprstvz][aeiouy]))(?:[aeiou]|hour|honest|honou?r|heir)/i;
const AN_LETTER = /^[AEFHILMNORSX]/;
const ACRONYM = /^[A-Z]{2,}(?![a-z])/;

/** The word with "a" or "an" before it: "an invoice", or with `start` "A", "An invoice". */
export const withArticle = (word: string, start: "a" | "A" = "a") =>
  `${start}${(ACRONYM.test(word) ? AN_LETTER : AN_WORD).test(word) ? "n" : ""} ${word}`;
