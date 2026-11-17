import {
  type KinPulseScreenRead,
  type KinPulseSubscribeInput,
  kinPulseApply,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { subscribeDynamic } from "../rpc/index.ts";
import { resubscribeWhenKinReturns, retryWhileKinUnavailable } from "./kinStreams.ts";

export const KIN_PULSE_LIVE_LABEL = "kin:pulse:live";

/**
 * Needs attention as the host streams it (`kin.pulse.subscribe`): the page, then kept current
 * from what moved in it. A new session names the page held, so when nothing moved the host sends
 * no page again. Only for a host whose refreshes list `pulse` in `streams`.
 */
export function kinPulseLiveStream(input: KinPulseSubscribeInput) {
  return Stream.suspend(() => {
    let held: { readonly read: KinPulseScreenRead; readonly hash: string } | null = null;
    return resubscribeWhenKinReturns(
      retryWhileKinUnavailable(
        subscribeDynamic("kin.pulse.subscribe", () =>
          Effect.sync(() => (held === null ? input : { ...input, held: held.hash })),
        ),
      ),
      Stream.empty,
      Stream.empty,
    ).pipe(
      Stream.map((event): KinPulseScreenRead | null => {
        switch (event._tag) {
          case "snapshot":
            held = { read: event.read, hash: event.hash };
            return event.read;
          // The page held still stands; what shows it already has it.
          case "current":
            return null;
          case "changed":
            if (held === null) return null;
            held = { read: kinPulseApply(held.read, event), hash: event.hash };
            return held.read;
        }
      }),
      Stream.filter((read): read is KinPulseScreenRead => read !== null),
    );
  });
}
