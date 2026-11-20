import { makeKinMoneyHooks } from "@t3tools/client-runtime/kin/react/kinMoneyHooks";

import { useNowMinuteMs } from "../../../lib/clock";
import { kinHookApp } from "./kinHookApp";
import { useKinMoneyLive } from "./useKinMoneyLive";
import { useKinOpenChat } from "./useKinOpenChat";
import { kinWorkChoicesAtom, kinWorkLiveAtom } from "./useKinWork";

export { kinListsOf } from "@t3tools/client-runtime/kin/react/kinMoneyHooks";

export const {
  useKinLists,
  useKinMoneySummary,
  useKinListContext,
  useKinListEntries,
  useKinDates,
  useKinEntryChanges,
  useKinWorkFiles,
  useKinListChanges,
  useKinAskAgent,
  useKinCompanyProfile,
  useKinRates,
  useKinHomeCurrency,
  useKinCountryNeeded,
  useKinCompanyCountry,
  useKinReceipts,
  useKinRecipes,
  useKinMoneyActions,
} = makeKinMoneyHooks(kinHookApp, {
  useNowMinuteMs,
  useKinOpenChat,
  useKinMoneyLive,
  kinWorkLiveAtom,
  kinWorkChoicesAtom,
});
