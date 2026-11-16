import { canonicalTimeZone, type EnvironmentId, type KinOrgId } from "@t3tools/contracts";
import type { Atom, AtomRegistry } from "effect/reactivity";

import type * as EnvironmentRegistry from "../connection/registry.ts";
import { createKinRpcCommand } from "./kinAccess.ts";

const sameZone = (a: string, b: string) => {
  try {
    return canonicalTimeZone(a) === canonicalTimeZone(b);
  } catch {
    return a === b;
  }
};

/**
 * The owner's own device keeps the company's zone: once per app run and org, when none was set
 * (the host's stands in) or it differs, this device's zone is stored. A co-owner's never is.
 */
export function createKinOwnerTimeZoneSync<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
) {
  const accessRead = createKinRpcCommand(runtime, {
    label: "kin:time-zone:access",
    tag: "kin.access.me",
  });
  const read = createKinRpcCommand(runtime, {
    label: "kin:time-zone:read",
    tag: "kin.triggers.getTimeZone",
  });
  const set = createKinRpcCommand(runtime, {
    label: "kin:time-zone:set",
    tag: "kin.triggers.setTimeZone",
  });
  const attempted = new Set<string>();
  return (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
    orgIds: ReadonlyArray<KinOrgId>,
  ) => {
    if (!registry.get(set.permissionAtom(environmentId))) return;
    const device = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!device) return;
    for (const orgId of orgIds) {
      const key = `${environmentId}\u0000${orgId}`;
      if (attempted.has(key)) continue;
      attempted.add(key);
      const target = { environmentId, input: { orgId } };
      void accessRead
        .run(registry, target)
        .then((me) =>
          me._tag === "Success" && me.value.access === "owner" ? read.run(registry, target) : null,
        )
        .then((stored) => {
          if (stored?._tag !== "Success") return;
          if (stored.value.fromHost !== true && sameZone(stored.value.timeZone, device)) return;
          return set.run(registry, { environmentId, input: { orgId, timeZone: device } });
        });
    }
  };
}
