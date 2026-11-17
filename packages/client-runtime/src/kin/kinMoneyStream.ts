import { type KinMoneySubscribeInput, kinMoneyApply } from "@t3tools/contracts";

import { subscribeDynamic } from "../rpc/index.ts";
import { kinHashedLive } from "./kinHashedLive.ts";

export const KIN_MONEY_LIVE_LABEL = "kin:money:live";

/** The summary, which every Money line shows; Money's own screen adds the rest (`page`). */
export const KIN_MONEY_SUMMARY = ["summary"] as const;
export const KIN_MONEY_PAGE = ["cash", "outlook", "budgets", "receipts", "goals", "lists"] as const;

/**
 * Money as the host streams it (`kin.money.subscribe`): the parts asked for, then kept current from
 * what moved. Only for the owner level, on a host whose refreshes list `money` in `streams`.
 */
export const kinMoneyLiveStream = (input: KinMoneySubscribeInput) =>
  kinHashedLive(input, (held) => subscribeDynamic("kin.money.subscribe", held), {
    snapshot: (event) => event.live,
    apply: kinMoneyApply,
  });
