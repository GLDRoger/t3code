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
import { KinApprovalRpcs, KIN_APPROVAL_RPC_SCOPES } from "./kinApprovals.ts";
import { KinLevelRpcs, KIN_LEVEL_RPC_SCOPES } from "./kinLevels.ts";
import { KinChatError, KinChatRpcs, KIN_CHAT_RPC_SCOPES } from "./kinChat.ts";
import { KinPushRpcs, KIN_PUSH_RPC_SCOPES } from "./kinPush.ts";
import {
  KinGithubWebhookOrgInput,
  KinGithubWebhookSecretInput,
  KinGithubWebhookSetup,
  KinGithubWebhookSetupInput,
  KinOwnerTimeZone,
  KinOwnerTimeZoneGetInput,
} from "./kinTriggers.ts";
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
export const KinGithubWebhookRpcs = [
  Rpc.make("kin.webhooks.github.setup", {
    payload: KinGithubWebhookSetupInput,
    success: KinGithubWebhookSetup,
    error: KinError,
  }),
  Rpc.make("kin.webhooks.github.setSecret", {
    payload: KinGithubWebhookSecretInput,
    success: KinGithubWebhookSetup,
    error: KinError,
  }),
  Rpc.make("kin.webhooks.github.rotate", {
    payload: KinGithubWebhookOrgInput,
    success: KinGithubWebhookSetup,
    error: KinError,
  }),
  Rpc.make("kin.webhooks.github.remove", {
    payload: KinGithubWebhookOrgInput,
    success: Schema.Struct({}),
    error: KinError,
  }),
] as const;
// Owner only: the zone routines, deferrals and notices use. Unset reads as UTC.
const KinTimeZoneRpcs = [
  Rpc.make("kin.triggers.getTimeZone", {
    payload: KinOwnerTimeZoneGetInput,
    success: KinOwnerTimeZone,
    error: KinError,
  }),
  Rpc.make("kin.triggers.setTimeZone", {
    payload: KinOwnerTimeZone,
    success: KinOwnerTimeZone,
    error: KinError,
  }),
] as const;
export const KinChatAndBudgetRpcs = [
  ...KinChatRpcs,
  ...KinBudgetRpcs,
  ...KinOrgRpcs,
  ...KinTimeZoneRpcs,
] as const;
export const KinRpcs = [
  ...KinChatAndBudgetRpcs,
  ...KinApprovalRpcs,
  ...KinLevelRpcs,
  ...KinGithubWebhookRpcs,
  ...KinPushRpcs,
] as const;
export const KIN_RPC_SCOPES = {
  ...KIN_CHAT_RPC_SCOPES,
  ...KIN_APPROVAL_RPC_SCOPES,
  ...KIN_LEVEL_RPC_SCOPES,
  ...KIN_PUSH_RPC_SCOPES,
  "kin.budget.get": AuthOrchestrationReadScope,
  "kin.budget.set": AuthSettingsWriteScope,
  "kin.org.get": AuthOrchestrationReadScope,
  // Stopping agent work is an orchestration operation, as force-stopping a thread is.
  "kin.org.pause": AuthOrchestrationOperateScope,
  "kin.org.resume": AuthOrchestrationOperateScope,
  "kin.triggers.getTimeZone": AuthOrchestrationReadScope,
  "kin.triggers.setTimeZone": AuthSettingsWriteScope,
  "kin.webhooks.github.setup": AuthSettingsWriteScope,
  "kin.webhooks.github.setSecret": AuthSettingsWriteScope,
  "kin.webhooks.github.rotate": AuthSettingsWriteScope,
  "kin.webhooks.github.remove": AuthSettingsWriteScope,
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
  "kin.levels.get": "kin-levels",
  "kin.levels.review": "kin-levels",
  "kin.levels.lower": "kin-levels",
  "kin.levels.raise": "kin-levels",
  "kin.levels.deferPromotion": "kin-levels",
  "kin.levels.shadowMemory": "kin-levels",
  "kin.push.registerDevice": "kin-push",
  "kin.push.unregisterDevice": "kin-push",
  "kin.push.watch": "kin-push",
  "kin.triggers.getTimeZone": "kin-triggers",
  "kin.triggers.setTimeZone": "kin-triggers",
  "kin.webhooks.github.setup": "kin-webhooks",
  "kin.webhooks.github.setSecret": "kin-webhooks",
  "kin.webhooks.github.rotate": "kin-webhooks",
  "kin.webhooks.github.remove": "kin-webhooks",
} as const;
