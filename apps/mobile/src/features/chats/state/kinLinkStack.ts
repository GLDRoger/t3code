/** The search and concern sheets: a record opened from one takes its place. */
const SHEETS: ReadonlySet<string> = new Set(["KinSearch", "KinDealsConcern"]);
/** The param naming which record a record page shows. */
const KEY_PARAM: Readonly<Record<string, string>> = {
  KinWorkItem: "task",
  KinClient: "party",
  KinProject: "project",
  KinDoc: "doc",
  KinDeal: "deal",
};

export interface KinLinkRoute {
  readonly name: string;
  readonly params?: object | undefined;
}

const keyOf = (route: KinLinkRoute): unknown => {
  const param = KEY_PARAM[route.name];
  return param === undefined || route.params === undefined
    ? undefined
    : Reflect.get(route.params, param);
};

/**
 * Where a record a link opens goes. Already open below: back to that page (`again`), so pages
 * never repeat. Otherwise over the page it was followed from, so Back retraces each step; a
 * search or concern sheet on top gives up its place. `keep` routes stay under it.
 */
export function kinLinkPlace(
  routes: ReadonlyArray<KinLinkRoute>,
  opened: KinLinkRoute,
): { readonly keep: number; readonly again: boolean } {
  const key = keyOf(opened);
  const at =
    key === undefined
      ? -1
      : routes.findIndex((route) => route.name === opened.name && keyOf(route) === key);
  if (at >= 0) return { keep: at, again: true };
  let keep = routes.length;
  while (keep > 0 && SHEETS.has(routes[keep - 1]?.name ?? "")) keep -= 1;
  return { keep, again: false };
}
