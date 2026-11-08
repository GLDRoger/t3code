import { KinApprovalRpcs, KIN_APPROVAL_RPC_SCOPES } from "./kinApprovals.ts";
import { KinChatRpcs, KIN_CHAT_RPC_SCOPES } from "./kinChat.ts";

export const KinRpcs = [...KinChatRpcs, ...KinApprovalRpcs] as const;
export const KIN_RPC_SCOPES = { ...KIN_CHAT_RPC_SCOPES, ...KIN_APPROVAL_RPC_SCOPES } as const;

export const KIN_RPC_AGGREGATES = {
  "kin.orgs.list": "kin-chat",
  "kin.chats.subscribe": "kin-chat",
  "kin.chats.createDirect": "kin-chat",
  "kin.chat.subscribe": "kin-chat",
  "kin.chat.history": "kin-chat",
  "kin.messages.send": "kin-chat",
  "kin.messages.markRead": "kin-chat",
  "kin.widgets.act": "kin-chat",
  "kin.approvals.list": "kin-approvals",
  "kin.approvals.get": "kin-approvals",
  "kin.approvals.challenge": "kin-approvals",
  "kin.approvals.submitGrant": "kin-approvals",
  "kin.approvals.reject": "kin-approvals",
  "kin.approvals.keyChallenge": "kin-approvals",
  "kin.approvals.registerKey": "kin-approvals",
  "kin.approvals.confirmKey": "kin-approvals",
  "kin.approvals.listKeys": "kin-approvals",
  "kin.approvals.revokeKey": "kin-approvals",
  "kin.audit.list": "kin-approvals",
  "kin.audit.verify": "kin-approvals",
} as const;
