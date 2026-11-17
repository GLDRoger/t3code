import { type KinPulseSubscribeInput, kinPulseApply } from "@t3tools/contracts";

import { subscribeDynamic } from "../rpc/index.ts";
import { kinHashedLive } from "./kinHashedLive.ts";

export const KIN_PULSE_LIVE_LABEL = "kin:pulse:live";

/**
 * Needs attention as the host streams it (`kin.pulse.subscribe`): the page, then kept current from
 * what moved in it. Only for a host whose refreshes list `pulse` in `streams`.
 */
export const kinPulseLiveStream = (input: KinPulseSubscribeInput) =>
  kinHashedLive(input, (held) => subscribeDynamic("kin.pulse.subscribe", held), {
    snapshot: (event) => event.read,
    apply: (held, event) => kinPulseApply(held, event),
  });
