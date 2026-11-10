import { createNativeStackScreen } from "@react-navigation/native-stack";

import { pageRoute, sheetRoute } from "../layout/route-options";
import { KinApprovalsScreen } from "./approvals/KinApprovalsScreen";
import { KinChatScreen } from "./KinChatScreen";
import { KinChatsScreen } from "./KinChatsScreen";
import { KinGroupFormScreen } from "./KinGroupFormScreen";
import { KinGroupScreen } from "./KinGroupScreen";
import { KinLeadFormScreen } from "./KinLeadFormScreen";
import { KinLeadScreen } from "./KinLeadScreen";
import { KinWaitingScreen } from "./KinWaitingScreen";

/** Kin's root-stack routes, spread into `Stack.tsx`. Kin files must never import `Stack.tsx`. */
export const KIN_SCREENS = {
  KinChats: createNativeStackScreen({
    screen: KinChatsScreen,
    linking: "kin",
    options: pageRoute({ title: "Kin" }),
  }),
  KinWaiting: createNativeStackScreen({
    screen: KinWaitingScreen,
    linking: "kin/waiting",
    options: pageRoute({ title: "Waiting on you" }),
  }),
  KinChat: createNativeStackScreen({
    screen: KinChatScreen,
    // Every Kin host uses the same org id, so the environment names the chat's host.
    linking: "kin/:environmentId/:orgId/chats/:chatId",
    options: pageRoute({ duoMinimize: "onScrollUp" }),
  }),
  KinLead: createNativeStackScreen({
    screen: KinLeadScreen,
    linking: "kin/:environmentId/:orgId/leads/:agentId",
    options: sheetRoute({ detent: 0.75 }),
  }),
  // A full sheet, so the keyboard never covers the field being typed in.
  KinLeadForm: createNativeStackScreen({
    screen: KinLeadFormScreen,
    options: sheetRoute({ detent: "full", android: "fullScreen" }),
  }),
  KinGroup: createNativeStackScreen({
    screen: KinGroupScreen,
    linking: "kin/:environmentId/:orgId/groups/:chatId",
    options: sheetRoute({ detent: 0.75 }),
  }),
  KinGroupForm: createNativeStackScreen({
    screen: KinGroupFormScreen,
    options: sheetRoute({ detent: "full", android: "fullScreen" }),
  }),
  KinApprovals: createNativeStackScreen({
    screen: KinApprovalsScreen,
    linking: "kin/:environmentId/:orgId/approvals",
    options: pageRoute({ title: "Approvals" }),
  }),
};
