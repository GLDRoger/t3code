import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../../state/atom-registry";

/** Computers this phone is signing out of or forgetting: nothing about one shows meanwhile. */
export const kinLeavingAtom = Atom.make<ReadonlyArray<EnvironmentId>>([]).pipe(Atom.keepAlive);

/**
 * Lets one computer go. Done or failed, it then leaves the list: a failed removal shows it again,
 * and the same computer joined again later (it keeps its id) shows as it is.
 */
export async function kinLetGo(
  environmentId: EnvironmentId,
  remove: (environmentId: EnvironmentId) => Promise<unknown>,
): Promise<void> {
  appAtomRegistry.set(kinLeavingAtom, [...appAtomRegistry.get(kinLeavingAtom), environmentId]);
  try {
    await remove(environmentId);
  } finally {
    appAtomRegistry.set(
      kinLeavingAtom,
      appAtomRegistry.get(kinLeavingAtom).filter((one) => one !== environmentId),
    );
  }
}
