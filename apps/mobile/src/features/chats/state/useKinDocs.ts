import { makeKinDocsHooks } from "@t3tools/client-runtime/kin/react/kinDocsHooks";

import { kinHookApp } from "./kinHookApp";
import { useKinOpenChat } from "./useKinOpenChat";
import { useKinPagedList } from "./useKinWork";

export const {
  useKinDocsLive,
  useKinDocsList,
  useKinDocsUnder,
  useKinWhatWeSell,
  useKinWhatWeSellStart,
  useKinDoc,
  useKinDocHistory,
  useKinSearch,
} = makeKinDocsHooks(kinHookApp, { useKinOpenChat, useKinPagedList });
