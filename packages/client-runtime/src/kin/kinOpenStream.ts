import {
  KIN_PULSE_LATER_SENSES,
  type KinOpenSubscribeInput,
  kinOpenApply,
} from "@t3tools/contracts";

import { subscribeDynamic } from "../rpc/index.ts";
import { kinHashedLive } from "./kinHashedLive.ts";

export const KIN_OPEN_LIVE_LABEL = "kin:open:live";

/** Every sense this client draws; past a sense's cap is counted by Needs attention, not here. */
export const KIN_OPEN_SENSES = KIN_PULSE_LATER_SENSES.filter((sense) => sense !== "sense_overflow");

/**
 * What is open for the viewer as the host streams it (`kin.open.subscribe`): the list, then kept
 * current from what moved in it. Only for a host whose refreshes list `open` in `streams`.
 */
export const kinOpenLiveStream = (input: KinOpenSubscribeInput) =>
  kinHashedLive(input, (held) => subscribeDynamic("kin.open.subscribe", held), {
    snapshot: (event) => event.read,
    apply: (held, event) => kinOpenApply(held, event),
  });
