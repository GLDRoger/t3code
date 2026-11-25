import { makeKinWorkHooks } from "@t3tools/client-runtime/kin/react/kinWorkHooks";

import { environmentCatalog } from "../connection/catalog";
import { kinHookApp } from "./kinHookApp";
import { useKinHostAt } from "./useKinHost";

export type { KinScreenTarget as KinWorkTarget } from "@t3tools/client-runtime/kin/kinScreenReads";
export {
  kinSchedule,
  type KinWorkChangesHandle,
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
  useKinWorkChanges,
} = makeKinWorkHooks(kinHookApp, {
  useKinHostAt,
  catalogValueAtom: environmentCatalog.catalogValueAtom,
});
