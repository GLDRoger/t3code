/** What Make invoice or Make its PDF makes, and for whom: a step of the entry's sheet. */
export interface KinMakeStep {
  /** The list whose templates make it. */
  readonly list: string;
  /** The entry's currency: every line is in it. */
  readonly currency: string;
  /** The invoice's client, to edit when a detail of theirs is missing. */
  readonly party: { readonly key: string; readonly title: string } | null;
}
