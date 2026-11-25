import { makeKinMoneyAnswersHooks } from "@t3tools/client-runtime/kin/react/kinMoneyAnswersHooks";

import { kinHookApp } from "./kinHookApp";
import { useKinMoneyLive } from "./useKinMoneyLive";

export const {
  useKinCash,
  useKinOutlook,
  useKinBudgets,
  useKinBudgetSet,
  useKinEntryLines,
  useKinInvoiceFromQuote,
  useKinNewInvoice,
  useKinNewExpense,
  useKinMatchPartner,
} = makeKinMoneyAnswersHooks(kinHookApp, { useKinMoneyLive });
