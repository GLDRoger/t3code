import { makeKinBillsHooks } from "@t3tools/client-runtime/kin/react/kinBillsHooks";

import { kinHookApp } from "./kinHookApp";

export const {
  useKinBillBatches,
  useKinBillBatch,
  useKinBillActions,
  useKinBillFix,
  useKinBillsAdd,
} = makeKinBillsHooks(kinHookApp);
