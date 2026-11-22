import { makeKinDealsHooks } from "@t3tools/client-runtime/kin/react/kinDealsHooks";

import { kinHookApp } from "./kinHookApp";

export const {
  useKinDeals,
  useKinDealPage,
  useKinDealStages,
  useKinDealSend,
  useKinDealQuietDaysSet,
  useKinDealStagesSet,
} = makeKinDealsHooks(kinHookApp);
