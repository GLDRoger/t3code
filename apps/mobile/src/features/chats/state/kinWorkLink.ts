import { CommonActions, StackActions, useNavigation } from "@react-navigation/native";
import type { KinSearchHitView } from "@t3tools/client-runtime/kin/kinDocs";

import type { KinWorkTarget } from "./useKinWork";

type Params = ReactNavigation.RootParamList;
type RecordRoute = "KinWorkItem" | "KinClient" | "KinProject" | "KinDoc";

/** Records drawn as sheets, and the search sheet, which a record opened from it takes over. */
const SHEETS: ReadonlySet<string> = new Set(["KinWorkItem", "KinSearch"]);
const RECORDS: ReadonlySet<string> = new Set([...SHEETS, "KinClient", "KinProject", "KinDoc"]);

/**
 * Opens a task, client, project or doc. Followed from inside one, a page takes the place of
 * every record above the list it was opened from, and a sheet takes the place of the sheets
 * above the record page under it. So a sheet closes back to its record, Back returns to the list
 * the person started from, and records never stack.
 */
export function useKinWorkLink() {
  const navigation = useNavigation();
  return <Name extends RecordRoute>(name: Name, params: Params[Name]) => {
    const state = navigation.getState();
    const routes = state?.routes ?? [];
    const replaces = SHEETS.has(name) ? SHEETS : RECORDS;
    let keep = routes.length;
    while (keep > 0 && replaces.has(routes[keep - 1]?.name ?? "")) keep -= 1;
    if (state === undefined || keep === routes.length) {
      navigation.dispatch(StackActions.push(name, params));
      return;
    }
    navigation.dispatch(
      CommonActions.reset({
        ...state,
        index: keep,
        routes: [...routes.slice(0, keep), { name, params }],
      }),
    );
  };
}

/** Opens what a search found, as a record link: a doc at the section the words are in. */
export function useKinOpenHit(target: KinWorkTarget) {
  const openRecord = useKinWorkLink();
  const base = { environmentId: String(target.environmentId), orgId: String(target.orgId) };
  return (hit: KinSearchHitView) => {
    if (hit.kind === "docs")
      openRecord("KinDoc", {
        ...base,
        doc: hit.key,
        ...(hit.section === null ? {} : { section: hit.section.id }),
      });
    else if (hit.kind === "clients") openRecord("KinClient", { ...base, party: hit.key });
    else if (hit.kind === "projects") openRecord("KinProject", { ...base, project: hit.key });
    else openRecord("KinWorkItem", { ...base, task: hit.key });
  };
}
