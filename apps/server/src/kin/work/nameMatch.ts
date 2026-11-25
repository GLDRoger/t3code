/** A name as a person types it: case, spacing and punctuation don't count. */
export const fold = (text: string) =>
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

/** Typos allowed for a name this long: one per five letters; none in under three letters. */
const slack = (text: string) => (text.length < 3 ? 0 : Math.max(1, Math.floor(text.length / 5)));

const NEAREST = 3;

export type NameMatch<T> =
  | { readonly _tag: "found"; readonly item: T }
  | { readonly _tag: "ambiguous"; readonly items: ReadonlyArray<T> }
  | { readonly _tag: "none"; readonly nearest: ReadonlyArray<T> };

/**
 * The one candidate a typed name means: its key, its exact name as stored, or the one name that
 * answers to it (the same name in any case or spacing, a start of it, "Lumen Grove" for Lumen
 * Grove Clinics), else a unique close spelling. When others also answer to it, by any of those or
 * as a whole word of their name, the several it could be; otherwise the nearest names to offer.
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
  const exact = candidates.filter((one) => one.name.trim() === typed.trim());
  if (exact.length === 1) return { _tag: "found", item: exact[0]! };
  const folded = candidates.map((one) => ({ one, name: fold(one.name) }));
  const same = folded.filter(({ name }) => name === wanted);
  const starts = folded.filter(({ name }) => name !== wanted && name.startsWith(wanted));
  const pool = [...same, ...starts];
  if (pool.length > 0) {
    const words = folded.filter(
      (entry) => !pool.includes(entry) && ` ${entry.name} `.includes(` ${wanted} `),
    );
    const all = [...pool, ...words].map(({ one }) => one);
    return all.length === 1 ? { _tag: "found", item: all[0]! } : { _tag: "ambiguous", items: all };
  }
  const close = candidates.filter((one) => {
    const name = fold(one.name);
    return (
      distance(name, wanted) <= slack(wanted) ||
      distance(name.slice(0, wanted.length), wanted) <= slack(wanted)
    );
  });
  if (close.length === 1) return { _tag: "found", item: close[0]! };
  if (close.length > 1) return { _tag: "ambiguous", items: close };
  const nearest = candidates
    .map((one) => ({ one, score: distance(fold(one.name).slice(0, wanted.length + 3), wanted) }))
    .filter(({ score }) => score <= Math.max(3, Math.ceil(wanted.length / 2)))
    .toSorted((a, b) => a.score - b.score)
    .slice(0, NEAREST)
    .map(({ one }) => one);
  return { _tag: "none", nearest };
};
