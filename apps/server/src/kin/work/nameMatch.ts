/** A name as a person types it: case, spacing and punctuation don't count. */
const fold = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const distance = (a: string, b: string) => {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
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

/** Typos allowed for a name this long: one per five letters, at least one. */
const slack = (text: string) => Math.max(1, Math.floor(text.length / 5));

const NEAREST = 3;

export type NameMatch<T> =
  | { readonly _tag: "found"; readonly item: T }
  | { readonly _tag: "ambiguous"; readonly items: ReadonlyArray<T> }
  | { readonly _tag: "none"; readonly nearest: ReadonlyArray<T> };

/**
 * The one candidate a typed name means: its key, its exact name, a unique start of its name
 * ("Lumen Grove" for Lumen Grove Clinics), or a unique close spelling. Otherwise the several it
 * could be, or the nearest names to offer back.
 */
export const matchName = <T extends { readonly key?: string | null; readonly name: string }>(
  typed: string,
  candidates: ReadonlyArray<T>,
): NameMatch<T> => {
  const wanted = fold(typed);
  const byKey = candidates.filter(
    (one) => one.key != null && one.key.toUpperCase() === typed.trim().toUpperCase(),
  );
  if (byKey.length === 1) return { _tag: "found", item: byKey[0]! };
  if (wanted === "") return { _tag: "none", nearest: [] };
  const tiers = [
    (name: string) => name === wanted,
    (name: string) => name.startsWith(`${wanted} `) || name.startsWith(wanted),
    (name: string) =>
      distance(name, wanted) <= slack(wanted) ||
      distance(name.slice(0, wanted.length), wanted) <= slack(wanted),
  ];
  for (const fits of tiers) {
    const found = candidates.filter((one) => fits(fold(one.name)));
    if (found.length === 1) return { _tag: "found", item: found[0]! };
    if (found.length > 1) return { _tag: "ambiguous", items: found };
  }
  const nearest = candidates
    .map((one) => ({ one, score: distance(fold(one.name).slice(0, wanted.length + 3), wanted) }))
    .filter(({ score }) => score <= Math.max(3, Math.ceil(wanted.length / 2)))
    .toSorted((a, b) => a.score - b.score)
    .slice(0, NEAREST)
    .map(({ one }) => one);
  return { _tag: "none", nearest };
};
