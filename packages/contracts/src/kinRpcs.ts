import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";
import { KinBudget, KinBudgetGetInput, KinBudgetSetInput } from "./kinLead.ts";
import { KinApprovalRpcs, KIN_APPROVAL_RPC_SCOPES } from "./kinApprovals.ts";
import { KinChatError, KinChatRpcs, KIN_CHAT_RPC_SCOPES } from "./kinChat.ts";
import {
  KinGithubWebhookOrgInput,
  KinGithubWebhookSecretInput,
  KinGithubWebhookSetup,
  KinGithubWebhookSetupInput,
} from "./kinTriggers.ts";
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
const kinError = Schema.Union([KinChatError, EnvironmentAuthorizationError]);
export const KinGithubWebhookRpcs = [
  Rpc.make("kin.webhooks.github.setup", {
    payload: KinGithubWebhookSetupInput,
    success: KinGithubWebhookSetup,
    error: kinError,
  }),
  Rpc.make("kin.webhooks.github.setSecret", {
    payload: KinGithubWebhookSecretInput,
    success: KinGithubWebhookSetup,
    error: kinError,
  }),
  Rpc.make("kin.webhooks.github.rotate", {
    payload: KinGithubWebhookOrgInput,
    success: KinGithubWebhookSetup,
    error: kinError,
  }),
  Rpc.make("kin.webhooks.github.remove", {
    payload: KinGithubWebhookOrgInput,
    success: Schema.Struct({}),
    error: kinError,
  }),
] as const;
export const KinChatAndBudgetRpcs = [...KinChatRpcs, ...KinBudgetRpcs] as const;
export const KinRpcs = [
  ...KinChatAndBudgetRpcs,
  ...KinApprovalRpcs,
  ...KinGithubWebhookRpcs,
] as const;
export const KIN_RPC_SCOPES = {
  ...KIN_CHAT_RPC_SCOPES,
  ...KIN_APPROVAL_RPC_SCOPES,
  "kin.budget.get": AuthOrchestrationReadScope,
  "kin.budget.set": AuthSettingsWriteScope,
  "kin.webhooks.github.setup": AuthSettingsWriteScope,
  "kin.webhooks.github.setSecret": AuthSettingsWriteScope,
  "kin.webhooks.github.rotate": AuthSettingsWriteScope,
  "kin.webhooks.github.remove": AuthSettingsWriteScope,
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
  "kin.webhooks.github.setup": "kin-webhooks",
  "kin.webhooks.github.setSecret": "kin-webhooks",
  "kin.webhooks.github.rotate": "kin-webhooks",
  "kin.webhooks.github.remove": "kin-webhooks",
} as const;
