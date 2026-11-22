import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../../state/atom-registry";

/** Computers this phone is signing out of or forgetting: nothing about one shows meanwhile. */
export const kinLeavingAtom = Atom.make<ReadonlyArray<EnvironmentId>>([]).pipe(Atom.keepAlive);

/**
 * Lets computers go, all hidden at once and removed in order. Done or failed, each then leaves the
 * list: a failed removal shows it again, and the same computer joined again later (it keeps its
 * id) shows as it is. One failing doesn't stop the rest; the first failure is rethrown at the end.
 */
export async function kinLetGo(
  environmentIds: ReadonlyArray<EnvironmentId>,
  remove: (environmentId: EnvironmentId) => Promise<unknown>,
): Promise<void> {
  appAtomRegistry.set(kinLeavingAtom, [...appAtomRegistry.get(kinLeavingAtom), ...environmentIds]);
  const failures: Array<unknown> = [];
  for (const environmentId of environmentIds) {
    try {
      await remove(environmentId);
    } catch (cause) {
      failures.push(cause);
    } finally {
      appAtomRegistry.set(
        kinLeavingAtom,
        appAtomRegistry.get(kinLeavingAtom).filter((one) => one !== environmentId),
      );
    }
  }
  if (failures.length > 0) throw failures[0];
}
