import { makeKinNumbersHooks } from "@t3tools/client-runtime/kin/react/kinNumbersHooks";

import { kinHookApp } from "./kinHookApp";

export const {
  useKinNumberToday,
  useKinNumberLocale,
  useKinNumbers,
  useKinNumbersShown,
  useKinNumberValues,
  useKinNumberDefinitions,
  useKinNumberRecord,
  useKinNumberSave,
  newNumberRequestId,
} = makeKinNumbersHooks(kinHookApp);
