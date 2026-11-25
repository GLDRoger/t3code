import type { KinScreenTarget as KinWorkTarget } from "@t3tools/client-runtime/kin/kinScreenReads";
import { makeKinWorkHooks } from "@t3tools/client-runtime/kin/react/kinWorkHooks";
import { AsyncResult } from "effect/reactivity";

import { environmentCatalog } from "../../../connection/catalog";
import { appAtomRegistry } from "../../../state/atom-registry";
import { retryKinWorkLive } from "./kinClient";
import { kinHookApp } from "./kinHookApp";
import { useKinHostAt } from "./useKinHost";

export type { KinScreenTarget as KinWorkTarget } from "@t3tools/client-runtime/kin/kinScreenReads";
export {
  kinSchedule,
  type KinWorkChoices,
  type KinWorkDirectory,
} from "@t3tools/client-runtime/kin/react/kinWorkHooks";

export const {
  kinWorkLiveAtom,
  useKinWork,
  useKinReinvited,
  useKinWorkDirectory,
  useKinWorkItemWatch,
  useKinWorkPlace,
  useKinPagedList,
  useKinClientsList,
  useKinProjectsList,
  useKinWorkHistory,
  useKinClientPage,
  useKinProjectPage,
  kinWorkChoicesAtom,
  useKinWorkChoices,
  useKinPickerSearch,
  useKinWorkForm,
  useKinWorkZone,
  kinWorkAnswersOf,
  useKinWorkAnswer,
  useKinWorkChanges,
} = makeKinWorkHooks(kinHookApp, {
  useKinHostAt,
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  keepAnswers: true,
});

/**
 * Reads Work's counts again inside the running stream, keeping what is on screen. A stream that
 * already ended with an error has nothing to retry in, so it starts over.
 */
export const refreshKinWorkLive = (target: KinWorkTarget) => {
  const live = kinWorkLiveAtom(target);
  if (AsyncResult.isFailure(appAtomRegistry.get(live))) appAtomRegistry.refresh(live);
  else retryKinWorkLive(target.environmentId, target.orgId);
};
