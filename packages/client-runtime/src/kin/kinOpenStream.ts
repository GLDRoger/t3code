import { type KinOpenSubscribeInput, kinOpenApply } from "@t3tools/contracts";

import { subscribeDynamic } from "../rpc/index.ts";
import { kinHashedLive } from "./kinHashedLive.ts";

export const KIN_OPEN_LIVE_LABEL = "kin:open:live";

/**
 * Everything open for the viewer as the host streams it (`kin.open.subscribe`): the list, then kept
 * current from what moved in it. Only for a host whose refreshes list `open` in `streams`.
 */
export const kinOpenLiveStream = (input: KinOpenSubscribeInput) =>
  kinHashedLive(input, (held) => subscribeDynamic("kin.open.subscribe", held), {
    snapshot: (event) => event.read,
    apply: (held, event) => kinOpenApply(held, event),
  });
