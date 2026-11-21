import PeopleInvites from "./migrations/K038_PeopleInvites.ts";
import LeadHandoffs from "./migrations/K039_LeadHandoffs.ts";
import MessageAttachments from "./migrations/K040_MessageAttachments.ts";
import GroupLead from "./migrations/K041_GroupLead.ts";
import ReactionWakes from "./migrations/K042_ReactionWakes.ts";
import WakeupAudience from "./migrations/K043_WakeupAudience.ts";
import WakeupSharedSince from "./migrations/K044_WakeupSharedSince.ts";
import WakeupAudienceAbort from "./migrations/K045_WakeupAudienceAbort.ts";
import ChatCleared from "./migrations/K046_ChatCleared.ts";
import SilentMessages from "./migrations/K047_SilentMessages.ts";
import LeadAccess from "./migrations/K050_LeadAccess.ts";
import ChatSharing from "./migrations/K051_ChatSharing.ts";
import MemoryLabels from "./migrations/K052_MemoryLabels.ts";
import MemorySharing from "./migrations/K053_MemorySharing.ts";
import SharedProjection from "./migrations/K054_SharedProjection.ts";
import ChatGrantsLapse from "./migrations/K055_ChatGrantsLapse.ts";
import SuggestionsByVersion from "./migrations/K056_SuggestionsByVersion.ts";
import Schedules from "./migrations/K057_Schedules.ts";
import Work from "./migrations/K058_Work.ts";
import WorkerWithdrawals from "./migrations/K059_WorkerWithdrawals.ts";
import WorkClients from "./migrations/K060_WorkClients.ts";
import WorkerAttempts from "./migrations/K061_WorkerAttempts.ts";
import WorkerPublishApproval from "./migrations/K062_WorkerPublishApproval.ts";
import LegacyWorkerAttempts from "./migrations/K063_LegacyWorkerAttempts.ts";
import AgentRetirement from "./migrations/K064_AgentRetirement.ts";
import WakeupRetired from "./migrations/K065_WakeupRetired.ts";
import WakeupsUnretiredIndex from "./migrations/K066_WakeupsUnretiredIndex.ts";
import Docs from "./migrations/K067_Docs.ts";
import WorkMoney from "./migrations/K068_WorkMoney.ts";
import WorkerNetwork from "./migrations/K069_WorkerNetwork.ts";
import VisualHosts from "./migrations/K070_VisualHosts.ts";
import OwnerAnswerCards from "./migrations/K071_OwnerAnswerCards.ts";
import GeneratedDocuments from "./migrations/K072_GeneratedDocuments.ts";
import KeyPushes from "./migrations/K073_KeyPushes.ts";
import DocJobCleanup from "./migrations/K074_DocJobCleanup.ts";
import ServerRenderedDocuments from "./migrations/K075_ServerRenderedDocuments.ts";
import DocFiles from "./migrations/K076_DocFiles.ts";
import DocumentLabels from "./migrations/K077_DocumentLabels.ts";
import RecipeLabelBaselines from "./migrations/K078_RecipeLabelBaselines.ts";
import ImportRuns from "./migrations/K079_ImportRuns.ts";
import RecordRequestHash from "./migrations/K080_RecordRequestHash.ts";
import RecipeJobPasses from "./migrations/K081_RecipeJobPasses.ts";
import BankStatements from "./migrations/K082_BankStatements.ts";
import StatementSafety from "./migrations/K083_StatementSafety.ts";
import RecipeDefaults from "./migrations/K084_RecipeDefaults.ts";
import StatementReading from "./migrations/K085_StatementReading.ts";
import StatementChatPasswords from "./migrations/K086_StatementChatPasswords.ts";
import TeamWork from "./migrations/K087_TeamWork.ts";
import MoneyRecords from "./migrations/K088_MoneyRecords.ts";
import ChatThreads from "./migrations/K106_ChatThreads.ts";
import Connections from "./migrations/K107_Connections.ts";
import BudgetNotices from "./migrations/K110_BudgetNotices.ts";
import ConnectionPause from "./migrations/K130_ConnectionPause.ts";
import ReceiptProposalsPasswordBudget from "./migrations/K131_ReceiptProposalsPasswordBudget.ts";
import PeopleProfiles from "./migrations/K132_PeopleProfiles.ts";
import MoneyBudgets from "./migrations/K133_MoneyBudgets.ts";
import ConnectionSignIn from "./migrations/K134_ConnectionSignIn.ts";
import PulseFacts from "./migrations/K135_PulseFacts.ts";
import ConnectionAsks from "./migrations/K136_ConnectionAsks.ts";
import PersonAccess from "./migrations/K137_PersonAccess.ts";
import PulseCheckIns from "./migrations/K138_PulseCheckIns.ts";
import ClientTouches from "./migrations/K139_ClientTouches.ts";
import AssignedByAgent from "./migrations/K140_AssignedByAgent.ts";
import ConnectionAccounts from "./migrations/K141_ConnectionAccounts.ts";
import MicrosoftConnections from "./migrations/K142_MicrosoftConnections.ts";
import PersonPlaces from "./migrations/K143_PersonPlaces.ts";
import PullRequestCare from "./migrations/K144_PullRequestCare.ts";
import RetireRoutines from "./migrations/K145_RetireRoutines.ts";
import SendDecidedBy from "./migrations/K146_SendDecidedBy.ts";
import SendOwesCard from "./migrations/K147_SendOwesCard.ts";
import EventReplied from "./migrations/K148_EventReplied.ts";
import SendAccount from "./migrations/K149_SendAccount.ts";
import PersonRemoved from "./migrations/K150_PersonRemoved.ts";
import ToldAndHeld from "./migrations/K151_ToldAndHeld.ts";
import MessageForm from "./migrations/K152_MessageForm.ts";
import HeldRelays from "./migrations/K153_HeldRelays.ts";
import TeamDiscussions from "./migrations/K154_TeamDiscussions.ts";
import TalkStyle from "./migrations/K155_TalkStyle.ts";
import NamedKeys from "./migrations/K156_NamedKeys.ts";
import AgentSettings from "./migrations/K157_AgentSettings.ts";
import PrivateBy from "./migrations/K158_PrivateBy.ts";
import OpenQuestions from "./migrations/K159_OpenQuestions.ts";
import GitHubWatch from "./migrations/K160_GitHubWatch.ts";
import Social from "./migrations/K161_Social.ts";
import PersonHours from "./migrations/K162_PersonHours.ts";
import OneModel from "./migrations/K163_OneModel.ts";
import WorkersRetired from "./migrations/K164_WorkersRetired.ts";
import HandedBack from "./migrations/K165_HandedBack.ts";
import GitHubAppRetired from "./migrations/K166_GitHubAppRetired.ts";
import TeamMemorySetting from "./migrations/K167_TeamMemorySetting.ts";
import GitHubOwnerUses from "./migrations/K168_GitHubOwnerUses.ts";
import AwayAndWhen from "./migrations/K169_AwayAndWhen.ts";
import OneSocialProfile from "./migrations/K170_OneSocialProfile.ts";
import GitHubBranchGuards from "./migrations/K171_GitHubBranchGuards.ts";
import CalendarCursor from "./migrations/K172_CalendarCursor.ts";
import NoMemoryReviewPulls from "./migrations/K173_NoMemoryReviewPulls.ts";
import AnswerPages from "./migrations/K174_AnswerPages.ts";
import HandoffWantsAnswer from "./migrations/K175_HandoffWantsAnswer.ts";
import RecordComments from "./migrations/K176_RecordComments.ts";
import RecordChangesByWakeup from "./migrations/K177_RecordChangesByWakeup.ts";
import AskOutsideAndDispatch from "./migrations/K178_AskOutsideAndDispatch.ts";
import DeviceLinks from "./migrations/K179_DeviceLinks.ts";
import CardPlans from "./migrations/K180_CardPlans.ts";
import TasksKeys from "./migrations/K181_TasksKeys.ts";
import HandoffRoutes from "./migrations/K182_HandoffRoutes.ts";
import TasksKeyMakers from "./migrations/K183_TasksKeyMakers.ts";
import Recommendations from "./migrations/K184_Recommendations.ts";
import AskedFor from "./migrations/K185_AskedFor.ts";
import TasksKeysWithoutMaker from "./migrations/K186_TasksKeysWithoutMaker.ts";
import Holds from "./migrations/K187_Holds.ts";
import ReachLimits from "./migrations/K188_ReachLimits.ts";
import MorningPages from "./migrations/K189_MorningPages.ts";
import RecordTitleIndex from "./migrations/K190_RecordTitleIndex.ts";
import HistoryIndexes from "./migrations/K191_HistoryIndexes.ts";
import RecordOwnerListIndex from "./migrations/K192_RecordOwnerListIndex.ts";
import ScheduleOwnerTime from "./migrations/K193_ScheduleOwnerTime.ts";
import DropWebhookSources from "./migrations/K194_DropWebhookSources.ts";
import DreamCharges from "./migrations/K195_DreamCharges.ts";
import InvitePlaces from "./migrations/K901_InvitePlaces.ts";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import ChatCore from "./migrations/K001_ChatCore.ts";
import Lead from "./migrations/K002_Lead.ts";
import Triggers from "./migrations/K003_Triggers.ts";
import MemoryReads from "./migrations/K004_MemoryReads.ts";
import OneChatOwner from "./migrations/K005_OneChatOwner.ts";
import Pings from "./migrations/K006_Pings.ts";
import Budget from "./migrations/K007_Budget.ts";
import Floor from "./migrations/K008_Floor.ts";
import JudgeLog from "./migrations/K009_JudgeLog.ts";
import ChatChanges from "./migrations/K010_ChatChanges.ts";
import MemoryHeads from "./migrations/K011_MemoryHeads.ts";
import SecretAllow from "./migrations/K012_SecretAllow.ts";
import Routines from "./migrations/K013_Routines.ts";
import LeadToolCalls from "./migrations/K014_LeadToolCalls.ts";
import AuthSessionKeys from "./migrations/K015_AuthSessionKeys.ts";
import DeferralRuns from "./migrations/K016_DeferralRuns.ts";
import Workers from "./migrations/K017_Workers.ts";
import Dreams from "./migrations/K018_Dreams.ts";
import WebhookSecretHash from "./migrations/K019_WebhookSecretHash.ts";
import Approvals from "./migrations/K020_Approvals.ts";
import PushDevices from "./migrations/K021_PushDevices.ts";
import ChatLevels from "./migrations/K022_ChatLevels.ts";
import ExecutionWriteStarted from "./migrations/K023_ExecutionWriteStarted.ts";
import MemoryReviewPulls from "./migrations/K024_MemoryReviewPulls.ts";
import FloorGrantWakeup from "./migrations/K025_FloorGrantWakeup.ts";
import Reactions from "./migrations/K026_Reactions.ts";
import AuthorityBinding from "./migrations/K027_AuthorityBinding.ts";
import WakeupTimings from "./migrations/K028_WakeupTimings.ts";
import DropJudgeLog from "./migrations/K029_DropJudgeLog.ts";
import ManyLeads from "./migrations/K030_ManyLeads.ts";
import LeadDeliveries from "./migrations/K031_LeadDeliveries.ts";
import WorkerEnvironment from "./migrations/K032_WorkerEnvironment.ts";
import ApproverKeyConfirmations from "./migrations/K033_ApproverKeyConfirmations.ts";
import PerLeadWakeups from "./migrations/K034_PerLeadWakeups.ts";
import RetireLevelCards from "./migrations/K035_RetireLevelCards.ts";

