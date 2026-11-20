import {
  canonicalTimeZone,
  KinChatError,
  type EnvironmentId,
  type KinOrgId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import type { Atom, AtomRegistry } from "effect/reactivity";

import type * as EnvironmentRegistry from "../connection/registry.ts";
import type { AtomCommandResult } from "../state/runtime.ts";
import { createKinRpcCommand } from "./kinAccess.ts";
import { kinNowMs } from "./kinNow.ts";

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

// The host's answer ends the sync for this run; a dropped link, a session not loaded yet or a
// host still starting up is tried again at the next directory read.
const isKinChatError = Schema.is(KinChatError);
const answered = (result: AtomCommandResult<unknown, unknown>) => {
  if (result._tag === "Success") return true;
  const error = Cause.squash(result.cause);
  return isKinChatError(error) && error.reason !== "unavailable";
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
  // Running or settled. The calls authorize themselves, waiting for the session to load.
  const started = new Set<string>();
  return (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
    orgIds: ReadonlyArray<KinOrgId>,
  ) => {
    const device = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!device) return Promise.resolve();
    const sync = async (orgId: KinOrgId) => {
      const key = `${environmentId}\u0000${orgId}`;
      if (started.has(key)) return;
      started.add(key);
      const settled = (result: AtomCommandResult<unknown, unknown>) => {
        if (!answered(result)) started.delete(key);
      };
      const target = { environmentId, input: { orgId } };
      const me = await accessRead.run(registry, target);
      if (me._tag !== "Success") return settled(me);
      if (me.value.access !== "owner") return;
      const stored = await read.run(registry, target);
      if (stored._tag !== "Success") return settled(stored);
      if (stored.value.fromHost !== true && kinSameTimeZone(stored.value.timeZone, device)) return;
      settled(await set.run(registry, { environmentId, input: { orgId, timeZone: device } }));
    };
    return Promise.all(orgIds.map(sync)).then(() => undefined);
  };
}
