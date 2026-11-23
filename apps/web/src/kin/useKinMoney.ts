import { makeKinMoneyHooks } from "@t3tools/client-runtime/kin/react/kinMoneyHooks";

import { kinHookApp } from "./kinHookApp";
import { useNowMinuteMs } from "./useKinClock";
import { useKinMoneyLive } from "./useKinMoneyLive";
import { useKinOpenChat } from "./useKinOpenChat";
import { kinWorkChoicesAtom, kinWorkLiveAtom } from "./useKinWork";

export {
  kinListsOf,
  type KinListsHandle,
  type KinPreviewFile,
} from "@t3tools/client-runtime/kin/react/kinMoneyHooks";

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