const table = "kin_sql_migrations";
const run = Migrator.make({});
const migrations = {
  "1_ChatCore": ChatCore,
  "2_Lead": Lead,
  "3_Triggers": Triggers,
  "4_MemoryReads": MemoryReads,
  "5_OneChatOwner": OneChatOwner,
  "6_Pings": Pings,
  "7_Budget": Budget,
  "8_Floor": Floor,
  "9_JudgeLog": JudgeLog,
  "10_ChatChanges": ChatChanges,
  "11_MemoryHeads": MemoryHeads,
  "12_SecretAllow": SecretAllow,
  "13_Routines": Routines,
  "14_LeadToolCalls": LeadToolCalls,
  "15_AuthSessionKeys": AuthSessionKeys,
  "16_DeferralRuns": DeferralRuns,
  "17_Workers": Workers,
  "18_Dreams": Dreams,
  "19_WebhookSecretHash": WebhookSecretHash,
  "20_Approvals": Approvals,
  "21_PushDevices": PushDevices,
  "22_ChatLevels": ChatLevels,
  "23_ExecutionWriteStarted": ExecutionWriteStarted,
  "24_MemoryReviewPulls": MemoryReviewPulls,
  "25_FloorGrantWakeup": FloorGrantWakeup,
  "26_Reactions": Reactions,
  "27_AuthorityBinding": AuthorityBinding,
  "28_WakeupTimings": WakeupTimings,
  "29_DropJudgeLog": DropJudgeLog,
  "30_ManyLeads": ManyLeads,
  "31_LeadDeliveries": LeadDeliveries,
  "32_WorkerEnvironment": WorkerEnvironment,
  "33_ApproverKeyConfirmations": ApproverKeyConfirmations,
  "34_PerLeadWakeups": PerLeadWakeups,
  "35_RetireLevelCards": RetireLevelCards,
  "38_PeopleInvites": PeopleInvites,
  "39_LeadHandoffs": LeadHandoffs,
  "40_MessageAttachments": MessageAttachments,
  "41_GroupLead": GroupLead,
  "42_ReactionWakes": ReactionWakes,
  "43_WakeupAudience": WakeupAudience,
  "44_WakeupSharedSince": WakeupSharedSince,
  "45_WakeupAudienceAbort": WakeupAudienceAbort,
  "46_ChatCleared": ChatCleared,
  "47_SilentMessages": SilentMessages,
  "50_LeadAccess": LeadAccess,
  "51_ChatSharing": ChatSharing,
  "52_MemoryLabels": MemoryLabels,
  "53_MemorySharing": MemorySharing,
  "54_SharedProjection": SharedProjection,
  "55_ChatGrantsLapse": ChatGrantsLapse,
  "56_SuggestionsByVersion": SuggestionsByVersion,
  "57_Schedules": Schedules,
  "58_Work": Work,
  "59_WorkerWithdrawals": WorkerWithdrawals,
  "60_WorkClients": WorkClients,
  "61_WorkerAttempts": WorkerAttempts,
  "62_WorkerPublishApproval": WorkerPublishApproval,
  "63_LegacyWorkerAttempts": LegacyWorkerAttempts,
  "64_AgentRetirement": AgentRetirement,
  "65_WakeupRetired": WakeupRetired,
  "66_WakeupsUnretiredIndex": WakeupsUnretiredIndex,
  "67_Docs": Docs,
  "68_WorkMoney": WorkMoney,
  "69_WorkerNetwork": WorkerNetwork,
  "70_VisualHosts": VisualHosts,
  "71_OwnerAnswerCards": OwnerAnswerCards,
  "72_GeneratedDocuments": GeneratedDocuments,
  "73_KeyPushes": KeyPushes,
  "74_DocJobCleanup": DocJobCleanup,
  "75_ServerRenderedDocuments": ServerRenderedDocuments,
  "76_DocFiles": DocFiles,
  "77_DocumentLabels": DocumentLabels,
  "78_RecipeLabelBaselines": RecipeLabelBaselines,
  "79_ImportRuns": ImportRuns,
  "80_RecordRequestHash": RecordRequestHash,
  "81_RecipeJobPasses": RecipeJobPasses,
  "82_BankStatements": BankStatements,
  "83_StatementSafety": StatementSafety,
  "84_RecipeDefaults": RecipeDefaults,
  "85_StatementReading": StatementReading,
  "86_StatementChatPasswords": StatementChatPasswords,
  "87_TeamWork": TeamWork,
  "88_MoneyRecords": MoneyRecords,
  "106_ChatThreads": ChatThreads,
  "107_Connections": Connections,
  "110_BudgetNotices": BudgetNotices,
  "130_ConnectionPause": ConnectionPause,
  "131_ReceiptProposalsPasswordBudget": ReceiptProposalsPasswordBudget,
  "132_PeopleProfiles": PeopleProfiles,
  "133_MoneyBudgets": MoneyBudgets,
  "134_ConnectionSignIn": ConnectionSignIn,
  "135_PulseFacts": PulseFacts,
  "136_ConnectionAsks": ConnectionAsks,
  "137_PersonAccess": PersonAccess,
  "138_PulseCheckIns": PulseCheckIns,
  "139_ClientTouches": ClientTouches,
  "140_AssignedByAgent": AssignedByAgent,
  "141_ConnectionAccounts": ConnectionAccounts,
  "142_MicrosoftConnections": MicrosoftConnections,
  "143_PersonPlaces": PersonPlaces,
  "144_PullRequestCare": PullRequestCare,
  "145_RetireRoutines": RetireRoutines,
  "146_SendDecidedBy": SendDecidedBy,
  "147_SendOwesCard": SendOwesCard,
  "148_EventReplied": EventReplied,
  "149_SendAccount": SendAccount,
  "150_PersonRemoved": PersonRemoved,
  "151_ToldAndHeld": ToldAndHeld,
  "152_MessageForm": MessageForm,
  "153_HeldRelays": HeldRelays,
  "154_TeamDiscussions": TeamDiscussions,
  "155_TalkStyle": TalkStyle,
  "156_NamedKeys": NamedKeys,
  "157_AgentSettings": AgentSettings,
  "158_PrivateBy": PrivateBy,
  "159_OpenQuestions": OpenQuestions,
  "160_GitHubWatch": GitHubWatch,
  "161_Social": Social,
  "162_PersonHours": PersonHours,
  "163_OneModel": OneModel,
  "164_WorkersRetired": WorkersRetired,
  "165_HandedBack": HandedBack,
  "166_GitHubAppRetired": GitHubAppRetired,
  "167_TeamMemorySetting": TeamMemorySetting,
  "168_GitHubOwnerUses": GitHubOwnerUses,
  "169_AwayAndWhen": AwayAndWhen,
  "170_OneSocialProfile": OneSocialProfile,
  "171_GitHubBranchGuards": GitHubBranchGuards,
  "172_CalendarCursor": CalendarCursor,
  "173_NoMemoryReviewPulls": NoMemoryReviewPulls,
  "174_AnswerPages": AnswerPages,
  "175_HandoffWantsAnswer": HandoffWantsAnswer,
  "176_RecordComments": RecordComments,
  "177_RecordChangesByWakeup": RecordChangesByWakeup,
  "178_AskOutsideAndDispatch": AskOutsideAndDispatch,
  "179_DeviceLinks": DeviceLinks,
  "180_CardPlans": CardPlans,
  "181_TasksKeys": TasksKeys,
  "182_HandoffRoutes": HandoffRoutes,
  "183_TasksKeyMakers": TasksKeyMakers,
  "184_Recommendations": Recommendations,
  "185_AskedFor": AskedFor,
  "186_TasksKeysWithoutMaker": TasksKeysWithoutMaker,
  "187_Holds": Holds,
  "188_ReachLimits": ReachLimits,
  "189_MorningPages": MorningPages,
  "190_RecordTitleIndex": RecordTitleIndex,
  "191_HistoryIndexes": HistoryIndexes,
  "192_RecordOwnerListIndex": RecordOwnerListIndex,
  "193_ScheduleOwnerTime": ScheduleOwnerTime,
  "194_DropWebhookSources": DropWebhookSources,
  "195_DreamCharges": DreamCharges,
  "901_InvitePlaces": InvitePlaces,
};
const loader = Migrator.fromRecord(migrations);

