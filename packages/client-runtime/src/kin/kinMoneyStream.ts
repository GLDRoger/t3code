import { type KinMoneyLive, type KinMoneySubscribeInput, kinMoneyApply } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { subscribeDynamic } from "../rpc/index.ts";
import { resubscribeWhenKinReturns, retryWhileKinUnavailable } from "./kinStreams.ts";

export const KIN_MONEY_LIVE_LABEL = "kin:money:live";

/** The summary, which every Money line shows; Money's own screen adds the rest (`page`). */
export const KIN_MONEY_SUMMARY = ["summary"] as const;
export const KIN_MONEY_PAGE = ["cash", "outlook", "budgets", "receipts", "goals", "lists"] as const;

/**
 * Money as the host streams it (`kin.money.subscribe`): the parts asked for, then kept current from
 * what moved. A new session names what is held, so when nothing moved the host sends nothing
 * again. Only for the owner level, on a host whose refreshes list `money` in `streams`.
 */
export function kinMoneyLiveStream(input: KinMoneySubscribeInput) {
  return Stream.suspend(() => {
    let held: { readonly live: KinMoneyLive; readonly hash: string } | null = null;
    return resubscribeWhenKinReturns(
      retryWhileKinUnavailable(
        subscribeDynamic("kin.money.subscribe", () =>
          Effect.sync(() => (held === null ? input : { ...input, held: held.hash })),
        ),
      ),
      Stream.empty,
      Stream.empty,
    ).pipe(
      Stream.map((event): KinMoneyLive | null => {
        switch (event._tag) {
          case "snapshot":
            held = { live: event.live, hash: event.hash };
            return event.live;
          // What is held still stands; what shows it already has it.
          case "current":
            return null;
          case "changed":
            if (held === null) return null;
            held = { live: kinMoneyApply(held.live, event), hash: event.hash };
            return held.live;
        }
      }),
      Stream.filter((live): live is KinMoneyLive => live !== null),
    );
  });
}
