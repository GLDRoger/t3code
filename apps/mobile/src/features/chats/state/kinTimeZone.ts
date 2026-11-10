import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { canonicalTimeZone, type EnvironmentId, type KinOrgId } from "@t3tools/contracts";
import type { AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../../../connection/runtime";

const timeZoneRead = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "kin:time-zone:read",
  tag: "kin.triggers.getTimeZone",
});
const timeZoneSet = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "kin:time-zone:set",
  tag: "kin.triggers.setTimeZone",
});

const sameZone = (a: string, b: string) => {
  try {
    return canonicalTimeZone(a) === canonicalTimeZone(b);
  } catch {
    return a === b;
  }
};

const attempted = new Set<string>();

/** Once per app run and org: store this device's zone when the owner's stored zone differs. */
export function syncKinOwnerTimeZone(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  orgIds: ReadonlyArray<KinOrgId>,
) {
  if (!registry.get(timeZoneSet.permissionAtom(environmentId))) return;
  const device = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!device) return;
  for (const orgId of orgIds) {
    const key = `${environmentId}\u0000${orgId}`;
    if (attempted.has(key)) continue;
    attempted.add(key);
    // Members are refused the read, which ends the sync for them.
    void timeZoneRead.run(registry, { environmentId, input: { orgId } }).then((stored) => {
      if (stored._tag !== "Success" || sameZone(stored.value.timeZone, device)) return;
      return timeZoneSet.run(registry, { environmentId, input: { orgId, timeZone: device } });
    });
  }
}