/** Every Kin migration as `[id, name]`, in the order they run. */
export const kinMigrations = Object.keys(migrations)
  .map((key) => {
    const at = key.indexOf("_");
    return [Number(key.slice(0, at)), key.slice(at + 1)] as const;
  })
  .toSorted(([a], [b]) => a - b);

// The Migrator skips every id at or below the latest applied one, so a migration that
// merged out of order would silently never run. Refuse to start instead.
const refuseSkippedMigrations = Effect.fn("KinMigrations.refuseSkipped")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const exists = yield* sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ${table}`;
  if (exists.length === 0) return;
  const applied = new Map(
    (yield* sql<{
      migration_id: number;
      name: string;
    }>`SELECT migration_id, name FROM ${sql(table)}`).map((row) => [row.migration_id, row.name]),
  );
  const latest = Math.max(0, ...applied.keys());
  const registered = yield* loader;
  const skipped = registered.filter(([id]) => id < latest && !applied.has(id));
  // Two branches can take the same number; the Migrator would treat the second as already run.
  const renamed = registered.filter(([id, name]) => applied.has(id) && applied.get(id) !== name);
  if (skipped.length === 0 && renamed.length === 0) return;
  const names = (list: typeof registered) => list.map(([id, name]) => `${id}_${name}`).join(", ");
  return yield* new Migrator.MigrationError({
    kind: "BadState",
    message:
      skipped.length > 0
        ? `Kin migrations ${names(skipped)} are registered below the latest applied migration ${latest} but never ran. They merged out of order; renumber them above ${latest}.`
        : `Kin migrations ${names(renamed)} share a number with a different migration this database already ran. Renumber them above ${latest}.`,
  });
});

export const runKinMigrations = Effect.fn("KinMigrations.run")(function* () {
  yield* refuseSkippedMigrations();
  return yield* run({ table, loader });
});
