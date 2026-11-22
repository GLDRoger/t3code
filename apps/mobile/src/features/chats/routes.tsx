import { KIN_WAITING_TITLE } from "@t3tools/client-runtime/kin/kinInboxModel";
import { createNativeStackScreen } from "@react-navigation/native-stack";

import { pageRoute, sheetRoute } from "../layout/route-options";
import { KinApprovalsScreen } from "./approvals/KinApprovalsScreen";
import { KinAgentsScreen } from "./KinAgentsScreen";
import { KinAppearanceScreen } from "./KinAppearanceScreen";
import { KinChatScreen } from "./KinChatScreen";
import { KinChatsScreen } from "./KinChatsScreen";
import { KinClientScreen } from "./KinClientScreen";
import { KinCompanyScreen } from "./KinCompanyScreen";
import { KinWatchLogScreen } from "./KinWatchLogScreen";
import { KinDealEditScreen } from "./KinDealEditScreen";
import { KinDealNewScreen } from "./KinDealNewScreen";
import { KinDealScreen } from "./KinDealScreen";
import { KinDealsConcernScreen } from "./KinDealsConcernScreen";
import { KinDealStagesScreen } from "./KinDealsSettings";
import { KinImportScreen } from "./KinImportScreen";
import {
  KinConnectionAddScreen,
  KinConnectionEditScreen,
} from "./connections/KinConnectionFormScreens";
import { KinConnectionScreen } from "./connections/KinConnectionScreen";
import { KinConnectionsScreen } from "./connections/KinConnectionsScreen";
import { KinGitHubConnectScreen } from "./connections/KinGitHubConnect";
import { KinSocialConnectScreen, KinSocialLinkScreen } from "./connections/KinSocialConnect";
import { KinDocFileScreen } from "./KinDocFileScreen";
import { KinDocScreen } from "./KinDocScreen";
import { KinDocChangesScreen, KinDocHistoryScreen, KinSearchScreen } from "./KinDocVersionScreens";
import { KinGroupFormScreen } from "./KinGroupFormScreen";
import { KinPeoplePickScreen } from "./KinPeoplePickScreen";
import { KinGroupScreen } from "./KinGroupScreen";
import { KinLeadFormScreen } from "./KinLeadFormScreen";
import { KinListSettingsScreen, KinPaymentScreen } from "./KinListEntry";
import { KinEntryEditScreen } from "./KinListEntryEdit";
import { KinDatesScreen, KinListScreen } from "./KinListScreen";
import { KinLeadScreen } from "./KinLeadScreen";
import { KinMemoryScreen } from "./KinMemoryScreen";
import { KinRatesScreen } from "./KinMoneyEstimate";
import { KinSubscriptionsScreen } from "./KinSubscriptions";
import { KinMarketingListScreen } from "./KinMarketingListScreen";
import { KinProjectLeadScreen } from "./KinProjectLeadScreen";
import { KinProjectPeopleScreen } from "./KinProjectPeopleScreen";
import { KinProjectScreen } from "./KinProjectScreen";
import { KinSettingsScreen } from "./KinSettings";
import { KinThisPhoneScreen } from "./KinThisPhoneScreen";
import { KinBriefFormScreen } from "./KinBriefs";
import { KinCheckInFormScreen } from "./KinCheckIns";
import { KinGoalFormScreen } from "./KinGoals";
import { KinInviteScreen } from "./KinInviteScreen";
import { KinReceiptApplyScreen, KinReceiptNewScreen } from "./KinInvoice";
import { KinExpenseNewScreen, KinInvoiceNewScreen } from "./KinMoneyForms";
import { KinJoinScreen } from "./KinJoinScreen";
import { KinBudgetScreen } from "./KinMoneyAnswers";
import { KinTeamScreen } from "./KinTeamScreen";
import { KinDevicesScreen } from "./KinDevicesScreen";
import { KinProfileEditScreen, KinProfileScreen } from "./KinProfileScreen";
import { KinTeammateScreen } from "./KinTeammateScreen";
import { KinWaitingScreen } from "./KinWaitingScreen";
import { KinWorkAssignScreen } from "./KinWorkAssignScreen";
import { KinWorkHandBackScreen } from "./KinWorkHandBackScreen";
import {
  KinClientFormScreen,
  KinContactFormScreen,
  KinMilestoneFormScreen,
  KinProjectFormScreen,
} from "./KinWorkFormScreens";
import { KinTouchFormScreen } from "./KinTouchFormScreen";
import { KinWorkItemScreen } from "./KinWorkItemScreen";
import { KinWorkNewScreen } from "./KinWorkNewScreen";
import { KinWorkScreen } from "./KinWorkScreen";

