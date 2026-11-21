/**
 * A task, which opens over the record page under it, and the search and concern sheets, which it
 * takes over.
 */
const SHEETS: ReadonlySet<string> = new Set(["KinWorkItem", "KinSearch", "KinDealsConcern"]);
const RECORDS: ReadonlySet<string> = new Set([
  ...SHEETS,
  "KinClient",
  "KinProject",
  "KinDoc",
  "KinDeal",
]);

/** How many routes stay under a record opened by a link; all of them means it is pushed. */
export function kinLinkKeeps(routes: ReadonlyArray<string>, name: string): number {
  const replaces = SHEETS.has(name) ? SHEETS : RECORDS;
  let keep = routes.length;
  while (keep > 0 && replaces.has(routes[keep - 1] ?? "")) keep -= 1;
  return keep;
}
