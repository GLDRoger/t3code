import { CommonActions, StackActions, useNavigation } from "@react-navigation/native";
import type { KinSearchHitView } from "@t3tools/client-runtime/kin/kinDocs";
import { kinIsDealKey } from "@t3tools/client-runtime/kin/kinDeals";

import { kinLinkKeeps } from "./kinLinkStack";
import type { KinWorkTarget } from "./useKinWork";

type Params = ReactNavigation.RootParamList;
type RecordRoute = "KinWorkItem" | "KinClient" | "KinProject" | "KinDoc" | "KinDeal";

/**
 * Opens a task, client, project or doc. Followed from inside one, a page takes the place of
 * every record above the list it was opened from, and a sheet takes the place of the sheets
 * above the record page under it. So a sheet closes back to its record, Back returns to the list
 * the person started from, and records never stack.
 */
export function useKinWorkLink() {
  const navigation = useNavigation();
  const go = <Name extends RecordRoute>(name: Name, params: Params[Name]) => {
    const state = navigation.getState();
    const routes = state?.routes ?? [];
    const keep = kinLinkKeeps(
      routes.map((route) => route.name),
      name,
    );
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
  // A deal's key opens the deal, wherever it was followed from.
  return <Name extends RecordRoute>(name: Name, params: Params[Name]) => {
    if (name === "KinWorkItem") {
      const { task, ...rest } = params as Params["KinWorkItem"];
      if (kinIsDealKey(task)) return go("KinDeal", { ...rest, deal: task });
    }
    go(name, params);
  };
}

/** Opens what a search found, as a record link: a doc at the section the words are in, a money entry on its sheet. */
export function useKinOpenHit(target: KinWorkTarget) {
  const openRecord = useKinWorkLink();
  const navigation = useNavigation();
  const base = { environmentId: String(target.environmentId), orgId: String(target.orgId) };
  return (hit: KinSearchHitView) => {
    // What memory keeps opens where the owner sees and forgets it.
    if (hit.kind === "memory") navigation.navigate("KinMemory", { ...base, find: hit.title });
    else if (hit.kind === "docs")
      openRecord("KinDoc", {
        ...base,
        doc: hit.key,
        ...(hit.section === null ? {} : { section: hit.section.id }),
      });
    else if (hit.kind === "clients") openRecord("KinClient", { ...base, party: hit.key });
    else if (hit.kind === "projects") openRecord("KinProject", { ...base, project: hit.key });
    // A contact has no page of its own: its client's opens.
    else if (hit.clientKey !== null) openRecord("KinClient", { ...base, party: hit.clientKey });
    else openRecord("KinWorkItem", { ...base, task: hit.key });
  };
}
