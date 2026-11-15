import { StackActions, useNavigation } from "@react-navigation/native";
import type { KinDockTab } from "@t3tools/client-runtime/kin/kinJoin";
import type { KinWorkRef } from "@t3tools/client-runtime/kin/kinWork";
import type { KinWorkPlace } from "@t3tools/client-runtime/kin/kinWorkHome";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../../state/atom-registry";
import type { KinWorkTarget } from "./useKinWork";
import { readKinIsHome } from "./kinHome";

export interface KinTasksNarrow {
  readonly party: KinWorkRef | null;
  readonly project: KinWorkRef | null;
}

/**
 * The Kin home's open tab, and what Tasks was last asked to narrow to. `opened` counts the asks,
 * so asking for the same narrowing again starts Tasks from it again.
 */
export const kinHomeTabAtom = Atom.make<{
  readonly tab: KinDockTab;
  readonly tasks: KinTasksNarrow | null;
  readonly opened: number;
}>({ tab: "chats", tasks: null, opened: 0 }).pipe(Atom.keepAlive);

/**
 * "See all" from a record: where the places are tabs, the place's tab, narrowed, with every page
 * above it closed; over coding threads, where there is no dock, the place as a page.
 */
export function useKinOpenPlace(target: KinWorkTarget) {
  const navigation = useNavigation();
  return (place: KinWorkPlace, narrow?: KinTasksNarrow) => {
    if (readKinIsHome()) {
      const held = appAtomRegistry.get(kinHomeTabAtom);
      appAtomRegistry.set(kinHomeTabAtom, {
        tab: place,
        tasks: narrow ?? null,
        opened: held.opened + 1,
      });
      if ((navigation.getState()?.index ?? 0) > 0) navigation.dispatch(StackActions.popToTop());
      return;
    }
    navigation.dispatch(
      StackActions.push("KinWork", {
        environmentId: String(target.environmentId),
        orgId: String(target.orgId),
        show: place,
        ...(narrow?.party == null
          ? {}
          : { party: narrow.party.key, partyName: narrow.party.title }),
        ...(narrow?.project == null
          ? {}
          : { project: narrow.project.key, projectName: narrow.project.title }),
      }),
    );
  };
}
