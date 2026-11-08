import { createNativeStackScreen } from "@react-navigation/native-stack";

import { pageRoute } from "../layout/route-options";
import { KinChatScreen } from "./KinChatScreen";
import { KinChatsScreen } from "./KinChatsScreen";
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
    linking: "kin/:orgId/chats/:chatId",
    options: pageRoute({ duoMinimize: "onScrollUp" }),
  }),
};
