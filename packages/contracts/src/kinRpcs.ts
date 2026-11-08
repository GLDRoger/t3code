import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";
import {
  KinBudget,
  KinBudgetGetInput,
  KinBudgetSetInput,
  KinOrgGetInput,
  KinOrgPauseInput,
  KinOrgResumeInput,
  KinOrgState,
} from "./kinLead.ts";
import { KinChatError, KinChatRpcs, KIN_CHAT_RPC_SCOPES } from "./kinChat.ts";
import {
  EnvironmentAuthorizationError,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
} from "./auth.ts";

const KinError = Schema.Union([KinChatError, EnvironmentAuthorizationError]);
const KinBudgetRpcs = [
  Rpc.make("kin.budget.get", { payload: KinBudgetGetInput, success: KinBudget, error: KinError }),
  Rpc.make("kin.budget.set", { payload: KinBudgetSetInput, success: KinBudget, error: KinError }),
] as const;
// The stop switch: pause and resume are owner-only; any member of the org may read the state.
const KinOrgRpcs = [
  Rpc.make("kin.org.get", { payload: KinOrgGetInput, success: KinOrgState, error: KinError }),
  Rpc.make("kin.org.pause", { payload: KinOrgPauseInput, success: KinOrgState, error: KinError }),
  Rpc.make("kin.org.resume", {
    payload: KinOrgResumeInput,
    success: KinOrgState,
    error: KinError,
  }),
] as const;
export const KinRpcs = [...KinChatRpcs, ...KinBudgetRpcs, ...KinOrgRpcs] as const;
export const KIN_RPC_SCOPES = {
  ...KIN_CHAT_RPC_SCOPES,
  "kin.budget.get": AuthOrchestrationReadScope,
  "kin.budget.set": AuthSettingsWriteScope,
  "kin.org.get": AuthOrchestrationReadScope,
  // Stopping agent work is an orchestration operation, as force-stopping a thread is.
  "kin.org.pause": AuthOrchestrationOperateScope,
  "kin.org.resume": AuthOrchestrationOperateScope,
} as const;

export const KIN_RPC_AGGREGATES = {
  "kin.budget.get": "kin-budget",
  "kin.budget.set": "kin-budget",
  "kin.org.get": "kin-org",
  "kin.org.pause": "kin-org",
  "kin.org.resume": "kin-org",
  "kin.orgs.list": "kin-chat",
  "kin.chats.subscribe": "kin-chat",
  "kin.chats.createDirect": "kin-chat",
  "kin.chat.subscribe": "kin-chat",
  "kin.chat.history": "kin-chat",
  "kin.messages.send": "kin-chat",
  "kin.messages.markRead": "kin-chat",
  "kin.widgets.act": "kin-chat",
} as const;
