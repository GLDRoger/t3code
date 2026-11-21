/**
 * One setting said once for many things (every mail account, every agent): what the shared row
 * shows, which things a thing's own page calls different, and which things a change must write.
 */

export type KinSettingSpread<T> =
  | { readonly kind: "none" }
  | { readonly kind: "same"; readonly value: T }
  /** `common` is the value most things have; on a tie, the first thing's. */
  | { readonly kind: "mixed"; readonly common: T };

export const KIN_SETTINGS_COPY = {
  mixed: "Mixed",
  differs: (thing: string) => `Different for this ${thing}`,
  loading: "Loading…",
  cancel: "Cancel",
  save: "Save",
  saving: "Saving…",
  back: "Back",
} as const;

export function kinSettingSpread<T>(
  values: ReadonlyArray<T>,
  same: (a: T, b: T) => boolean = Object.is,
): KinSettingSpread<T> {
  const counts: Array<{ value: T; count: number }> = [];
  for (const value of values) {
    const seen = counts.find((entry) => same(entry.value, value));
    if (seen === undefined) counts.push({ value, count: 1 });
    else seen.count += 1;
  }
  const [first] = counts;
  if (first === undefined) return { kind: "none" };
  if (counts.length === 1) return { kind: "same", value: first.value };
  const common = counts.reduce((best, entry) => (entry.count > best.count ? entry : best), first);
  return { kind: "mixed", common: common.value };
}

/** Whether one thing's own page says "Different for this …": only when the rest agree more. */
export const kinSettingDiffers = <T>(
  value: T,
  spread: KinSettingSpread<T>,
  same: (a: T, b: T) => boolean = Object.is,
) => spread.kind === "mixed" && !same(value, spread.common);

/** Setting one value for all: only the things that don't have it yet, so nothing is rewritten. */
export const kinSettingSetAll = <I, T>(
  items: ReadonlyArray<I>,
  valueOf: (item: I) => T,
  value: T,
  same: (a: T, b: T) => boolean = Object.is,
): ReadonlyArray<I> => items.filter((item) => !same(valueOf(item), value));
