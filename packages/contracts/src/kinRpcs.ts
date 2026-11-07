import { KinChatRpcs, KIN_CHAT_RPC_SCOPES } from "./kinChat.ts";

export const KinRpcs = [...KinChatRpcs] as const;
export const KIN_RPC_SCOPES = { ...KIN_CHAT_RPC_SCOPES } as const;

export const KIN_RPC_AGGREGATES = {
  "kin.orgs.list": "kin-chat",
  "kin.chats.subscribe": "kin-chat",
  "kin.chats.createDirect": "kin-chat",
  "kin.chat.subscribe": "kin-chat",
  "kin.chat.history": "kin-chat",
  "kin.messages.send": "kin-chat",
  "kin.messages.markRead": "kin-chat",
  "kin.widgets.act": "kin-chat",
} as const;
