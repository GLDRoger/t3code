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
import GeneratedDocuments from "./migrations/K070_GeneratedDocuments.ts";
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
const loader = Migrator.fromRecord({
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
  "70_GeneratedDocuments": GeneratedDocuments,
});

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
