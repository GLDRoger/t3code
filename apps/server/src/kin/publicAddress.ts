import { kinIsLocalOnlyHost } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { CloudLink } from "../cloud/CloudLink.ts";

// Blank counts as unset.
const configured = Config.option(Config.String("KIN_PUBLIC_URL")).pipe(
  Config.map(Option.map((value) => value.trim())),
  Config.map(Option.filter((value) => value !== "")),
);

/** An https origin someone elsewhere can reach, or nothing. */
const reachableOrigin = (value: string) => {
  if (!URL.canParse(value)) return undefined;
  const url = new URL(value);
  if (url.protocol !== "https:" || kinIsLocalOnlyHost(url.hostname)) return undefined;
  return url.origin;
};

const fromConfig = configured.pipe(
  Effect.map(Option.flatMap((value) => Option.fromUndefinedOr(reachableOrigin(value)))),
  Effect.orElseSucceed(() => Option.none<string>()),
);

/**
 * The address anyone on another device can reach this host by: `KIN_PUBLIC_URL` when it is a
 * good https origin, else T3 Connect's tunnel while it serves this host, else none. A LAN,
 * tailnet or relay connection gives the host no address of its own to name.
 */
export const publicAddress = Effect.fn("KinPublicAddress.publicAddress")(function* () {
  // Never read from a request (Host, Origin, X-Forwarded-*): a caller must not pick the address.
  const set = yield* fromConfig;
  if (Option.isSome(set)) return set.value;
  const cloud = yield* Effect.serviceOption(CloudLink);
  if (Option.isNone(cloud)) return undefined;
  const state = yield* cloud.value.linkState().pipe(Effect.option);
  if (Option.isNone(state)) return undefined;
  const { linked, linkRevoked, tunnelHostname } = state.value;
  if (!linked || linkRevoked || tunnelHostname === undefined) return undefined;
  return reachableOrigin(`https://${tunnelHostname}`);
});

/** Run once at start: a `KIN_PUBLIC_URL` that will be ignored is said once, never fatal. */
export const checkPublicUrl = Effect.fn("KinPublicAddress.checkPublicUrl")(function* () {
  const set = yield* configured.pipe(Effect.orElseSucceed(() => Option.none<string>()));
  if (Option.isSome(set) && reachableOrigin(set.value) === undefined)
    yield* Effect.logWarning(
      "KIN_PUBLIC_URL ignored: it must be an https address other devices can reach.",
    );
});
