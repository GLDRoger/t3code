import { useAtomValue } from "@effect/atom-react";
import { kinAccessKnownAtom } from "@t3tools/client-runtime/kin/kinAccess";
import { kinDealsStartFilter, type KinDealsFilter } from "@t3tools/client-runtime/kin/kinDeals";
import { makeKinDealsHooks } from "@t3tools/client-runtime/kin/react/kinDealsHooks";
import type { EnvironmentId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../../../connection/runtime";
import { kinHookApp } from "./kinHookApp";

export const {
  useKinDeals,
  useKinDealPage,
  useKinDealStages,
  useKinDealSend,
  useKinDealQuietDaysSet,
  useKinDealStagesSet,
} = makeKinDealsHooks(kinHookApp);

/** Where the Deals tab starts; null until the host says whether the viewer is owner level. */
export function useKinDealsStart(environmentId: EnvironmentId): KinDealsFilter | null {
  return kinDealsStartFilter(
    useAtomValue(kinAccessKnownAtom(connectionAtomRuntime, environmentId)),
  );
}
