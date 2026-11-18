import { it } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as Schema from "effect/Schema";

import { matchName } from "./nameMatch.ts";

// Invented names that share starts and near spellings, so ties and typos come up.
const WORDS = ["ana", "anand", "ben", "bena", "zoya", "zoe"];
const pick = <const L extends ReadonlyArray<string>>(literals: L) =>
  Arbitrary.schema(Schema.Literals(literals));
const int = (min: number, max: number) =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: min, maximum: max })));

const name = Arbitrary.all([pick(WORDS), pick(["", "", "rao", "iyer"])]).pipe(
  Arbitrary.map(([first, last]) => (last === "" ? first : `${first} ${last}`)),
);
const candidates = Arbitrary.array(name, { minLength: 1, maxLength: 8 }).pipe(
  Arbitrary.map((names) =>
    [...new Set(names)].map((one, i) => ({ key: `C-${i + 1}`, name: titled(one) })),
  ),
);
const titled = (text: string) => text.replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
/** What an agent might type: a short run of letters, a start of a name, or a name with a slip. */
const typed = Arbitrary.all([
  pick(WORDS),
  int(1, 5),
  pick(["a", "e", "o", "x", "z", " "]),
  int(0, 2),
]).pipe(
  Arbitrary.map(([word, length, letter, how]) =>
    how === 0
      ? word.slice(0, length)
      : how === 1
        ? `${word.slice(0, length)}${letter}${word.slice(length + 1)}`
        : letter.repeat(length),
  ),
);

const fold = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const distance = (a: string, b: string): number => {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1)
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    previous = current;
  }
  return previous[b.length]!;
};

it.prop(
  "a name typed as stored finds that one, and in any case or spacing when no other answers to it",
  [candidates, int(0, 7), pick(["stored", "upper", "lower", "spaced"])],
  ([all, index, style]) => {
    const one = all[index % all.length]!;
    const text =
      style === "stored"
        ? one.name
        : style === "upper"
          ? one.name.toUpperCase()
          : style === "lower"
            ? one.name.toLowerCase()
            : `  ${one.name.replace(" ", " - ")} `;
    const wanted = fold(one.name);
    const others = all.some(
      (other) =>
        other !== one &&
        (fold(other.name).startsWith(wanted) || ` ${fold(other.name)} `.includes(` ${wanted} `)),
    );
    const match = matchName(text, all);
    if (style !== "stored" && text.trim() !== one.name && others)
      return match._tag === "ambiguous" && match.items[0] === one;
    return match._tag === "found" && match.item === one;
  },
);

it.prop(
  "a name in another case than stored never picks it over a longer name that starts with it",
  [pick(WORDS), pick(["rao", "iyer"]), pick(["upper", "lower"])],
  ([first, last, style]) => {
    const short = { key: "C-1", name: titled(first) };
    const long = { key: "C-2", name: titled(`${first} ${last}`) };
    const match = matchName(style === "upper" ? first.toUpperCase() : first, [long, short]);
    return match._tag === "ambiguous" && match.items.length === 2 && match.items[0] === short;
  },
);

it.prop(
  "a start that several names share never picks one of them",
  [candidates, typed],
  ([all, text]) => {
    const wanted = fold(text);
    const names = all.map((one) => fold(one.name));
    if (wanted === "" || names.includes(wanted)) return true;
    if (names.filter((one) => one.startsWith(wanted)).length < 2) return true;
    return matchName(text, all)._tag !== "found";
  },
);

it.prop(
  "what a name finds is spelled mostly as typed, and a miss offers only near names",
  [candidates, typed],
  ([all, text]) => {
    const wanted = fold(text);
    const match = matchName(text, all);
    const close = (one: { name: string }) => {
      const name = fold(one.name);
      const slips = Math.min(
        distance(name, wanted),
        distance(name.slice(0, wanted.length), wanted),
      );
      // More of the typed letters right than wrong.
      return wanted.length - slips > slips;
    };
    if (match._tag === "found") return close(match.item);
    if (match._tag === "none")
      return match.nearest.length <= 3 && match.nearest.every((one) => all.includes(one));
    return match.items.length >= 2;
  },
);
