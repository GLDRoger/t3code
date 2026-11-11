import { createContext, use } from "react";

import type { AppBarSearch } from "../../../components/ui/AppBar.types";

/** Set around a page drawn as a tab of the Kin home: it has no Back, and a dock floats over its foot. */
export const KinTabContext = createContext<{ readonly bottomClearance: number } | null>(null);

export function useKinTab() {
  return use(KinTabContext);
}

/** A list's bar as a tab: no Back, and search under the title, since the dock has the foot. */
export function kinTabBar(
  tab: { readonly bottomClearance: number } | null,
  bar: { readonly onBack: () => void; readonly search: AppBarSearch },
): { readonly onBack?: () => void; readonly search: AppBarSearch } {
  return tab === null
    ? bar
    : { search: { ...bar.search, compactToolbar: false, placement: "top" } };
}
