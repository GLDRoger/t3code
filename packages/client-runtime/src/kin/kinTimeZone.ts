import { canonicalTimeZone, type EnvironmentId, type KinOrgId } from "@t3tools/contracts";
import type { Atom, AtomRegistry } from "effect/reactivity";

import type * as EnvironmentRegistry from "../connection/registry.ts";
import { createKinRpcCommand } from "./kinAccess.ts";
import { kinNowMs } from "./kinNow.ts";

export const KIN_TIME_ZONE_PLACEHOLDER = "City or region";

/** Whether two zone names are one zone: `Asia/Calcutta` is `Asia/Kolkata`. */
export const kinSameTimeZone = (a: string, b: string) => {
  try {
    return canonicalTimeZone(a) === canonicalTimeZone(b);
  } catch {
    return a === b;
  }
};

// ICU still answers with a zone's old spelling; people know it by the current one.
const CURRENT_NAMES: Readonly<Record<string, string>> = {
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Rangoon": "Asia/Yangon",
  "Europe/Kiev": "Europe/Kyiv",
  "America/Godthab": "America/Nuuk",
  "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
  "America/Indianapolis": "America/Indiana/Indianapolis",
  "America/Louisville": "America/Kentucky/Louisville",
  "Atlantic/Faeroe": "Atlantic/Faroe",
  "Pacific/Enderbury": "Pacific/Kanton",
  "Pacific/Ponape": "Pacific/Pohnpei",
  "Pacific/Truk": "Pacific/Chuuk",
};

/** A zone as profiles name it: "Asia/Kolkata", never the old "Asia/Calcutta". */
export const kinZoneName = (zone: string) => CURRENT_NAMES[zone] ?? zone;

const OFFSET_ONLY = /^(GMT|UTC)([+\-\u2212]|$)/;

/**
 * A zone as a person names it, in the platform's words for this device's language: "India
 * Standard Time", "Pacific Time". Never the id; "Kolkata" where the platform has no name for it.
 */
export function kinZoneLabel(zone: string, locale?: string, at = kinNowMs()): string {
  for (const style of ["longGeneric", "long"] as const) {
    try {
      const name = new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: style })
        .formatToParts(at)
        .find((part) => part.type === "timeZoneName")?.value;
      if (name !== undefined && name !== "" && !OFFSET_ONLY.test(name)) return name;
    } catch {
      // An engine without this style, or a zone it doesn't know: try the next.
    }
  }
  return (kinZoneName(zone).split("/").at(-1) ?? zone).replaceAll("_", " ");
}

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
          if (stored.value.fromHost !== true && kinSameTimeZone(stored.value.timeZone, device))
            return;
          return set.run(registry, { environmentId, input: { orgId, timeZone: device } });
        });
    }
  };
}
