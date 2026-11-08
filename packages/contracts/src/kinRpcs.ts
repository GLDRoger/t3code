import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";
import { KinBudget, KinBudgetGetInput, KinBudgetSetInput } from "./kinLead.ts";
import { KinChatError, KinChatRpcs, KIN_CHAT_RPC_SCOPES } from "./kinChat.ts";
import {
  EnvironmentAuthorizationError,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
} from "./auth.ts";

const KinBudgetRpcs = [
  Rpc.make("kin.budget.get", {
    payload: KinBudgetGetInput,
    success: KinBudget,
    error: Schema.Union([KinChatError, EnvironmentAuthorizationError]),
  }),
  Rpc.make("kin.budget.set", {
    payload: KinBudgetSetInput,
    success: KinBudget,
    error: Schema.Union([KinChatError, EnvironmentAuthorizationError]),
  }),
] as const;
export const KinChatAndBudgetRpcs = [...KinChatRpcs, ...KinBudgetRpcs] as const;
export const KinRpcs = [...KinChatAndBudgetRpcs] as const;
export const KIN_RPC_SCOPES = {
  ...KIN_CHAT_RPC_SCOPES,
  "kin.budget.get": AuthOrchestrationReadScope,
  "kin.budget.set": AuthSettingsWriteScope,
} as const;

export const KIN_RPC_AGGREGATES = {
  "kin.budget.get": "kin-budget",
  "kin.budget.set": "kin-budget",
  "kin.orgs.list": "kin-chat",
  "kin.chats.subscribe": "kin-chat",
  "kin.chats.createDirect": "kin-chat",
  "kin.chat.subscribe": "kin-chat",
  "kin.chat.history": "kin-chat",
  "kin.messages.send": "kin-chat",
  "kin.messages.markRead": "kin-chat",
  "kin.widgets.act": "kin-chat",
} as const;
