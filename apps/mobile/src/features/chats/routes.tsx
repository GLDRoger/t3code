import { createNativeStackScreen } from "@react-navigation/native-stack";

import { pageRoute, sheetRoute } from "../layout/route-options";
import { KinApprovalsScreen } from "./approvals/KinApprovalsScreen";
import { KinAgentsScreen } from "./KinAgentsScreen";
import { KinChatScreen } from "./KinChatScreen";
import { KinChatsScreen } from "./KinChatsScreen";
import { KinClientScreen } from "./KinClientScreen";
import { KinCompanyScreen } from "./KinCompanyScreen";
import { KinDocScreen } from "./KinDocScreen";
import { KinDocChangesScreen, KinDocHistoryScreen, KinSearchScreen } from "./KinDocVersionScreens";
import { KinGroupFormScreen } from "./KinGroupFormScreen";
import { KinGroupScreen } from "./KinGroupScreen";
import { KinLeadFormScreen } from "./KinLeadFormScreen";
import { KinListSettingsScreen, KinPaymentScreen } from "./KinListEntry";
import { KinEntryEditScreen } from "./KinListEntryEdit";
import { KinDatesScreen, KinListScreen } from "./KinListScreen";
import { KinLeadScreen } from "./KinLeadScreen";
import { KinMemoryScreen } from "./KinMemoryScreen";
import { KinProjectScreen } from "./KinProjectScreen";
import { KinInviteScreen } from "./KinInviteScreen";
import { KinJoinScreen } from "./KinJoinScreen";
import { KinTeamScreen } from "./KinTeamScreen";
import { KinTeammateScreen } from "./KinTeammateScreen";
import { KinWaitingScreen } from "./KinWaitingScreen";
import { KinWorkAssignScreen } from "./KinWorkAssignScreen";
import { KinWorkEditScreen } from "./KinWorkEditScreen";
import {
  KinClientFormScreen,
  KinContactFormScreen,
  KinProjectFormScreen,
} from "./KinWorkFormScreens";
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
  KinWaiting: createNativeStackScreen({
    screen: KinWaitingScreen,
    linking: "kin/waiting",
    options: pageRoute({ title: "Waiting on you" }),
  }),
  KinMemory: createNativeStackScreen({
    screen: KinMemoryScreen,
    linking: "kin/:environmentId/:orgId/memory",
    options: pageRoute({ title: "Memory" }),
  }),
  KinWork: createNativeStackScreen({
    screen: KinWorkScreen,
    linking: "kin/:environmentId/:orgId/work",
    options: pageRoute({ title: "Work" }),
  }),
  KinWorkItem: createNativeStackScreen({
    screen: KinWorkItemScreen,
    linking: "kin/:environmentId/:orgId/work/:task",
    options: sheetRoute({ detent: 0.75 }),
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
  KinEntryEdit: createNativeStackScreen({
    screen: KinEntryEditScreen,
    options: sheetRoute({ detent: "full", android: "fullScreen" }),
  }),
  KinListSettings: createNativeStackScreen({
    screen: KinListSettingsScreen,
    options: sheetRoute({ detent: "full", android: "fullScreen" }),
  }),
  KinCompany: createNativeStackScreen({
    screen: KinCompanyScreen,
    linking: "kin/:environmentId/:orgId/company",
    options: pageRoute({ title: "Company details" }),
  }),
  KinWorkAssign: createNativeStackScreen({
    screen: KinWorkAssignScreen,
    options: sheetRoute({ detent: 0.75 }),
  }),
  // A full sheet, so the keyboard never covers what is being typed.
  KinWorkEdit: createNativeStackScreen({
    screen: KinWorkEditScreen,
    options: sheetRoute({ detent: "full", android: "fullScreen" }),
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
  KinDoc: createNativeStackScreen({
    screen: KinDocScreen,
    linking: "kin/:environmentId/:orgId/docs/:doc",
    options: pageRoute({ title: "Doc" }),
  }),
  KinDocChanges: createNativeStackScreen({
    screen: KinDocChangesScreen,
    linking: "kin/:environmentId/:orgId/docs/:doc/changes",
    options: pageRoute({ title: "Changes" }),
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
  KinClientForm: createNativeStackScreen({
    screen: KinClientFormScreen,
    options: sheetRoute({ detent: "full", android: "fullScreen" }),
  }),
  KinContactForm: createNativeStackScreen({
    screen: KinContactFormScreen,
    options: sheetRoute({ detent: "full", android: "fullScreen" }),
  }),
  KinProjectForm: createNativeStackScreen({
    screen: KinProjectFormScreen,
    options: sheetRoute({ detent: "full", android: "fullScreen" }),
  }),
  KinTeam: createNativeStackScreen({
    screen: KinTeamScreen,
    linking: "kin/:environmentId/:orgId/team",
    options: pageRoute({ title: "Team" }),
  }),
  KinTeammate: createNativeStackScreen({
    screen: KinTeammateScreen,
    options: sheetRoute({ detent: 0.75 }),
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
