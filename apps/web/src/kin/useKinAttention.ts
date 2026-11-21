import { makeKinAttentionHooks } from "@t3tools/client-runtime/kin/react/kinAttentionHooks";

import { kinHookApp } from "./kinHookApp";
import { useKinMoneyLive } from "./useKinMoneyLive";
import { useKinOpenChat } from "./useKinOpenChat";
import { kinWorkLiveAtom } from "./useKinWork";

export const {
  useKinAttention,
  useKinTasksNeedsYou,
  useKinAttentionHandle,
  useKinAskAbout,
  useKinGoals,
} = makeKinAttentionHooks(kinHookApp, { useKinOpenChat, useKinMoneyLive, kinWorkLiveAtom });
