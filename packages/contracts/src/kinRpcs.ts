import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";
import {
  KinBudget,
  KinBudgetGetInput,
  KinBudgetSetInput,
  KinLeadAccessChangeInput,
  KinLeadAccessInput,
  KinLeadAccessResult,
  KinLeadCreated,
  KinLeadCreateInput,
  KinLeadProfile,
  KinLeadRetireInput,
  KinLeadsListInput,
  KinLeadsListResult,
  KinLeadUpdateInput,
  KinOrgGetInput,
  KinOrgPauseInput,
  KinOrgResumeInput,
  KinOrgState,
} from "./kinLead.ts";
import { KinApprovalRpcs, KIN_APPROVAL_RPC_SCOPES } from "./kinApprovals.ts";
import { KinLevelRpcs, KIN_LEVEL_RPC_SCOPES } from "./kinLevels.ts";
import { KinMemoryRpcs, KIN_MEMORY_RPC_SCOPES } from "./kinMemory.ts";
import { KinWorkRpcs, KIN_WORK_RPC_SCOPES } from "./kinWork.ts";
import { KinDocsRpcs, KIN_DOCS_RPC_SCOPES } from "./kinDocs.ts";
import { KinFinanceRpcs, KIN_FINANCE_RPC_SCOPES } from "./kinFinance.ts";
import { KinStatementRpcs, KIN_STATEMENT_RPC_SCOPES } from "./kinStatements.ts";
import {
  KinChatError,
  KinChatRpcs,
  KinGroupRpcs,
  KinLeadInterruptInput,
  KinLeadInterruptResult,
  KIN_CHAT_RPC_SCOPES,
} from "./kinChat.ts";
import { KinPushRpcs, KIN_PUSH_RPC_SCOPES } from "./kinPush.ts";
import { KinPeopleRpcs, KIN_PEOPLE_RPC_SCOPES } from "./kinPeople.ts";
import { KinVisualRpcs, KIN_VISUAL_RPC_SCOPES } from "./kinVisual.ts";
import { KinWorkerNetworkRpcs, KIN_WORKER_NETWORK_RPC_SCOPES } from "./kinWorkerNetwork.ts";
import {
  KinGithubWebhookOrgInput,
  KinGithubWebhookSecretInput,
  KinGithubWebhookSetup,
  KinGithubWebhookSetupInput,
  KinGithubWebhookStatus,
  KinOwnerTimeZone,
  KinOwnerTimeZoneGetInput,
} from "./kinTriggers.ts";
import {
  EnvironmentAuthorizationError,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  AuthKinChatScope,
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
// Owner-only, but for list: a person's own live leads and the leads of others they may message.
// interrupt stops one wake-up, never the org; create adds a lead at L0 with its creator's chat.
// access is who else may message a lead.
const KinLeadRpcs = [
  Rpc.make("kin.lead.access.list", {
    payload: KinLeadAccessInput,
    success: KinLeadAccessResult,
    error: KinError,
  }),
  Rpc.make("kin.lead.access.grant", {
    payload: KinLeadAccessChangeInput,
    success: KinLeadAccessResult,
    error: KinError,
  }),
  Rpc.make("kin.lead.access.revoke", {
    payload: KinLeadAccessChangeInput,
    success: KinLeadAccessResult,
    error: KinError,
  }),
  Rpc.make("kin.leads.list", {
    payload: KinLeadsListInput,
    success: KinLeadsListResult,
    error: KinError,
  }),
  Rpc.make("kin.lead.update", {
    payload: KinLeadUpdateInput,
    success: KinLeadProfile,
    error: KinError,
  }),
  // Retire keeps everything the agent has said and done; restore brings it back.
  Rpc.make("kin.lead.retire", {
    payload: KinLeadRetireInput,
    success: KinLeadProfile,
    error: KinError,
  }),
  Rpc.make("kin.lead.restore", {
    payload: KinLeadRetireInput,
    success: KinLeadProfile,
    error: KinError,
  }),
  Rpc.make("kin.lead.interrupt", {
    payload: KinLeadInterruptInput,
    success: KinLeadInterruptResult,
    error: KinError,
  }),
  Rpc.make("kin.lead.create", {
    payload: KinLeadCreateInput,
    success: KinLeadCreated,
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
  Rpc.make("kin.webhooks.github.status", {
    payload: KinGithubWebhookOrgInput,
    success: KinGithubWebhookStatus,
    error: KinError,
  }),
] as const;
// The zone routines, deferrals, notices and due times use: any member reads it, the owner sets it.
// Unset reads as UTC.
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
  ...KinGroupRpcs,
  ...KinBudgetRpcs,
  ...KinOrgRpcs,
  ...KinLeadRpcs,
  ...KinTimeZoneRpcs,
  ...KinVisualRpcs,
] as const;
export const KinRpcs = [
  ...KinChatAndBudgetRpcs,
  ...KinApprovalRpcs,
  ...KinLevelRpcs,
  ...KinMemoryRpcs,
  ...KinWorkRpcs,
  ...KinDocsRpcs,
  ...KinFinanceRpcs,
  ...KinStatementRpcs,
  ...KinGithubWebhookRpcs,
  ...KinPushRpcs,
  ...KinPeopleRpcs,
  ...KinWorkerNetworkRpcs,
] as const;
export const KIN_RPC_SCOPES = {
  ...KIN_CHAT_RPC_SCOPES,
  ...KIN_APPROVAL_RPC_SCOPES,
  ...KIN_LEVEL_RPC_SCOPES,
  ...KIN_MEMORY_RPC_SCOPES,
  ...KIN_WORK_RPC_SCOPES,
  ...KIN_DOCS_RPC_SCOPES,
  ...KIN_FINANCE_RPC_SCOPES,
  ...KIN_STATEMENT_RPC_SCOPES,
  ...KIN_PUSH_RPC_SCOPES,
  ...KIN_PEOPLE_RPC_SCOPES,
  ...KIN_VISUAL_RPC_SCOPES,
  ...KIN_WORKER_NETWORK_RPC_SCOPES,
  "kin.budget.get": AuthOrchestrationReadScope,
  "kin.budget.set": AuthSettingsWriteScope,
  // A teammate's app shows that Kin is stopped; the server drops the owner's reason for them.
  "kin.org.get": AuthKinChatScope,
  // Stopping agent work is an orchestration operation, as force-stopping a thread is.
  "kin.org.pause": AuthOrchestrationOperateScope,
  "kin.org.resume": AuthOrchestrationOperateScope,
  "kin.lead.interrupt": AuthOrchestrationOperateScope,
  // A new lead is an owner setting, like the budget, and spends from the same budget.
  "kin.lead.create": AuthSettingsWriteScope,
  // Part of the chat list: a person sees their own leads and the ones they may message.
  "kin.leads.list": AuthKinChatScope,
  // Who may message a lead decides who spends its owner's budget: an owner setting.
  "kin.lead.access.list": AuthSettingsWriteScope,
  "kin.lead.access.grant": AuthSettingsWriteScope,
  "kin.lead.access.revoke": AuthSettingsWriteScope,
  // What a lead is for is an owner setting, as creating it is.
  "kin.lead.update": AuthSettingsWriteScope,
  // Retiring stops an agent's work and restoring starts it again: owner settings, as create is.
  "kin.lead.retire": AuthSettingsWriteScope,
  "kin.lead.restore": AuthSettingsWriteScope,
  // Who is in a group decides who its leads listen to: an owner setting, never a teammate's.
  "kin.groups.create": AuthSettingsWriteScope,
  "kin.groups.addMember": AuthSettingsWriteScope,
  "kin.groups.removeMember": AuthSettingsWriteScope,
  "kin.groups.setLead": AuthSettingsWriteScope,
  "kin.groups.rename": AuthSettingsWriteScope,
  "kin.groups.delete": AuthSettingsWriteScope,
  "kin.triggers.getTimeZone": AuthKinChatScope,
  "kin.triggers.setTimeZone": AuthSettingsWriteScope,
  "kin.webhooks.github.setup": AuthSettingsWriteScope,
  "kin.webhooks.github.setSecret": AuthSettingsWriteScope,
  "kin.webhooks.github.rotate": AuthSettingsWriteScope,
  "kin.webhooks.github.remove": AuthSettingsWriteScope,
  // Owner only like the rest: the URL carries the hook's token.
  "kin.webhooks.github.status": AuthSettingsWriteScope,
} as const;

export const KIN_RPC_AGGREGATES = {
  "kin.people.listInvites": "kin-people",
  "kin.people.revokeInvite": "kin-people",
  "kin.people.list": "kin-people",
  "kin.people.createInvite": "kin-people",
  "kin.people.listDevices": "kin-people",
  "kin.people.revokeDevice": "kin-people",
  "kin.people.removeAccess": "kin-people",
  "kin.people.setGithubLogin": "kin-people",

  "kin.budget.get": "kin-budget",
  "kin.budget.set": "kin-budget",
  "kin.org.get": "kin-org",
  "kin.org.pause": "kin-org",
  "kin.org.resume": "kin-org",
  "kin.lead.interrupt": "kin-org",
  "kin.lead.create": "kin-chat",
  "kin.leads.list": "kin-chat",
  "kin.lead.update": "kin-chat",
  "kin.lead.retire": "kin-chat",
  "kin.lead.restore": "kin-chat",
  "kin.lead.access.list": "kin-chat",
  "kin.lead.access.grant": "kin-chat",
  "kin.lead.access.revoke": "kin-chat",
  "kin.orgs.list": "kin-chat",
  "kin.chats.subscribe": "kin-chat",
  "kin.chats.createDirect": "kin-chat",
  "kin.chats.mute": "kin-chat",
  "kin.chats.clear": "kin-chat",
  "kin.chat.members": "kin-chat",
  "kin.groups.create": "kin-chat",
  "kin.groups.addMember": "kin-chat",
  "kin.groups.removeMember": "kin-chat",
  "kin.groups.setLead": "kin-chat",
  "kin.groups.rename": "kin-chat",
  "kin.groups.delete": "kin-chat",
  "kin.chat.subscribe": "kin-chat",
  "kin.chat.history": "kin-chat",
  "kin.messages.send": "kin-chat",
  "kin.messages.markRead": "kin-chat",
  "kin.widgets.act": "kin-chat",
  "kin.messages.react": "kin-chat",
  "kin.approvals.list": "kin-approvals",
  "kin.approvals.get": "kin-approvals",
  "kin.approvals.challenge": "kin-approvals",
  "kin.approvals.submitGrant": "kin-approvals",
  "kin.approvals.reject": "kin-approvals",
  "kin.approvals.keyChallenge": "kin-approvals",
  "kin.approvals.registerKey": "kin-approvals",
  "kin.approvals.listKeys": "kin-approvals",
  "kin.approvals.revokeKey": "kin-approvals",
  "kin.audit.list": "kin-approvals",
  "kin.audit.verify": "kin-approvals",
  "kin.levels.get": "kin-levels",
  "kin.levels.lower": "kin-levels",
  "kin.levels.raise": "kin-levels",
  "kin.memory.undo": "kin-memory",
  "kin.memory.list": "kin-memory",
  "kin.memory.setVisibility": "kin-memory",
  "kin.memory.confirmSuggestions": "kin-memory",
  "kin.memory.forget": "kin-memory",
  "kin.docs.list": "kin-docs",
  "kin.docs.get": "kin-docs",
  "kin.docs.history": "kin-docs",
  "kin.docs.diff": "kin-docs",
  "kin.docs.restore": "kin-docs",
  "kin.docs.subscribe": "kin-docs",
  "kin.search": "kin-docs",
  "kin.docs.recipes": "kin-docs",
  "kin.docs.render": "kin-docs",
  "kin.docs.undoRecipe": "kin-docs",
  "kin.docs.label": "kin-docs",
  "kin.docs.clearRecipeLabel": "kin-docs",
  "kin.work.summary": "kin-work",
  "kin.work.list": "kin-work",
  "kin.work.get": "kin-work",
  "kin.work.subscribe": "kin-work",
  "kin.work.create": "kin-work",
  "kin.work.assign": "kin-work",
  "kin.work.update": "kin-work",
  "kin.work.confirm": "kin-work",
  "kin.work.decline": "kin-work",
  "kin.work.parties": "kin-work",
  "kin.work.party": "kin-work",
  "kin.work.projects": "kin-work",
  "kin.work.project": "kin-work",
  "kin.work.history": "kin-work",
  "kin.work.createParty": "kin-work",
  "kin.work.updateParty": "kin-work",
  "kin.work.createContact": "kin-work",
  "kin.work.updateContact": "kin-work",
  "kin.work.createProject": "kin-work",
  "kin.work.updateProject": "kin-work",
  "kin.work.lists": "kin-work",
  "kin.work.updateList": "kin-work",
  "kin.work.dates": "kin-work",
  "kin.work.money": "kin-work",
  "kin.work.recordPayment": "kin-work",
  "kin.work.voidPayment": "kin-work",
  "kin.work.files": "kin-work",
  "kin.work.companyProfile": "kin-work",
  "kin.work.setCompanyProfile": "kin-work",
  "kin.work.issue": "kin-work",
  "kin.work.void": "kin-work",
  "kin.work.receipts": "kin-work",
  "kin.work.makeReceipt": "kin-work",
  "kin.work.statementUnlock": "kin-work",
  "kin.work.statementForgetPassword": "kin-work",
  "kin.work.statementApply": "kin-work",
  "kin.work.statementUndo": "kin-work",
  "kin.work.statementSelect": "kin-work",
  "kin.work.statementRows": "kin-work",
  "kin.work.statementPasswords": "kin-work",
  "kin.work.statementForgetAccount": "kin-work",
  "kin.push.registerDevice": "kin-push",
  "kin.push.unregisterDevice": "kin-push",
  "kin.push.watch": "kin-push",
  "kin.visuals.hosts.list": "kin-chat",
  "kin.visuals.hosts.allow": "kin-chat",
  "kin.visuals.hosts.remove": "kin-chat",
  "kin.triggers.getTimeZone": "kin-triggers",
  "kin.triggers.setTimeZone": "kin-triggers",
  "kin.webhooks.github.setup": "kin-webhooks",
  "kin.webhooks.github.setSecret": "kin-webhooks",
  "kin.webhooks.github.rotate": "kin-webhooks",
  "kin.webhooks.github.remove": "kin-webhooks",
  "kin.webhooks.github.status": "kin-webhooks",
  "kin.workers.network.get": "kin-workers",
  "kin.workers.network.allow": "kin-workers",
  "kin.workers.network.remove": "kin-workers",
} as const;