/** Kin's root-stack routes, spread into `Stack.tsx`. Kin files must never import `Stack.tsx`. */
export const KIN_SCREENS = {
  KinChats: createNativeStackScreen({
    screen: KinChatsScreen,
    linking: "kin",
    options: pageRoute({ title: "Kin" }),
  }),
  // A Settings page: the name puts it in the Settings tab, beside the list on wide layouts.
  SettingsKin: createNativeStackScreen({
    screen: KinSettingsScreen,
    linking: "settings/kin",
    options: pageRoute({ title: "Kin", itemStyle: "standard" }),
  }),
  KinThisPhone: createNativeStackScreen({
    screen: KinThisPhoneScreen,
    options: pageRoute({ title: "This phone" }),
  }),
  KinAppearance: createNativeStackScreen({
    screen: KinAppearanceScreen,
    options: pageRoute({ title: "Appearance" }),
  }),
  KinWaiting: createNativeStackScreen({
    screen: KinWaitingScreen,
    linking: "kin/waiting",
    options: pageRoute({ title: KIN_WAITING_TITLE }),
  }),
  KinMemory: createNativeStackScreen({
    screen: KinMemoryScreen,
    linking: "kin/:environmentId/:orgId/memory",
    options: pageRoute({ title: "Memory" }),
  }),
  KinWork: createNativeStackScreen({
    screen: KinWorkScreen,
    linking: "kin/:environmentId/:orgId/work",
    options: pageRoute({ title: "Tasks" }),
  }),
  KinWorkItem: createNativeStackScreen({
    screen: KinWorkItemScreen,
    linking: "kin/:environmentId/:orgId/work/:task",
    options: pageRoute({ title: "Task" }),
  }),
  KinList: createNativeStackScreen({
    screen: KinListScreen,
    linking: "kin/:environmentId/:orgId/lists/:list",
    options: pageRoute({ title: "List" }),
  }),
  KinDates: createNativeStackScreen({
    screen: KinDatesScreen,
    linking: "kin/:environmentId/:orgId/dates",
    options: pageRoute({ title: "All dates" }),
  }),
  // Full sheets, so the keyboard never covers what is being typed.
  KinPayment: createNativeStackScreen({
    screen: KinPaymentScreen,
    options: sheetRoute({ detent: "full", android: "fullScreen" }),
  }),
  KinBudget: createNativeStackScreen({
    screen: KinBudgetScreen,
    options: sheetRoute({ detent: "full", android: "fullScreen" }),
  }),
  KinReceiptNew: createNativeStackScreen({
    screen: KinReceiptNewScreen,
    options: sheetRoute({ detent: "full", android: "fullScreen" }),
  }),
  KinInvoiceNew: createNativeStackScreen({
    screen: KinInvoiceNewScreen,
    options: sheetRoute({ detent: "full", android: "fullScreen" }),
  }),
  KinExpenseNew: createNativeStackScreen({
    screen: KinExpenseNewScreen,
    options: sheetRoute({ detent: "full", android: "fullScreen" }),
  }),
  KinReceiptApply: createNativeStackScreen({
    screen: KinReceiptApplyScreen,
    options: sheetRoute({ detent: 0.75 }),
  }),
  KinEntryEdit: createNativeStackScreen({
    screen: KinEntryEditScreen,
    options: sheetRoute({ detent: "full", android: "fullScreen" }),
  }),
  KinListSettings: createNativeStackScreen({
    screen: KinListSettingsScreen,
    options: sheetRoute({ detent: "full", android: "fullScreen" }),
  }),
  KinSubscriptions: createNativeStackScreen({
    screen: KinSubscriptionsScreen,
    linking: "kin/:environmentId/:orgId/subscriptions",
    options: pageRoute({ title: "Subscriptions" }),
  }),
  // A full sheet, so the keyboard never covers the rate being typed.
  KinRates: createNativeStackScreen({
    screen: KinRatesScreen,
    options: sheetRoute({ detent: "full", android: "fullScreen" }),
  }),
  KinWatchLog: createNativeStackScreen({
    screen: KinWatchLogScreen,
    linking: "kin/:environmentId/:orgId/watches",
    options: pageRoute({ title: "What Kin checked" }),
  }),
  KinCompany: createNativeStackScreen({
    screen: KinCompanyScreen,
    linking: "kin/:environmentId/:orgId/company",
    options: pageRoute({ title: "Company details" }),
  }),
  KinConnections: createNativeStackScreen({
    screen: KinConnectionsScreen,
    linking: "kin/:environmentId/:orgId/connections",
    options: pageRoute({ title: "Connections" }),
  }),
  KinConnection: createNativeStackScreen({
    screen: KinConnectionScreen,
    linking: "kin/:environmentId/:orgId/connections/:connectionId",
    options: pageRoute({ title: "Connection" }),
  }),
  // Full sheets, so the keyboard never covers the key being pasted.
  KinConnectionAdd: createNativeStackScreen({
    screen: KinConnectionAddScreen,
    options: sheetRoute({ detent: "full", android: "fullScreen" }),
  }),
  KinGitHubConnect: createNativeStackScreen({
    screen: KinGitHubConnectScreen,
    options: sheetRoute({ detent: "full", android: "fullScreen" }),
  }),
  KinSocialConnect: createNativeStackScreen({
    screen: KinSocialConnectScreen,
    options: sheetRoute({ detent: "full", android: "fullScreen" }),
  }),
  KinSocialLink: createNativeStackScreen({
    screen: KinSocialLinkScreen,
    options: sheetRoute({ detent: "full", android: "fullScreen" }),
  }),
  KinConnectionEdit: createNativeStackScreen({
    screen: KinConnectionEditScreen,
    options: sheetRoute({ detent: "full", android: "fullScreen" }),
  }),
  KinWorkAssign: createNativeStackScreen({
    screen: KinWorkAssignScreen,
    options: sheetRoute({ detent: 0.75 }),
  }),
  KinWorkHandBack: createNativeStackScreen({
    screen: KinWorkHandBackScreen,
    options: sheetRoute({ detent: 0.6 }),
  }),
  KinWorkNew: createNativeStackScreen({
    screen: KinWorkNewScreen,
    options: sheetRoute({ detent: "full", android: "fullScreen" }),
  }),
  KinClient: createNativeStackScreen({
    screen: KinClientScreen,
    linking: "kin/:environmentId/:orgId/clients/:party",
    options: pageRoute({ title: "Client" }),
  }),
  KinProject: createNativeStackScreen({
    screen: KinProjectScreen,
    linking: "kin/:environmentId/:orgId/projects/:project",
    options: pageRoute({ title: "Project" }),
  }),
  KinDeal: createNativeStackScreen({
    screen: KinDealScreen,
    linking: "kin/:environmentId/:orgId/deals/:deal",
    options: pageRoute({ title: "Deal" }),
  }),
  KinDealNew: createNativeStackScreen({
    screen: KinDealNewScreen,
    options: sheetRoute({ detent: "full", android: "fullScreen" }),
  }),
  KinDealEdit: createNativeStackScreen({
    screen: KinDealEditScreen,
    options: sheetRoute({ detent: "full", android: "fullScreen" }),
  }),
  KinDealsConcern: createNativeStackScreen({
    screen: KinDealsConcernScreen,
    options: sheetRoute({ detent: 0.75 }),
  }),
  KinDealStages: createNativeStackScreen({
    screen: KinDealStagesScreen,
    linking: "kin/:environmentId/:orgId/settings/deals",
    options: pageRoute({ title: "Deals" }),
  }),
  KinImport: createNativeStackScreen({
    screen: KinImportScreen,
    options: pageRoute({ title: "Import a file" }),
  }),
  KinDoc: createNativeStackScreen({
    screen: KinDocScreen,
    linking: "kin/:environmentId/:orgId/docs/:doc",
    options: pageRoute({ title: "Doc" }),
  }),
  // A sheet on the doc, so the changes close back to it.
  KinDocChanges: createNativeStackScreen({
    screen: KinDocChangesScreen,
    linking: "kin/:environmentId/:orgId/docs/:doc/changes",
    options: sheetRoute({ detent: "full", android: "fullScreen" }),
  }),
  KinDocFile: createNativeStackScreen({
    screen: KinDocFileScreen,
    options: sheetRoute({ detent: "full", android: "fullScreen" }),
  }),
  KinDocHistory: createNativeStackScreen({
    screen: KinDocHistoryScreen,
    options: sheetRoute({ detent: 0.75 }),
  }),
  // A full sheet, so the keyboard never covers what was found.
  KinSearch: createNativeStackScreen({
    screen: KinSearchScreen,
    linking: "kin/:environmentId/:orgId/search",
    options: sheetRoute({ detent: "full", android: "fullScreen" }),
  }),
  KinGoalForm: createNativeStackScreen({
    screen: KinGoalFormScreen,
    options: sheetRoute({ detent: "full", android: "fullScreen" }),
  }),
  KinCheckInForm: createNativeStackScreen({
    screen: KinCheckInFormScreen,
    options: sheetRoute({ detent: "full", android: "fullScreen" }),
  }),
  KinBriefForm: createNativeStackScreen({
    screen: KinBriefFormScreen,
    options: sheetRoute({ detent: "full", android: "fullScreen" }),
  }),
  KinClientForm: createNativeStackScreen({
    screen: KinClientFormScreen,
    options: sheetRoute({ detent: "full", android: "fullScreen" }),
  }),
  KinContactForm: createNativeStackScreen({
    screen: KinContactFormScreen,
    options: sheetRoute({ detent: "full", android: "fullScreen" }),
  }),
  KinTouchForm: createNativeStackScreen({
    screen: KinTouchFormScreen,
    options: sheetRoute({ detent: 0.75 }),
  }),
  KinProjectForm: createNativeStackScreen({
    screen: KinProjectFormScreen,
    options: sheetRoute({ detent: "full", android: "fullScreen" }),
  }),
  KinMilestoneForm: createNativeStackScreen({
    screen: KinMilestoneFormScreen,
    options: sheetRoute({ detent: 0.6 }),
  }),
  KinTeam: createNativeStackScreen({
    screen: KinTeamScreen,
    linking: "kin/:environmentId/:orgId/team",
    options: pageRoute({ title: "Team" }),
  }),
  KinMarketingList: createNativeStackScreen({
    screen: KinMarketingListScreen,
    options: sheetRoute({ detent: "full", android: "fullScreen" }),
  }),
  KinProjectLead: createNativeStackScreen({
    screen: KinProjectLeadScreen,
    options: sheetRoute({ detent: 0.75 }),
  }),
  KinProjectPeople: createNativeStackScreen({
    screen: KinProjectPeopleScreen,
    options: sheetRoute({ detent: 0.75 }),
  }),
  KinTeammate: createNativeStackScreen({
    screen: KinTeammateScreen,
    options: sheetRoute({ detent: 0.75 }),
  }),
  KinProfile: createNativeStackScreen({
    screen: KinProfileScreen,
    linking: "kin/:environmentId/:orgId/people/:personId",
    options: sheetRoute({ detent: 0.75 }),
  }),
  KinDevices: createNativeStackScreen({
    screen: KinDevicesScreen,
    linking: "kin/:environmentId/:orgId/people/:personId/devices",
    options: pageRoute({ title: "Your devices" }),
  }),
  // A full sheet, so the keyboard never covers the field being typed in.
  KinProfileEdit: createNativeStackScreen({
    screen: KinProfileEditScreen,
    options: sheetRoute({ detent: "full", android: "fullScreen" }),
  }),
  // A full sheet, so the keyboard never covers the name being typed.
  KinInvite: createNativeStackScreen({
    screen: KinInviteScreen,
    options: sheetRoute({ detent: "full", android: "fullScreen" }),
  }),
  // A teammate's way in; the link arrives pasted, scanned, or in `kin/join?link=`.
  KinJoin: createNativeStackScreen({
    screen: KinJoinScreen,
    linking: "kin/join",
    options: sheetRoute({ detent: "full", android: "fullScreen" }),
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
  KinAgents: createNativeStackScreen({
    screen: KinAgentsScreen,
    linking: "kin/:environmentId/:orgId/agents",
    options: pageRoute({ title: "Agents" }),
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
  KinPeoplePick: createNativeStackScreen({
    screen: KinPeoplePickScreen,
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
