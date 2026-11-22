// @effect-diagnostics nodeBuiltinImport:off -- each case copies one migrated database file.
import K021PushDevices from "./migrations/K021_PushDevices.ts";
import PeopleInvitesMigration from "./migrations/K038_PeopleInvites.ts";
import ChatGrantsLapse from "./migrations/K055_ChatGrantsLapse.ts";
import K058Work from "./migrations/K058_Work.ts";
import K059WorkerWithdrawals from "./migrations/K059_WorkerWithdrawals.ts";
import K060WorkClients from "./migrations/K060_WorkClients.ts";
import K061WorkerAttempts from "./migrations/K061_WorkerAttempts.ts";
import K062WorkerPublishApproval from "./migrations/K062_WorkerPublishApproval.ts";
import K063LegacyWorkerAttempts from "./migrations/K063_LegacyWorkerAttempts.ts";
import K064AgentRetirement from "./migrations/K064_AgentRetirement.ts";
import K065WakeupRetired from "./migrations/K065_WakeupRetired.ts";
import K066WakeupsUnretiredIndex from "./migrations/K066_WakeupsUnretiredIndex.ts";
import K067Docs from "./migrations/K067_Docs.ts";
import K068WorkMoney from "./migrations/K068_WorkMoney.ts";
import K069WorkerNetwork from "./migrations/K069_WorkerNetwork.ts";
import K071OwnerAnswerCards from "./migrations/K071_OwnerAnswerCards.ts";
import K072GeneratedDocuments from "./migrations/K072_GeneratedDocuments.ts";
import K073KeyPushes from "./migrations/K073_KeyPushes.ts";
import K074DocJobCleanup from "./migrations/K074_DocJobCleanup.ts";
import K075ServerRenderedDocuments from "./migrations/K075_ServerRenderedDocuments.ts";
import K077DocumentLabels from "./migrations/K077_DocumentLabels.ts";
import K079ImportRuns from "./migrations/K079_ImportRuns.ts";
import K088MoneyRecords from "./migrations/K088_MoneyRecords.ts";
import K107Connections from "./migrations/K107_Connections.ts";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, beforeAll, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "../../persistence/Migrations.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { PreparedJson } from "../connections/Sending.ts";
import { kinMigrations, runKinMigrations } from "./KinMigrations.ts";
import * as KinPersistence from "./KinPersistence.ts";

const decodePrepared = Schema.decodeSync(PreparedJson);

const tableNames = [
  "kin_agent_defaults",
  "kin_agent_threads",
  "kin_agents",
  "kin_amount_notices",
  "kin_approver_key_confirmations",
  "kin_approver_keys",
  "kin_audit",
  "kin_auth_key_repairs",
  "kin_auth_paired_sessions",
  "kin_auth_session_keys",
  "kin_bank_statement_entries",
  "kin_bank_statements",
  "kin_budget",
  "kin_budget_charges",
  "kin_budget_limits",
  "kin_card_plans",
  "kin_chat_levels",
  "kin_chat_members",
  "kin_chats",
  "kin_client_touches",
  "kin_company_profile",
  "kin_connection_asks",
  "kin_connection_calls",
  "kin_connection_cursors",
  "kin_connection_tools",
  "kin_connection_turn_spend",
  "kin_connections",
  "kin_cursor",
  "kin_deferral_runs",
  "kin_discussions",
  "kin_doc_files",
  "kin_doc_job_figures",
  "kin_doc_jobs",
  "kin_doc_versions",
  "kin_dream_charges",
  "kin_dream_runs",
  "kin_event_outside",
  "kin_events",
  "kin_executions",
  "kin_floor_grants",
  "kin_floor_notices",
  "kin_floor_runs",
  "kin_github_agent_pulls",
  "kin_github_branch_guards",
  "kin_github_handled",
  "kin_github_owner_uses",
  "kin_github_repo_prefs",
  "kin_github_watch",
  "kin_grants",
  "kin_handoffs",
  "kin_held_posts",
  "kin_holds",
  "kin_import_runs",
  "kin_issued_numbers",
  "kin_key_pushes",
  "kin_lead_access",
  "kin_lead_deliveries",
  "kin_lead_tool_calls",
  "kin_leads",
  "kin_list_proposals",
  "kin_memory_heads",
  "kin_memory_labels",
  "kin_memory_reads",
  "kin_memory_shared_writes",
  "kin_message_attachments",
  "kin_message_names",
  "kin_messages",
  "kin_money_budget_receipts",
  "kin_money_budgets",
  "kin_number_series",
  "kin_org_state",
  "kin_orgs",
  "kin_pending_actions",
  "kin_people",
  "kin_people_invites",
  "kin_ping_deliveries",
  "kin_ping_escalations",
  "kin_ping_items",
  "kin_ping_ledger",
  "kin_pr_review_posts",
  "kin_profile_changes",
  "kin_pull_requests",
  "kin_pulse_facts",
  "kin_pulse_nudges",
  "kin_pulse_seeds",
  "kin_pulse_told",
  "kin_push_devices",
  "kin_push_rings",
  "kin_questions",
  "kin_reach_limits",
  "kin_reaction_wakes",
  "kin_reactions",
  "kin_read_state",
  "kin_receipt_proposals",
  "kin_recipe_defaults",
  "kin_recipe_label_baselines",
  "kin_recipe_labels",
  "kin_recommendations",
  "kin_record_changes",
  "kin_record_comment_files",
  "kin_record_comments",
  "kin_record_cursors",
  "kin_record_links",
  "kin_record_payments",
  "kin_records",
  "kin_registers",
  "kin_retirement_holds",
  "kin_routine_folds",
  "kin_routine_preferences",
  "kin_scheduled_tasks",
  "kin_schedules",
  "kin_search",
  "kin_search_config",
  "kin_search_content",
  "kin_search_data",
  "kin_search_docsize",
  "kin_search_idx",
  "kin_search_rows",
  "kin_secret_allow",
  "kin_session_bindings",
  "kin_shadow_entries",
  "kin_social_groups",
  "kin_social_posts",
  "kin_statement_password_budget",
  "kin_statement_passwords",
  "kin_task_charges",
  "kin_tasks_keys",
  "kin_team_agents",
  "kin_team_memory",
  "kin_team_seqs",
  "kin_trigger_fires",
  "kin_trigger_inbox",
  "kin_trigger_settings",
  "kin_triggers",
  "kin_trouble_agents",
  "kin_troubles",
  "kin_turn_figures",
  "kin_visual_hosts",
  "kin_waiting",
  "kin_wakeup_outside_reads",
  "kin_wakeup_sensitive_reads",
  "kin_wakeups",
  "kin_watch_looks",
  "kin_watches",
  "kin_widgets",
  "kin_worker_attempts",
  "kin_worker_charges",
  "kin_worker_network",
  "kin_workers",
];
const timestamp = "2026-11-07T00:00:00.000Z";
// What hosts already ran, frozen: never edit it to add a migration.
const shipped = [
  [1, "ChatCore"],
  [2, "Lead"],
  [3, "Triggers"],
  [4, "MemoryReads"],
  [5, "OneChatOwner"],
  [6, "Pings"],
  [7, "Budget"],
  [8, "Floor"],
  [9, "JudgeLog"],
  [10, "ChatChanges"],
  [11, "MemoryHeads"],
  [12, "SecretAllow"],
  [13, "Routines"],
  [14, "LeadToolCalls"],
  [15, "AuthSessionKeys"],
  [16, "DeferralRuns"],
  [17, "Workers"],
  [18, "Dreams"],
  [19, "WebhookSecretHash"],
  [20, "Approvals"],
  [21, "PushDevices"],
  [22, "ChatLevels"],
  [23, "ExecutionWriteStarted"],
  [24, "MemoryReviewPulls"],
  [25, "FloorGrantWakeup"],
  [26, "Reactions"],
  [27, "AuthorityBinding"],
  [28, "WakeupTimings"],
  [29, "DropJudgeLog"],
  [30, "ManyLeads"],
  [31, "LeadDeliveries"],
  [32, "WorkerEnvironment"],
  [33, "ApproverKeyConfirmations"],
  [34, "PerLeadWakeups"],
  [35, "RetireLevelCards"],
  [38, "PeopleInvites"],
  [39, "LeadHandoffs"],
  [40, "MessageAttachments"],
  [41, "GroupLead"],
  [42, "ReactionWakes"],
  [43, "WakeupAudience"],
  [44, "WakeupSharedSince"],
  [45, "WakeupAudienceAbort"],
  [46, "ChatCleared"],
  [47, "SilentMessages"],
  [50, "LeadAccess"],
  [51, "ChatSharing"],
  [52, "MemoryLabels"],
  [53, "MemorySharing"],
  [54, "SharedProjection"],
  [55, "ChatGrantsLapse"],
  [56, "SuggestionsByVersion"],
  [57, "Schedules"],
  [58, "Work"],
  [59, "WorkerWithdrawals"],
  [60, "WorkClients"],
  [61, "WorkerAttempts"],
  [62, "WorkerPublishApproval"],
  [63, "LegacyWorkerAttempts"],
  [64, "AgentRetirement"],
  [65, "WakeupRetired"],
  [66, "WakeupsUnretiredIndex"],
  [67, "Docs"],
  [68, "WorkMoney"],
  [69, "WorkerNetwork"],
  [70, "VisualHosts"],
  [71, "OwnerAnswerCards"],
  [72, "GeneratedDocuments"],
  [73, "KeyPushes"],
  [74, "DocJobCleanup"],
  [75, "ServerRenderedDocuments"],
  [76, "DocFiles"],
  [77, "DocumentLabels"],
  [78, "RecipeLabelBaselines"],
  [79, "ImportRuns"],
  [80, "RecordRequestHash"],
  [81, "RecipeJobPasses"],
  [82, "BankStatements"],
  [83, "StatementSafety"],
  [84, "RecipeDefaults"],
  [85, "StatementReading"],
  [86, "StatementChatPasswords"],
  [87, "TeamWork"],
  [88, "MoneyRecords"],
  [106, "ChatThreads"],
  [107, "Connections"],
  [110, "BudgetNotices"],
  [130, "ConnectionPause"],
  [131, "ReceiptProposalsPasswordBudget"],
  [132, "PeopleProfiles"],
  [133, "MoneyBudgets"],
  [134, "ConnectionSignIn"],
  [135, "PulseFacts"],
  [136, "ConnectionAsks"],
  [137, "PersonAccess"],
  [138, "PulseCheckIns"],
  [139, "ClientTouches"],
  [140, "AssignedByAgent"],
  [141, "ConnectionAccounts"],
  [142, "MicrosoftConnections"],
  [143, "PersonPlaces"],
  [144, "PullRequestCare"],
  [145, "RetireRoutines"],
  [146, "SendDecidedBy"],
  [147, "SendOwesCard"],
  [148, "EventReplied"],
  [149, "SendAccount"],
  [150, "PersonRemoved"],
  [151, "ToldAndHeld"],
  [152, "MessageForm"],
  [153, "HeldRelays"],
  [154, "TeamDiscussions"],
  [155, "TalkStyle"],
  [156, "NamedKeys"],
  [157, "AgentSettings"],
  [158, "PrivateBy"],
  [159, "OpenQuestions"],
  [160, "GitHubWatch"],
  [161, "Social"],
  [162, "PersonHours"],
  [163, "OneModel"],
  [164, "WorkersRetired"],
  [165, "HandedBack"],
  [166, "GitHubAppRetired"],
  [167, "TeamMemorySetting"],
  [168, "GitHubOwnerUses"],
  [169, "AwayAndWhen"],
  [170, "OneSocialProfile"],
  [171, "GitHubBranchGuards"],
  [172, "CalendarCursor"],
  [173, "NoMemoryReviewPulls"],
  [174, "AnswerPages"],
  [175, "HandoffWantsAnswer"],
  [176, "RecordComments"],
  [177, "RecordChangesByWakeup"],
  [178, "AskOutsideAndDispatch"],
  [179, "DeviceLinks"],
  [180, "CardPlans"],
  [181, "TasksKeys"],
  [182, "HandoffRoutes"],
  [183, "TasksKeyMakers"],
  [184, "Recommendations"],
  [185, "AskedFor"],
  [186, "TasksKeysWithoutMaker"],
  [187, "Holds"],
  [188, "ReachLimits"],
  [189, "MorningPages"],
  [190, "RecordTitleIndex"],
] as const;
const kinMigrationsFrom = (from: number) => kinMigrations.filter(([id]) => id >= from);
const historyOf = (list: typeof kinMigrations) =>
  list.map(([migration_id, name]) => ({ migration_id, name }));
const freshLayer = Layer.provideMerge(KinPersistence.layer, Sqlite.layerMemory);

const tempDir = Effect.acquireRelease(
  Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kin-migrations-"))),
  (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
);

// Migrating is most of a case's time, so each case opens its own copy of one migrated database.
const migratedFile = Deferred.makeUnsafe<string>();
beforeAll(() =>
  Effect.gen(function* () {
    const file = NodePath.join(yield* tempDir, "migrated.sqlite");
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`VACUUM INTO ${file}`;
    }).pipe(Effect.provide(freshLayer));
    yield* Deferred.succeed(migratedFile, file);
  }),
);

// The one setting of the server's setup that changes what a case can write.
const foreignKeysOn = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA foreign_keys = ON`;
  }),
);

const layer = Layer.unwrap(
  Effect.gen(function* () {
    const file = NodePath.join(yield* tempDir, "kin.sqlite");
    NodeFS.copyFileSync(yield* Deferred.await(migratedFile), file);
    return Layer.provideMerge(
      KinPersistence.layer,
      Layer.provideMerge(foreignKeysOn, NodeSqliteClient.layer({ filename: file })),
    );
  }),
);

const kinSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ name: string; sql: string }>`
    SELECT name, sql FROM sqlite_master
    WHERE type = 'table' AND name GLOB 'kin_*' AND name != 'kin_sql_migrations'
    ORDER BY name
  `;
});

const kinHistory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ migration_id: number; name: string }>`
    SELECT migration_id, name FROM kin_sql_migrations ORDER BY migration_id
  `;
});

const upstreamHistory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ migration_id: number; name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
});

const undoPeopleInvites = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP TABLE kin_handoffs`;
  yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id = 39`;
  yield* sql`DROP TABLE kin_people_invites`;
  yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id = 38`;
});

// K010 puts `change_seq` back last, so this column has to follow it again.
const undoMessageAttachments = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE kin_messages DROP COLUMN attachments_json`;
  yield* sql`DROP TABLE kin_message_attachments`;
});

// Like the attachments column: K010 rebuilds `kin_chats`' `change_seq` after these.
const undoGroupLead = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE kin_chats DROP COLUMN lead_agent_id`;
  yield* sql`ALTER TABLE kin_chats DROP COLUMN cleared_change_seq`;
  yield* sql`ALTER TABLE kin_chats DROP COLUMN cleared_seq`;
});

// K028 adds the timing columns after it on a rerun, so this one has to follow them again.
const undoWakeupAudience = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP INDEX IF EXISTS idx_kin_wakeups_unretired_agent`;
  yield* sql`ALTER TABLE kin_wakeups DROP COLUMN retired_at`;
  yield* sql`ALTER TABLE kin_wakeups DROP COLUMN settled_at`;
  yield* sql`ALTER TABLE kin_wakeups DROP COLUMN aborted_at`;
  yield* sql`ALTER TABLE kin_wakeups DROP COLUMN shared_since`;
  yield* sql`ALTER TABLE kin_wakeups DROP COLUMN audience`;
});

// Earlier migrations add their own columns to these tables again on a rerun; K051 follows them.
const undoChatSharing = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE kin_workers DROP COLUMN moved_at`;
  yield* sql`ALTER TABLE kin_workers DROP COLUMN context`;
  yield* sql`ALTER TABLE kin_chat_members DROP COLUMN joined_seq`;
  yield* sql`ALTER TABLE kin_chats DROP COLUMN shared_from_seq`;
  yield* sql`ALTER TABLE kin_chats DROP COLUMN shared_at`;
});

const undoChatPins = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE kin_chat_members DROP COLUMN pinned_at`;
});

const undoTaskSteps = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const column of ["steps_json", "urgent"])
    yield* sql`ALTER TABLE kin_records DROP COLUMN ${sql.literal(column)}`;
});

const undoSentUpDrafts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const column of ["draft_json", "approved_at", "draft_made_json"])
    yield* sql`ALTER TABLE kin_questions DROP COLUMN ${sql.literal(column)}`;
});

const undoApproverKeyConfirmations = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP TABLE kin_approver_key_confirmations`;
  yield* sql`ALTER TABLE kin_approver_keys DROP COLUMN pending_seal`;
});

// Puts back what K055 left, for the label migrations' tests to start from.
const undoSuggestionsByVersion = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE kin_memory_labels RENAME COLUMN suggested_at TO suggested_rev`;
  yield* sql`CREATE TABLE kin_memory_label_revisions (
    org_id TEXT NOT NULL PRIMARY KEY REFERENCES kin_orgs(org_id),
    revision INTEGER NOT NULL CHECK (revision >= 0)
  )`;
});

describe("Kin migrations", () => {
  it.effect(
    "creates K001, K002 and K003 in their own track after upstream and reruns without changes",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const before = yield* kinSchema;
        const upstreamBefore = yield* upstreamHistory;
        assert.deepStrictEqual(
          before.map((row) => row.name),
          tableNames,
        );
        assert.deepStrictEqual(yield* kinHistory, historyOf(kinMigrations));
        assert.deepStrictEqual(
          upstreamBefore.map((row) => [row.migration_id, row.name] as const),
          migrationManifest,
        );
        for (const [table, names] of [
          ["kin_triggers", ["next_run_at", "created_at", "updated_at"]],
          ["kin_auth_session_keys", ["created_at", "repaired_at"]],
          ["kin_auth_key_repairs", ["created_at", "consumed_at"]],
          ["kin_auth_paired_sessions", ["created_at"]],
          ["kin_trigger_fires", ["fired_at"]],
          ["kin_dream_runs", ["material_from", "material_until", "started_at", "ended_at"]],
          ["kin_trigger_inbox", ["received_at", "consumed_at"]],
          ["kin_ping_ledger", ["pinged_at", "escalated_at"]],
          ["kin_floor_runs", ["opened_at"]],
          ["kin_floor_grants", ["expires_at", "consumed_at"]],
          ["kin_floor_notices", ["posted_at"]],
          ["kin_pending_actions", ["created_at", "updated_at", "expires_at"]],
          ["kin_grants", ["accepted_at", "consumed_at"]],
          ["kin_executions", ["started_at", "finished_at"]],
          ["kin_push_devices", ["created_at", "updated_at"]],
          ["kin_chat_levels", ["level_since"]],
          ["kin_reactions", ["created_at", "removed_at", "woke_at"]],
        ] as const) {
          const columns = yield* sql<{ name: string; type: string }>`
            SELECT name, type FROM pragma_table_info(${table})
          `;
          for (const name of names) {
            assert.strictEqual(columns.find((column) => column.name === name)?.type, "INTEGER");
          }
        }
        // The search index's FTS5 tables carry no org: each row is reached through kin_search_rows.
        for (const { name } of before.filter(
          (row) =>
            ![
              "kin_auth_session_keys",
              "kin_auth_key_repairs",
              "kin_auth_paired_sessions",
              "kin_search",
            ].includes(row.name) && !row.name.startsWith("kin_search_"),
        )) {
          const columns = yield* sql<{ name: string; notnull: number }>`
          SELECT name, "notnull" FROM pragma_table_info(${name})
        `;
          assert.deepStrictEqual(
            columns.find((column) => column.name === "org_id"),
            {
              name: "org_id",
              notnull: 1,
            },
          );
        }
        yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES ('org', 'Kin', ${timestamp})`;
        assert.deepStrictEqual(yield* runKinMigrations(), []);
        assert.deepStrictEqual(yield* runKinMigrations(), []);
        assert.deepStrictEqual(yield* kinSchema, before);
        assert.deepStrictEqual(yield* kinHistory, historyOf(kinMigrations));
        assert.deepStrictEqual(yield* upstreamHistory, upstreamBefore);
        assert.deepStrictEqual(yield* sql`SELECT * FROM kin_orgs`, [
          { org_id: "org", name: "Kin", created_at: timestamp },
        ]);
        assert.deepStrictEqual(
          yield* sql`SELECT name FROM pragma_index_info('idx_kin_triggers_due') ORDER BY seqno`,
          ["next_run_at", "org_id", "trigger_id"].map((name) => ({ name })),
        );
        assert.deepStrictEqual(
          yield* sql`SELECT name FROM pragma_index_info('kin_workers_owner_review') ORDER BY seqno`,
          ["org_id", "ended_at", "worker_id"].map((name) => ({ name })),
        );
        const indexes = yield* sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'index' AND name GLOB 'idx_kin_*' ORDER BY name
      `;
        assert.deepStrictEqual(indexes, [
          { name: "idx_kin_agents_org_agent" },
          { name: "idx_kin_auth_session_keys_revoked" },
          { name: "idx_kin_chat_members_agent" },
          { name: "idx_kin_chat_members_person" },
          { name: "idx_kin_chats_org_chat" },
          { name: "idx_kin_client_touches_party" },
          { name: "idx_kin_connection_calls_connection" },
          { name: "idx_kin_connection_calls_wakeup" },
          { name: "idx_kin_doc_versions_file" },
          { name: "idx_kin_dream_runs_material" },
          { name: "idx_kin_events_dedupe" },
          { name: "idx_kin_events_held_by" },
          { name: "idx_kin_events_queue" },
          { name: "idx_kin_events_wakeup" },
          { name: "idx_kin_floor_grant_scope" },
          { name: "idx_kin_floor_latest" },
          { name: "idx_kin_floor_notices_rate" },
          { name: "idx_kin_floor_open" },
          { name: "idx_kin_lead_access_person" },
          { name: "idx_kin_lead_deliveries_pending" },
          { name: "idx_kin_leads_org_domain" },
          { name: "idx_kin_messages_agent_thread" },
          { name: "idx_kin_messages_changes" },
          { name: "idx_kin_pending_actions_approved" },
          { name: "idx_kin_pending_actions_expiry" },
          { name: "idx_kin_pending_actions_org_state" },
          { name: "idx_kin_people_one_owner" },
          { name: "idx_kin_people_org_person" },
          { name: "idx_kin_ping_items_item" },
          { name: "idx_kin_ping_items_pending" },
          { name: "idx_kin_pr_review_posts_widget" },
          { name: "idx_kin_pull_requests_state" },
          { name: "idx_kin_pulse_facts_open" },
          { name: "idx_kin_push_devices_person" },
          { name: "idx_kin_reaction_wakes_chat" },
          { name: "idx_kin_reactions_woke" },
          { name: "idx_kin_record_changes_org" },
          { name: "idx_kin_record_changes_record" },
          { name: "idx_kin_record_changes_wakeup" },
          { name: "idx_kin_record_links_target" },
          { name: "idx_kin_record_payments_paid" },
          { name: "idx_kin_record_payments_record" },
          { name: "idx_kin_records_date" },
          { name: "idx_kin_records_due" },
          { name: "idx_kin_records_number" },
          { name: "idx_kin_records_owner" },
          { name: "idx_kin_records_owner_list" },
          { name: "idx_kin_records_party" },
          { name: "idx_kin_records_project" },
          { name: "idx_kin_records_register" },
          { name: "idx_kin_records_repo" },
          { name: "idx_kin_records_state_due" },
          { name: "idx_kin_records_title" },
          { name: "idx_kin_shadow_entries_promotion" },
          { name: "idx_kin_shadow_entries_review" },
          { name: "idx_kin_social_groups_party" },
          { name: "idx_kin_social_groups_profile" },
          { name: "idx_kin_social_posts_card" },
          { name: "idx_kin_social_posts_state" },
          { name: "idx_kin_tasks_keys_person" },
          { name: "idx_kin_trigger_fires_retention" },
          { name: "idx_kin_trigger_inbox_pending" },
          { name: "idx_kin_trigger_inbox_retention" },
          { name: "idx_kin_triggers_due" },
          { name: "idx_kin_troubles_open" },
          { name: "idx_kin_waiting_open_widget_person" },
          { name: "idx_kin_waiting_person_resolved_at" },
          { name: "idx_kin_wakeups_running_lead" },
          { name: "idx_kin_wakeups_started" },
          { name: "idx_kin_wakeups_unretired_agent" },
          { name: "idx_kin_watch_looks_at" },
          { name: "idx_kin_watch_looks_watch" },
          { name: "idx_kin_watches_due" },
          { name: "idx_kin_watches_record" },
          { name: "idx_kin_widgets_chat_message" },
          { name: "idx_kin_widgets_type_closed_at" },
          { name: "idx_kin_worker_attempts_ready" },
          { name: "idx_kin_worker_attempts_withdrawn_source" },
          { name: "idx_kin_workers_status" },
        ]);
        assert.deepStrictEqual(
          yield* sql`SELECT name FROM pragma_index_info('idx_kin_events_queue') ORDER BY seqno`,
          ["org_id", "agent_id", "state", "priority", "received_at", "not_before"].map((name) => ({
            name,
          })),
        );
        assert.deepStrictEqual(
          yield* sql`SELECT name FROM pragma_index_info('idx_kin_shadow_entries_promotion') ORDER BY seqno`,
          ["org_id", "agent_id", "unlocks_level", "verdict"].map((name) => ({ name })),
        );
        assert.deepStrictEqual(
          yield* sql`SELECT name FROM pragma_index_info('idx_kin_widgets_type_closed_at') ORDER BY seqno`,
          [{ name: "type" }, { name: "closed_at" }],
        );
        assert.deepStrictEqual(
          yield* sql`SELECT name FROM pragma_index_info('idx_kin_waiting_person_resolved_at') ORDER BY seqno`,
          [{ name: "person_id" }, { name: "resolved_at" }],
        );
      }).pipe(Effect.provide(freshLayer)),
  );

  it.effect("also migrates before upstream without creating or changing upstream history", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA foreign_keys = ON`;
      assert.deepStrictEqual(yield* runKinMigrations(), kinMigrations);
      const before = yield* kinSchema;
      assert.deepStrictEqual(
        before.map((row) => row.name),
        tableNames,
      );
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'effect_sql_migrations'`,
        [],
      );
      yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES ('org', 'Kin', ${timestamp})`;
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
        VALUES ('owner', 'org', 'owner', 'Owner', ${timestamp})`;
      yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at)
        VALUES ('existing-chat', 'org', 'project_group', 0, ${timestamp})`;
      yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
        VALUES ('existing-owner', 'org', 'existing-chat', 'person', 'owner', 'owner', ${timestamp})`;
      for (const trigger of [
        "kin_message_insert_change",
        "kin_message_update_change",
        "kin_widget_insert_change",
        "kin_widget_update_change",
        "kin_widget_delete_change",
      ])
        yield* sql.unsafe(`DROP TRIGGER ${trigger}`);
      yield* sql`DROP INDEX idx_kin_messages_changes`;
      yield* sql`DROP INDEX kin_message_wakeup_cards`;
      yield* sql`DROP INDEX idx_kin_record_changes_wakeup`;
      yield* sql`ALTER TABLE kin_tasks_keys DROP COLUMN made_by_session_id`;
      yield* sql`ALTER TABLE kin_handoffs DROP COLUMN asked_message_id`;
      yield* sql`ALTER TABLE kin_handoffs DROP COLUMN route_widget_id`;
      yield* sql`ALTER TABLE kin_handoffs DROP COLUMN route_state`;
      yield* sql`ALTER TABLE kin_messages DROP COLUMN origin_json`;
      yield* sql`ALTER TABLE kin_handoffs DROP COLUMN wants_answer`;
      yield* sql`ALTER TABLE kin_messages DROP COLUMN source_wakeup_id`;
      yield* sql`ALTER TABLE kin_messages DROP COLUMN embeds_json`;
      yield* sql`ALTER TABLE kin_messages DROP COLUMN when_json`;
      yield* sql`ALTER TABLE kin_messages DROP COLUMN form`;
      yield* sql`ALTER TABLE kin_messages DROP COLUMN relay_json`;
      yield* sql`ALTER TABLE kin_messages DROP COLUMN discussion_id`;
      yield* sql`ALTER TABLE kin_messages DROP COLUMN refs_json`;
      yield* sql`ALTER TABLE kin_messages DROP COLUMN silent`;
      yield* sql`ALTER TABLE kin_messages DROP COLUMN change_seq`;
      yield* sql`ALTER TABLE kin_chats DROP COLUMN change_seq`;
      // K194 dropped it; K019 alters it as K003 made it.
      yield* sql`CREATE TABLE kin_webhook_sources (
        source_id TEXT NOT NULL,
        org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
        repo TEXT NOT NULL,
        scheduled_task_id TEXT NOT NULL UNIQUE,
        inbox_thread_id TEXT NOT NULL,
        github_hook_id INTEGER,
        bot_login TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'paused_in_t3', 'blocked_by_policy', 'missing')),
        PRIMARY KEY (org_id, source_id),
        UNIQUE (org_id, repo)
      )`;
      yield* sql`DROP TABLE kin_dream_runs`;
      yield* sql`DROP TABLE kin_deferral_runs`;
      yield* sql`DROP TABLE kin_auth_paired_sessions`;
      yield* sql`DROP TABLE kin_auth_key_repairs`;
      yield* sql`DROP TABLE kin_auth_session_keys`;
      yield* sql`DROP TABLE kin_worker_charges`;
      yield* sql`ALTER TABLE kin_workers DROP COLUMN target_pr`;
      yield* sql`ALTER TABLE kin_workers DROP COLUMN target_branch`;
      yield* sql`ALTER TABLE kin_workers DROP COLUMN environment_id`;
      yield* sql`ALTER TABLE kin_workers DROP COLUMN remote_project_id`;
      yield* sql`ALTER TABLE kin_workers DROP COLUMN repository_key`;
      yield* sql`ALTER TABLE kin_workers DROP COLUMN pull_request_url`;
      yield* sql`ALTER TABLE kin_workers DROP COLUMN pull_request_number`;
      yield* sql`ALTER TABLE kin_workers DROP COLUMN project_id`;
      yield* sql`ALTER TABLE kin_workers DROP COLUMN title`;
      yield* sql`ALTER TABLE kin_workers DROP COLUMN chat_id`;
      yield* sql`DROP TABLE kin_floor_notices`;
      yield* sql`DROP TABLE kin_floor_grants`;
      yield* sql`DROP TABLE kin_floor_runs`;
      yield* sql`DROP TABLE kin_ping_deliveries`;
      yield* sql`DROP TABLE kin_ping_escalations`;
      yield* sql`DROP TABLE kin_ping_items`;
      yield* sql`DROP INDEX kin_chat_members_one_owner`;
      yield* sql`DROP TABLE kin_lead_tool_calls`;
      yield* sql`DROP TABLE kin_memory_heads`;
      yield* sql`DROP TABLE kin_secret_allow`;
      yield* sql`DROP INDEX kin_workers_owner_review`;
      yield* sql`DROP TABLE kin_routine_folds`;
      yield* sql`DROP TABLE kin_routine_preferences`;
      yield* sql`DROP TABLE kin_budget_charges`;
      yield* sql`DROP TABLE kin_lead_deliveries`;
      yield* sql`DROP TABLE kin_scheduled_tasks`;
      yield* sql`DROP INDEX idx_kin_events_held_by`;
      yield* sql`ALTER TABLE kin_events DROP COLUMN held_by`;
      yield* sql`ALTER TABLE kin_events DROP COLUMN replied_at`;
      yield* sql`ALTER TABLE kin_events DROP COLUMN budget_deferred`;
      for (const column of [
        "enqueued_at",
        "prepared_at",
        "launched_at",
        "first_token_at",
        "posted_at",
        "resumed",
      ])
        yield* sql`ALTER TABLE kin_wakeups DROP COLUMN ${sql(column)}`;
      yield* sql`DROP INDEX idx_kin_wakeups_running_lead`;
      yield* sql`CREATE UNIQUE INDEX idx_kin_wakeups_running_org ON kin_wakeups(org_id) WHERE status = 'running'`;
      yield* sql`DROP INDEX idx_kin_leads_org_domain`;
      yield* sql`DROP TABLE kin_lead_access`;
      for (const column of [
        "role_tags_json",
        "public_intro",
        "domain",
        "charter",
        "created_by_person_id",
      ])
        yield* sql`ALTER TABLE kin_leads DROP COLUMN ${sql(column)}`;
      for (const table of [
        "kin_reaction_wakes",
        "kin_reactions",
        "kin_chat_levels",
        "kin_push_devices",
        "kin_executions",
        "kin_grants",
        "kin_pending_actions",
        "kin_approver_key_confirmations",
        "kin_approver_keys",
        "kin_audit",
      ]) {
        yield* sql`DROP TABLE ${sql(table)}`;
      }
      yield* sql`UPDATE kin_chats SET last_seq = 1 WHERE org_id = 'org' AND chat_id = 'existing-chat'`;
      yield* sql`INSERT INTO kin_messages (org_id, chat_id, message_id, seq, author_kind, author_role, kind, body, mentions_json, status, created_at)
        VALUES ('org', 'existing-chat', 'existing-message', 1, 'system', 'member', 'system', 'Before upgrade', '[]', 'posted', ${timestamp})`;
      yield* undoPeopleInvites;
      yield* undoMessageAttachments;
      yield* undoGroupLead;
      yield* undoWakeupAudience;
      yield* undoChatSharing;
      yield* undoChatPins;
      yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 5`;
      assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(5));
      assert.deepStrictEqual(
        yield* sql`SELECT member_id FROM kin_chat_members WHERE org_id = 'org' ORDER BY member_id`,
        [{ member_id: "existing-owner" }],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT change_seq FROM kin_chats WHERE org_id = 'org' ORDER BY chat_id`,
        [{ change_seq: 2 }],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT change_seq FROM kin_messages WHERE org_id = 'org' ORDER BY seq`,
        [{ change_seq: 2 }],
      );
      yield* sql`UPDATE kin_messages SET body = 'After upgrade' WHERE org_id = 'org' AND message_id = 'existing-message'`;
      assert.deepStrictEqual(
        yield* sql`SELECT change_seq FROM kin_messages WHERE org_id = 'org' ORDER BY seq`,
        [{ change_seq: 3 }],
      );
      yield* runMigrations();
      assert.deepStrictEqual(
        (yield* upstreamHistory).map((row) => [row.migration_id, row.name] as const),
        migrationManifest,
      );
      assert.deepStrictEqual(yield* kinSchema, before);
      assert.deepStrictEqual(yield* kinHistory, historyOf(kinMigrations));
      assert.deepStrictEqual(yield* runKinMigrations(), []);
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* sql`SELECT org_id FROM kin_orgs`, [{ org_id: "org" }]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("K027 keeps the sessions of paired devices and leaves out CLI-issued ones", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DROP TABLE kin_auth_paired_sessions`;
      yield* sql`DROP TABLE kin_approver_key_confirmations`;
      yield* sql`ALTER TABLE kin_approver_keys DROP COLUMN pending_seal`;
      yield* sql`ALTER TABLE kin_approver_keys DROP COLUMN seal`;
      for (const column of [
        "enqueued_at",
        "prepared_at",
        "launched_at",
        "first_token_at",
        "posted_at",
        "resumed",
      ])
        yield* sql`ALTER TABLE kin_wakeups DROP COLUMN ${sql(column)}`;
      yield* sql`DROP INDEX idx_kin_wakeups_running_lead`;
      yield* sql`CREATE UNIQUE INDEX idx_kin_wakeups_running_org ON kin_wakeups(org_id) WHERE status = 'running'`;
      yield* sql`DROP INDEX idx_kin_leads_org_domain`;
      yield* sql`DROP TABLE kin_lead_access`;
      for (const column of [
        "role_tags_json",
        "public_intro",
        "domain",
        "charter",
        "created_by_person_id",
      ])
        yield* sql`ALTER TABLE kin_leads DROP COLUMN ${sql(column)}`;
      yield* sql`DROP TABLE kin_lead_deliveries`;
      yield* sql`DROP TABLE kin_scheduled_tasks`;
      yield* sql`ALTER TABLE kin_workers DROP COLUMN environment_id`;
      yield* sql`ALTER TABLE kin_workers DROP COLUMN remote_project_id`;
      yield* sql`ALTER TABLE kin_workers DROP COLUMN repository_key`;
      yield* sql`ALTER TABLE kin_workers DROP COLUMN pull_request_url`;
      yield* sql`ALTER TABLE kin_workers DROP COLUMN pull_request_number`;
      yield* sql`ALTER TABLE kin_workers DROP COLUMN project_id`;
      yield* undoPeopleInvites;
      yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 27`;
      for (const [id, subject, method, ip, revoked] of [
        ["phone", "one-time-token", "bearer-access-token", "100.64.0.7", null],
        ["desktop", "desktop-bootstrap", "bearer-access-token", "127.0.0.1", null],
        ["browser", "one-time-token", "browser-session-cookie", "192.168.1.20", null],
        ["relay", "cloud-connect", "dpop-access-token", null, null],
        ["cli", "cli-issued-session", "bearer-access-token", null, null],
        ["cli-renamed", "one-time-token", "bearer-access-token", null, null],
        ["mcp", "mcp-client", "bearer-access-token", "127.0.0.1", null],
        ["signed-out", "one-time-token", "bearer-access-token", "100.64.0.8", timestamp],
      ] as const) {
        yield* sql`INSERT INTO auth_sessions (session_id, subject, method, scopes,
            client_ip_address, issued_at, expires_at, revoked_at)
          VALUES (${id}, ${subject}, ${method}, '[]', ${ip}, ${timestamp},
            '2026-12-07T00:00:00.000Z', ${revoked})`;
      }
      assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(27));
      assert.deepStrictEqual(
        yield* sql`SELECT session_id, via FROM kin_auth_paired_sessions ORDER BY session_id`,
        [
          { session_id: "browser", via: "migration" },
          { session_id: "desktop", via: "migration" },
          { session_id: "phone", via: "migration" },
          { session_id: "relay", via: "migration" },
        ],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("K032 upgrades a database at K031_LeadDeliveries", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const workerColumns = [
        "environment_id",
        "project_id",
        "remote_project_id",
        "repository_key",
        "pull_request_url",
        "pull_request_number",
      ];
      for (const column of workerColumns)
        yield* sql`ALTER TABLE kin_workers DROP COLUMN ${sql(column)}`;
      yield* undoApproverKeyConfirmations;
      yield* sql`DROP INDEX idx_kin_wakeups_running_lead`;
      yield* sql`CREATE UNIQUE INDEX idx_kin_wakeups_running_org ON kin_wakeups(org_id) WHERE status = 'running'`;
      yield* undoPeopleInvites;
      yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 32`;
      assert.deepStrictEqual((yield* kinHistory).at(-1), {
        migration_id: 31,
        name: "LeadDeliveries",
      });
      assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(32));
      const columns = yield* sql<{ name: string }>`
        SELECT name FROM pragma_table_info('kin_workers')`;
      for (const column of workerColumns)
        assert.include(
          columns.map((row) => row.name),
          column,
        );
      assert.deepStrictEqual(yield* runKinMigrations(), []);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "K033 upgrades a database at K032_WorkerEnvironment and keeps its K031 and K032 rows",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const timestamp = 1_700_000_000_000;
        yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES ('org', 'Kin', ${timestamp})`;
        const delivery = {
          org_id: "org",
          event_id: "event",
          kind: "reminder",
          agent_id: "lead",
          chat_id: "chat",
          widget_id: "widget",
          widget_type: "reminder",
          state_json: "{}",
          fallback_body: "Reminder",
          deadline_at: timestamp,
          status: "pending",
          message_id: null,
          created_at: timestamp,
          updated_at: timestamp,
        };
        yield* sql`INSERT INTO kin_lead_deliveries ${sql.insert(delivery)}`;
        yield* undoApproverKeyConfirmations;
        yield* undoPeopleInvites;
        yield* sql`DROP INDEX idx_kin_wakeups_running_lead`;
        yield* sql`CREATE UNIQUE INDEX idx_kin_wakeups_running_org ON kin_wakeups(org_id) WHERE status = 'running'`;
        yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 33`;
        assert.deepStrictEqual((yield* kinHistory).slice(-2), [
          { migration_id: 31, name: "LeadDeliveries" },
          { migration_id: 32, name: "WorkerEnvironment" },
        ]);
        assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(33));
        assert.deepStrictEqual(
          (yield* kinHistory).slice(-kinMigrationsFrom(32).length),
          historyOf(kinMigrationsFrom(32)),
        );
        assert.deepStrictEqual(yield* sql`SELECT * FROM kin_lead_deliveries`, [delivery]);
        assert.deepStrictEqual(
          yield* sql`SELECT name FROM pragma_table_info('kin_workers') WHERE name = 'environment_id'`,
          [{ name: "environment_id" }],
        );
        assert.deepStrictEqual(
          yield* sql`SELECT name FROM pragma_table_info('kin_approver_keys') WHERE name = 'pending_seal'`,
          [{ name: "pending_seal" }],
        );
        assert.deepStrictEqual(
          yield* sql`SELECT name FROM sqlite_master WHERE name = 'kin_approver_key_confirmations'`,
          [{ name: "kin_approver_key_confirmations" }],
        );
        assert.deepStrictEqual(yield* runKinMigrations(), []);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("K035 takes the level cards out of chats and the Waiting list, and nothing else", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES ('org', 'Kin', ${timestamp})`;
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
        VALUES ('owner', 'org', 'owner', 'Owner', ${timestamp})`;
      yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at)
        VALUES ('dm', 'org', 'project_group', 4, ${timestamp})`;
      const cards = [
        ["promotion:lead:L1", "promotion"],
        ["shadow-review:lead:2026-11-09", "shadow_review"],
        ["shadow-summary:lead:2026-11-09", "shadow_summary"],
        ["routine:morning", "routine"],
      ] as const;
      for (const [index, [widgetId, type]] of cards.entries()) {
        yield* sql`INSERT INTO kin_messages (org_id, chat_id, message_id, seq, author_kind, author_role, kind, body, mentions_json, widget_id, status, created_at)
          VALUES ('org', 'dm', ${widgetId}, ${index + 1}, 'system', 'member', 'system', ${type}, '[]', ${widgetId}, 'posted', ${timestamp})`;
        yield* sql`INSERT INTO kin_widgets (widget_id, org_id, chat_id, message_id, widget_class, type, revision, state_json, awaiting_json, updated_at)
          VALUES (${widgetId}, 'org', 'dm', ${widgetId}, 'native', ${type}, 1, '{}', '[]', ${timestamp})`;
        yield* sql`INSERT INTO kin_waiting (waiting_id, org_id, person_id, chat_id, message_id, widget_id, reason, created_at)
          VALUES (${`waiting-${index}`}, 'org', 'owner', 'dm', ${widgetId}, ${widgetId}, 'decision', ${timestamp})`;
      }
      yield* sql`INSERT INTO kin_messages (org_id, chat_id, message_id, seq, author_kind, author_role, kind, body, mentions_json, status, created_at)
        VALUES ('org', 'dm', 'kin-level-lowered:e-1', 5, 'system', 'member', 'system', 'Lead moved down to L0', '[]', 'posted', ${timestamp})`;
      // K047: the failed-night notice every lead's chat got on 11 Nov 2026; other notices stay.
      for (const [seq, id, body] of [
        [
          6,
          "kin-memory:dream",
          "Last night's dream failed and merged nothing; the next dream retries the same material.\nThe dream session failed",
        ],
        [7, "kin-memory:other", "Recovered from remote head"],
      ] as const)
        yield* sql`INSERT INTO kin_messages (org_id, chat_id, message_id, seq, author_kind, author_role, kind, body, mentions_json, status, created_at)
          VALUES ('org', 'dm', ${id}, ${seq}, 'system', 'member', 'text', ${body}, '[]', 'posted', ${timestamp})`;
      yield* undoPeopleInvites;
      yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 35`;
      assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(35));
      assert.deepStrictEqual(yield* sql`SELECT message_id, status FROM kin_messages ORDER BY seq`, [
        { message_id: "promotion:lead:L1", status: "dismissed" },
        { message_id: "shadow-review:lead:2026-11-09", status: "dismissed" },
        { message_id: "shadow-summary:lead:2026-11-09", status: "dismissed" },
        { message_id: "routine:morning", status: "posted" },
        { message_id: "kin-level-lowered:e-1", status: "dismissed" },
        { message_id: "kin-memory:dream", status: "dismissed" },
        { message_id: "kin-memory:other", status: "posted" },
      ]);
      assert.deepStrictEqual(yield* sql`SELECT widget_id FROM kin_widgets`, [
        { widget_id: "routine:morning" },
      ]);
      assert.deepStrictEqual(yield* sql`SELECT waiting_id FROM kin_waiting`, [
        { waiting_id: "waiting-3" },
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "K051 shares a chat anyone besides the owner was ever in, from when they could read",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const at = (day: number) => `2026-11-0${day}T00:00:00.000Z`;
        yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES ('org', 'Kin', ${timestamp})`;
        for (const person of ["owner", "teammate"])
          yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
          VALUES (${person}, 'org', ${person}, ${person}, ${timestamp})`;
        for (const agent of ["lead", "lead-2"])
          yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
          VALUES (${agent}, 'org', ${agent}, 'lead', 'owner', ${timestamp})`;
        for (const chat of ["left", "leads"])
          yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at)
          VALUES (${chat}, 'org', 'team_group', 3, ${timestamp})`;
        const member = (
          chat: string,
          id: string,
          kind: string,
          principal: string,
          leftAt: string | null,
        ) =>
          sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id,
            agent_id, role, joined_at, left_at)
          VALUES (${id}, 'org', ${chat}, ${kind}, ${kind === "person" ? principal : null},
            ${kind === "agent" ? principal : null}, ${principal === "owner" ? "owner" : "member"}, ${at(kind === "person" && principal === "teammate" ? 3 : 1)},
            ${leftAt})`;
        // A teammate who joined after two messages and has since left; the other has only leads.
        yield* member("left", "left-owner", "person", "owner", null);
        yield* member("left", "left-teammate", "person", "teammate", at(5));
        yield* member("left", "left-lead", "agent", "lead", null);
        yield* member("leads", "leads-owner", "person", "owner", null);
        yield* member("leads", "leads-lead", "agent", "lead", null);
        yield* member("leads", "leads-lead-2", "agent", "lead-2", null);
        // A teammate's own chat with the owner's lead (K050): theirs from the start.
        yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
          VALUES ('mate-dm', 'org', 'direct', 'teammate:lead', 0, ${timestamp})`;
        yield* member("mate-dm", "mate-dm-teammate", "person", "teammate", null);
        yield* member("mate-dm", "mate-dm-lead", "agent", "lead", null);
        for (const chat of ["left", "leads"]) {
          for (const [seq, day] of [
            [1, 1],
            [2, 2],
            [3, 4],
          ] as const)
            yield* sql`INSERT INTO kin_messages (org_id, chat_id, message_id, seq, author_kind,
              author_person_id, author_member_id, author_role, kind, body, mentions_json, status, created_at)
            VALUES ('org', ${chat}, ${`${chat}-${seq}`}, ${seq}, 'human', 'owner', ${`${chat}-owner`}, 'owner', 'text',
              'Invented', '[]', 'posted', ${at(day)})`;
        }
        yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id)
        VALUES ('lead', 'org', 'Lead', 0, '{}', '[]', 'leads')`;
        for (const [wakeup, audience] of [
          ["shared-wake", "shared"],
          ["private-wake", "owner_only"],
          ["old-wake", null],
        ] as const)
          yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, model, started_at, status, event_ids, audience)
          VALUES (${wakeup}, 'org', 'lead', 'test', 0, 'completed', '[]', ${audience})`;
        for (const [worker, wakeup, chat, asker] of [
          ["shared", "shared-wake", "left", "owner"],
          ["private", "private-wake", "left", "owner"],
          ["asked-by-teammate", "old-wake", "leads", "teammate"],
          ["asked-by-owner", "old-wake", "leads", "owner"],
        ] as const)
          yield* sql`INSERT INTO kin_workers (worker_id, org_id, agent_id, wakeup_id, kind, thread_id, model_json, provenance_json, status, started_at, chat_id)
          VALUES (${worker}, 'org', 'lead', ${wakeup}, 'build', ${worker}, '{}',
            ${JSON.stringify({ _tag: "human", personId: asker, memberId: "m" })}, 'running', 0, ${chat})`;
        yield* undoChatSharing;
        yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 51`;
        assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(51));
        assert.deepStrictEqual(
          yield* sql`SELECT chat_id, shared_at IS NOT NULL AS shared, shared_from_seq FROM kin_chats ORDER BY chat_id`,
          [
            { chat_id: "leads", shared: 0, shared_from_seq: null },
            { chat_id: "left", shared: 1, shared_from_seq: 3 },
            { chat_id: "mate-dm", shared: 1, shared_from_seq: 1 },
          ],
        );
        assert.deepStrictEqual(
          yield* sql`SELECT member_id, joined_seq FROM kin_chat_members WHERE joined_seq <> 0 ORDER BY member_id`,
          [
            { member_id: "left-teammate", joined_seq: 3 },
            { member_id: "mate-dm-teammate", joined_seq: 1 },
          ],
        );
        assert.deepStrictEqual(
          yield* sql`SELECT worker_id, context, moved_at IS NOT NULL AS moved FROM kin_workers ORDER BY worker_id`,
          [
            { worker_id: "asked-by-owner", context: "private", moved: 0 },
            { worker_id: "asked-by-teammate", context: "shared", moved: 0 },
            { worker_id: "private", context: "private", moved: 1 },
            { worker_id: "shared", context: "shared", moved: 0 },
          ],
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect("K034 swaps the running wake-up index to per lead on a database with rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DROP INDEX idx_kin_wakeups_running_lead`;
      yield* sql`CREATE UNIQUE INDEX idx_kin_wakeups_running_org ON kin_wakeups(org_id) WHERE status = 'running'`;
      yield* undoPeopleInvites;
      yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 34`;
      yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES ('org', 'Kin', ${timestamp})`;
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
        VALUES ('owner', 'org', 'owner', 'Owner', ${timestamp})`;
      yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
        VALUES ('direct', 'org', 'direct', 'owner:lead', 0, ${timestamp})`;
      for (const agent of ["lead", "lead-2"]) {
        yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
          VALUES (${agent}, 'org', 'Lead', 'lead', 'owner', ${timestamp})`;
        yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id)
          VALUES (${agent}, 'org', 'Lead', 0, '{}', '[]', 'direct')`;
      }
      const wakeup = (id: string, agent: string, status: string) =>
        sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, model, started_at, ended_at, status, event_ids)
          VALUES (${id}, 'org', ${agent}, 'test', 1000, ${status === "running" ? null : 2000}, ${status}, '[]')`;
      yield* wakeup("running", "lead", "running");
      yield* wakeup("done", "lead", "completed");
      yield* wakeup("done-2", "lead-2", "completed");

      assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(34));
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name GLOB 'idx_kin_wakeups_running*' ORDER BY name`,
        [{ name: "idx_kin_wakeups_running_lead" }],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM pragma_index_info('idx_kin_wakeups_running_lead') ORDER BY seqno`,
        [{ name: "org_id" }, { name: "agent_id" }],
      );
      yield* wakeup("also-running", "lead-2", "running");
      const overlap = yield* Effect.exit(wakeup("overlap", "lead", "running"));
      assert.isTrue(Exit.isFailure(overlap));
      assert.include(String(overlap), "UNIQUE constraint failed");
      assert.deepStrictEqual(
        yield* sql`SELECT wakeup_id, agent_id, status FROM kin_wakeups ORDER BY wakeup_id`,
        [
          { wakeup_id: "also-running", agent_id: "lead-2", status: "running" },
          { wakeup_id: "done", agent_id: "lead", status: "completed" },
          { wakeup_id: "done-2", agent_id: "lead-2", status: "completed" },
          { wakeup_id: "running", agent_id: "lead", status: "running" },
        ],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("K053 turns what the nightly pass let the team know into suggestions", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (const column of [
        "shared_content",
        "shared_how",
        "shared_at",
        "suggested_content",
        "suggested_at",
      ])
        yield* sql`ALTER TABLE kin_memory_labels DROP COLUMN ${sql(column)}`;
      yield* sql`DROP TABLE kin_memory_shared_writes`;
      yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 53`;
      yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES ('org', 'Kin', ${timestamp})`;
      yield* sql`INSERT INTO kin_memory_labels (org_id, item_id, held_at, classified) VALUES
        ('org', 'nightly-team', NULL, 0), ('org', 'nightly-owner', NULL, 1),
        ('org', 'held', 5, NULL), ('org', 'held-nightly', 5, 0)`;

      assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(53));
      assert.deepStrictEqual(
        yield* sql`SELECT item_id, held_at, classified, shared_content, suggested_content,
            suggested_at IS NOT NULL AS suggested FROM kin_memory_labels ORDER BY item_id`,
        [
          {
            item_id: "held",
            held_at: 5,
            classified: null,
            shared_content: null,
            suggested_content: null,
            suggested: 0,
          },
          {
            item_id: "held-nightly",
            held_at: 5,
            classified: 0,
            shared_content: null,
            suggested_content: null,
            suggested: 1,
          },
          {
            item_id: "nightly-owner",
            held_at: null,
            classified: 1,
            shared_content: null,
            suggested_content: null,
            suggested: 0,
          },
          {
            item_id: "nightly-team",
            held_at: null,
            classified: 0,
            shared_content: null,
            suggested_content: null,
            suggested: 1,
          },
        ],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("K054 lets authorisations of the old words lapse to suggestions", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runKinMigrations();
      yield* undoSuggestionsByVersion;
      yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 54`;
      yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES ('org', 'Kin', ${timestamp})`;
      yield* sql`INSERT INTO kin_memory_label_revisions (org_id, revision) VALUES ('org', 3)`;
      yield* sql`INSERT INTO kin_memory_labels
          (org_id, item_id, held_at, shared_content, shared_how, shared_at, suggested_content, suggested_rev)
        VALUES ('org', 'shared', NULL, 'old', 'owner_setting', 1, NULL, NULL),
          ('org', 'said', NULL, 'old', 'teammate', 1, NULL, NULL),
          ('org', 'held', 5, 'old', 'owner_label', 1, NULL, NULL),
          ('org', 'suggested', NULL, NULL, NULL, NULL, 'words', 2)`;

      assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(54));
      assert.deepStrictEqual(
        yield* sql`SELECT item_id, held_at, shared_content, shared_how, suggested_content,
            suggested_at IS NOT NULL AS suggested FROM kin_memory_labels ORDER BY item_id`,
        [
          {
            item_id: "held",
            held_at: 5,
            shared_content: null,
            shared_how: null,
            suggested_content: null,
            suggested: 0,
          },
          {
            item_id: "said",
            held_at: null,
            shared_content: null,
            shared_how: null,
            suggested_content: null,
            suggested: 1,
          },
          {
            item_id: "shared",
            held_at: null,
            shared_content: null,
            shared_how: null,
            suggested_content: null,
            suggested: 1,
          },
          {
            item_id: "suggested",
            held_at: null,
            shared_content: null,
            shared_how: null,
            suggested_content: "words",
            suggested: 1,
          },
        ],
      );
    }).pipe(Effect.provide(layer)),
  );

  // Review of 17822434f4: grants the old chat path stored kept their items team-readable.
  it.effect("K055 turns grants chat stored into suggestions of the same words", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runKinMigrations();
      yield* undoSuggestionsByVersion;
      yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 55`;
      assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(55));
      assert.deepStrictEqual(yield* sql`SELECT * FROM kin_memory_labels`, []);
      yield* undoSuggestionsByVersion;

      yield* sql`INSERT INTO kin_orgs (org_id, name, created_at)
        VALUES ('org', 'Kin', ${timestamp}), ('other', 'Other', ${timestamp})`;
      yield* sql`INSERT INTO kin_memory_label_revisions (org_id, revision) VALUES ('org', 3)`;
      yield* sql`INSERT INTO kin_memory_labels
          (org_id, item_id, held_at, shared_content, shared_how, shared_at, suggested_content, suggested_rev)
        VALUES ('org', 'chat', NULL, 'words-chat', 'owner_label', 1, NULL, NULL),
          ('org', 'chat-2', NULL, 'words-chat-2', 'owner_label', 1, NULL, NULL),
          ('org', 'held', 5, 'words-held', 'owner_label', 1, NULL, NULL),
          ('org', 'pending', NULL, 'words-old', 'owner_label', 1, 'words-new', 2),
          ('org', 'setting', NULL, 'words-setting', 'owner_setting', 1, NULL, NULL),
          ('other', 'chat', NULL, 'words-other', 'owner_label', 1, NULL, NULL)`;
      yield* ChatGrantsLapse;
      const labels = sql`SELECT org_id, item_id, held_at, shared_content, shared_how,
          suggested_content, suggested_rev FROM kin_memory_labels ORDER BY org_id, item_id`;
      const row = (
        org_id: string,
        item_id: string,
        fields: Partial<Record<"held_at" | "suggested_rev", number>> &
          Partial<Record<"shared_content" | "shared_how" | "suggested_content", string>>,
      ) => ({
        org_id,
        item_id,
        held_at: null,
        shared_content: null,
        shared_how: null,
        suggested_content: null,
        suggested_rev: null,
        ...fields,
      });
      const expected = [
        row("org", "chat", { suggested_content: "words-chat", suggested_rev: 4 }),
        row("org", "chat-2", { suggested_content: "words-chat-2", suggested_rev: 4 }),
        row("org", "held", { held_at: 5 }),
        row("org", "pending", { suggested_content: "words-new", suggested_rev: 2 }),
        row("org", "setting", { shared_content: "words-setting", shared_how: "owner_setting" }),
        row("other", "chat", { suggested_content: "words-other", suggested_rev: 1 }),
      ];
      const revisions = sql`SELECT org_id, revision FROM kin_memory_label_revisions
        ORDER BY org_id`;
      const expectedRevisions = [
        { org_id: "org", revision: 4 },
        { org_id: "other", revision: 1 },
      ];
      assert.deepStrictEqual(yield* labels, expected);
      assert.deepStrictEqual(yield* revisions, expectedRevisions);
      // Run again, it finds nothing left to change.
      yield* ChatGrantsLapse;
      assert.deepStrictEqual(yield* labels, expected);
      assert.deepStrictEqual(yield* revisions, expectedRevisions);

      // K056 keeps every suggestion, as when it was suggested, and drops the revisions.
      yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 55`;
      assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(55));
      assert.deepStrictEqual(
        yield* sql`SELECT org_id, item_id, held_at, shared_content, shared_how, suggested_content,
            suggested_at IS NOT NULL AS suggested FROM kin_memory_labels ORDER BY org_id, item_id`,
        expected.map(({ suggested_rev, ...row }) => ({
          ...row,
          suggested: suggested_rev === null ? 0 : 1,
        })),
      );
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'kin_memory_label_revisions'`,
        [],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("K163 keeps each agent's and the company default's strong model as its one model", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runKinMigrations();
      yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 163`;
      const strong =
        '{"instanceId":"claudeAgent","model":"invented-strong","options":[{"id":"effort","value":"high"}]}';
      const old = `{"strong":${strong},"cheap":{"instanceId":"claudeAgent","model":"invented-cheap"}}`;
      yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES ('org', 'Kin', ${timestamp})`;
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
        VALUES ('owner', 'org', 'owner', 'Owner', ${timestamp})`;
      yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
        VALUES ('lead', 'org', 'Lead', 'lead', 'owner', ${timestamp})`;
      yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
        VALUES ('direct', 'org', 'direct', 'owner:lead', 0, ${timestamp})`;
      yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id)
        VALUES ('lead', 'org', 'Lead', 0, ${old}, '[]', 'direct')`;
      yield* sql`INSERT INTO kin_agent_defaults (org_id, models_json) VALUES ('org', ${old})`;

      assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(163));
      const one = JSON.parse(strong);
      for (const table of ["kin_leads", "kin_agent_defaults"]) {
        const [row] = yield* sql<{
          models: string;
        }>`SELECT models_json AS models FROM ${sql(table)}`;
        // The model itself, with the old pair kept for Workers.ts until it is deleted.
        assert.deepStrictEqual(JSON.parse(row!.models), { ...one, ...JSON.parse(old) });
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("K170 keeps the earliest live group of a social profile and disconnects the rest", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runKinMigrations();
      yield* sql`DROP INDEX idx_kin_social_groups_profile`;
      yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 170`;
      yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES ('org', 'Kin', ${timestamp})`;
      yield* sql`INSERT INTO kin_social_groups (org_id, group_id, party_id, service, profile_id,
          accounts_json, created_at, removed_at)
        VALUES ('org', 'sg_first', NULL, 'zernio', 'shared', '[]', 1, NULL),
          ('org', 'sg_second', 'client-a', 'zernio', 'shared', '[]', 2, NULL),
          ('org', 'sg_gone', 'client-b', 'zernio', 'shared', '[]', 0, 5),
          ('org', 'sg_own', 'client-c', 'zernio', 'own', '[]', 3, NULL)`;
      yield* sql`INSERT INTO kin_social_posts (org_id, post_id, kind, group_id, caption, at_ms,
          state, agent_id, created_at, updated_at)
        VALUES ('org', 'draft', 'post', 'sg_second', 'Invented', 9, 'draft', 'lead', 0, 0),
          ('org', 'kept', 'post', 'sg_first', 'Invented', 9, 'draft', 'lead', 0, 0)`;

      assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(170));
      assert.deepStrictEqual(
        yield* sql<{ groupId: string }>`SELECT group_id AS "groupId" FROM kin_social_groups
          WHERE removed_at IS NULL ORDER BY group_id`,
        [{ groupId: "sg_first" }, { groupId: "sg_own" }],
      );
      assert.deepStrictEqual(
        yield* sql<{ postId: string; state: string }>`SELECT post_id AS "postId", state
          FROM kin_social_posts ORDER BY post_id`,
        [
          { postId: "draft", state: "removed" },
          { postId: "kept", state: "draft" },
        ],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("K179 upgrades a database at K178, keeps its invites and devices, and reruns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runKinMigrations();
      yield* sql`DROP INDEX kin_session_bindings_parent`;
      for (const column of ["made_by_person_id", "made_by_session_id"])
        yield* sql`ALTER TABLE kin_people_invites DROP COLUMN ${sql.literal(column)}`;
      yield* sql`ALTER TABLE kin_session_bindings DROP COLUMN parent_session_id`;
      yield* sql`ALTER TABLE kin_session_bindings DROP COLUMN link_id`;
      yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 179`;
      yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES ('org', 'Kin', ${timestamp})`;
      yield* sql`INSERT INTO kin_people_invites (invite_id, org_id, person_id, display_name, handle,
          secret_hash, created_at, expires_at)
        VALUES ('invite', 'org', NULL, 'Zoya', 'zoya', 'hash', 1, 2)`;
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
        VALUES ('zoya', 'org', 'zoya', 'Zoya', ${timestamp})`;
      yield* sql`INSERT INTO auth_sessions (session_id, subject, method, scopes, issued_at, expires_at)
        VALUES ('phone', 'kin-member', 'browser-session-cookie', '[]', ${timestamp},
          '2026-12-07T00:00:00.000Z')`;
      yield* sql`INSERT INTO kin_session_bindings (session_id, org_id, person_id, bound_at)
        VALUES ('phone', 'org', 'zoya', 1)`;

      assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(179));
      assert.deepStrictEqual(
        yield* sql`SELECT invite_id AS "inviteId", made_by_person_id AS "madeBy",
          made_by_session_id AS "madeFrom" FROM kin_people_invites`,
        [{ inviteId: "invite", madeBy: null, madeFrom: null }],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT session_id AS "sessionId", parent_session_id AS "parent",
          link_id AS "linkId" FROM kin_session_bindings`,
        [{ sessionId: "phone", parent: null, linkId: null }],
      );
      yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 179`;
      assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(179));
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "K197 gives open invites no chosen places, keeps a choice and its chooser, and reruns",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runKinMigrations();
        for (const column of ["sees_json", "sees_by_person_id"])
          yield* sql`ALTER TABLE kin_people_invites DROP COLUMN ${sql.literal(column)}`;
        yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 197`;
        yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES ('org', 'Kin', ${timestamp})`;
        yield* sql`INSERT INTO kin_people_invites (invite_id, org_id, person_id, display_name, handle,
          secret_hash, created_at, expires_at)
        VALUES ('invite', 'org', NULL, 'Zoya', 'zoya', 'hash', 1, 2)`;
        const invites = sql`SELECT invite_id AS "inviteId", sees_json AS sees,
        sees_by_person_id AS by FROM kin_people_invites`;
        assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(197));
        assert.deepStrictEqual(yield* invites, [{ inviteId: "invite", sees: null, by: null }]);
        const sees = JSON.stringify({ clients: false, docs: true, money: true });
        yield* sql`UPDATE kin_people_invites SET sees_json = ${sees}, sees_by_person_id = 'meera'`;
        yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 197`;
        assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(197));
        assert.deepStrictEqual(yield* invites, [{ inviteId: "invite", sees, by: "meera" }]);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("K198 gives every chat member no pin, keeps a pin, and reruns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runKinMigrations();
      yield* undoChatPins;
      yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 198`;
      yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES ('org', 'Ambermill', ${timestamp})`;
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
        VALUES ('rhea', 'org', 'rhea', 'Rhea', ${timestamp})`;
      yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at)
        VALUES ('chat', 'org', 'project_group', 0, ${timestamp})`;
      yield* sql`INSERT INTO kin_chat_members (org_id, chat_id, member_id, role, joined_at,
          principal_kind, person_id)
        VALUES ('org', 'chat', 'member', 'owner', ${timestamp}, 'person', 'rhea')`;
      const pinned = sql`SELECT member_id AS "memberId", pinned_at AS "pinnedAt"
        FROM kin_chat_members`;
      assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(198));
      assert.deepStrictEqual(yield* pinned, [{ memberId: "member", pinnedAt: null }]);
      yield* sql`UPDATE kin_chat_members SET pinned_at = 5`;
      yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 198`;
      assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(198));
      assert.deepStrictEqual(yield* pinned, [{ memberId: "member", pinnedAt: 5 }]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("K199 gives every task no steps and no urgent mark, keeps both, and reruns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runKinMigrations();
      yield* undoTaskSteps;
      yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 199`;
      yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES ('org', 'Kin', ${timestamp})`;
      yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in,
          created_at) VALUES ('org', 'work', 'Work', 'W', 1, 1)`;
      yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, owner_kind,
          owner_id, created_by_kind, origin_key, created_at, updated_at)
        VALUES ('org', 'task', 'work', 'W-1', 'Design the screen', 'person', 'dev', 'person',
          'origin', 1, 1)`;
      const tasks = sql`SELECT key, steps_json AS steps, urgent FROM kin_records`;
      assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(199));
      assert.deepStrictEqual(yield* tasks, [{ key: "W-1", steps: null, urgent: null }]);
      const steps = JSON.stringify([{ title: "Wireframe", done: true }]);
      yield* sql`UPDATE kin_records SET steps_json = ${steps}, urgent = 1`;
      yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 199`;
      assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(199));
      assert.deepStrictEqual(yield* tasks, [{ key: "W-1", steps, urgent: 1 }]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("K185 runs after K184 and only once, with K186 behind it", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runKinMigrations();
      const drop = Effect.gen(function* () {
        yield* sql`DROP INDEX kin_questions_for_chat`;
        for (const column of ["for_chat_id", "for_person_id", "card_json"])
          yield* sql`ALTER TABLE kin_questions DROP COLUMN ${sql.literal(column)}`;
        yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id > 184`;
      });
      const columns = sql<{ name: string }>`SELECT name FROM pragma_table_info('kin_questions')
        WHERE name IN ('for_chat_id', 'for_person_id', 'card_json') ORDER BY name`;
      yield* drop;
      assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(185));
      assert.lengthOf(yield* columns, 3);
      assert.deepStrictEqual(yield* runKinMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect(
    "K186 ends only the live keys with no recorded maker, on a fresh or upgraded database",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runKinMigrations();
        assert.deepStrictEqual(yield* sql`SELECT 1 FROM kin_tasks_keys`, []);
        assert.deepInclude(yield* kinHistory, { migration_id: 186, name: "TasksKeysWithoutMaker" });

        yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 186`;
        for (const [sessionId, madeBy, revokedAt] of [
          ["unrecorded", null, null],
          ["made", "phone", null],
          ["ended", null, 7],
        ] as const)
          yield* sql`INSERT INTO kin_tasks_keys (session_id, org_id, person_id, label, created_at,
            expires_at, revoked_at, made_by_session_id)
          VALUES (${sessionId}, 'org', 'zoya', 'Invented laptop', 1, 2, ${revokedAt}, ${madeBy})`;
        const keys = sql<{ sessionId: string; revoked: number; revokedAt: number | null }>`SELECT
          session_id AS "sessionId", revoked_at IS NOT NULL AS revoked, revoked_at AS "revokedAt"
        FROM kin_tasks_keys ORDER BY session_id`;
        assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(186));
        const ended = yield* keys;
        assert.deepStrictEqual(
          ended.map(({ sessionId, revoked }) => [sessionId, revoked]),
          [
            ["ended", 1],
            ["made", 0],
            ["unrecorded", 1],
          ],
        );
        assert.strictEqual(ended[0]?.revokedAt, 7);
        // Run again, it changes nothing.
        yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 186`;
        assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(186));
        assert.deepStrictEqual(yield* keys, ended);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("K187 keeps one live hold per record for the company and one per person", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runKinMigrations();
      const hold = (id: string, forPerson: string | null, liftedAt: number | null = null) =>
        sql`INSERT INTO kin_holds (hold_id, org_id, record_id, for_person_id, until_at,
            set_by_kind, set_by_id, on_word_of, note, set_at, lifted_at)
          VALUES (${id}, 'org', 'client-7', ${forPerson}, NULL, 'agent', 'finance', 'rhea',
            NULL, 1, ${liftedAt})`;
      yield* hold("company", null);
      yield* hold("meera", "meera");
      yield* hold("lifted", null, 5);
      assert.isTrue(Exit.isFailure(yield* Effect.exit(hold("second", null))));
      assert.isTrue(Exit.isFailure(yield* Effect.exit(hold("meera-again", "meera"))));
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            sql`INSERT INTO kin_holds (hold_id, org_id, record_id, set_by_kind, set_by_id, set_at)
              VALUES ('robot', 'org', 'client-8', 'robot', 'x', 1)`,
          ),
        ),
      );
      yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 187`;
      assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(187));
      assert.lengthOf(yield* sql`SELECT 1 FROM kin_holds`, 3);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect(
    "K188 keeps closed only what the owner revoked by hand, and holds one live limit per pair",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runKinMigrations();
        yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 188`;
        yield* sql`DROP TABLE kin_reach_limits`;
        yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES ('org', 'Ambermill', 1)`;
        for (const [personId, access, removedAt] of [
          ["rhea", "owner", null],
          ["meera", "co_owner", null],
          ["dev", "member", null],
          ["zoya", "member", 40],
          ["arjun", "member", null],
        ] as const)
          yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at,
              access, removed_at)
            VALUES (${personId}, 'org', ${personId}, ${personId}, 1, ${access}, ${removedAt})`;
        for (const agentId of ["chief", "finance"])
          yield* sql`INSERT INTO kin_agents (agent_id, org_id, role, display_name, owner_person_id,
              created_at)
            VALUES (${agentId}, 'org', 'lead', ${agentId}, 'rhea', 1)`;
        yield* sql`INSERT INTO kin_team_agents (org_id, agent_id, set_by, set_at)
          VALUES ('org', 'chief', 'rhea', 1)`;
        for (const [agentId, personId, revokedAt] of [
          // By hand: stays closed.
          ["finance", "dev", 30],
          // Still allowed.
          ["finance", "arjun", null],
          // Stamped at Zoya's removal: the removal's, not a restriction.
          ["finance", "zoya", 40],
          // A co-owner messages every agent; the team agent never closed anything.
          ["finance", "meera", 30],
          ["chief", "dev", 30],
        ] as const)
          yield* sql`INSERT INTO kin_lead_access (org_id, agent_id, person_id, granted_by,
              granted_at, revoked_at)
            VALUES ('org', ${agentId}, ${personId}, 'rhea', 10, ${revokedAt})`;
        const limits = sql`SELECT one_kind, one_id, other_kind, other_id, set_by_person_id,
            set_at, lifted_at FROM kin_reach_limits ORDER BY limit_id`;
        assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(188));
        const backfilled = yield* limits;
        assert.deepStrictEqual(backfilled, [
          {
            one_kind: "agent",
            one_id: "finance",
            other_kind: "person",
            other_id: "dev",
            set_by_person_id: "rhea",
            set_at: 30,
            lifted_at: null,
          },
        ]);
        // One live limit per pair; a lifted one stays as history beside a new one.
        const insert = (limitId: string) =>
          sql`INSERT INTO kin_reach_limits (limit_id, org_id, one_kind, one_id, other_kind,
              other_id, set_by_person_id, set_at)
            VALUES (${limitId}, 'org', 'agent', 'finance', 'person', 'dev', 'rhea', 50)`;
        assert.isTrue(Exit.isFailure(yield* Effect.exit(insert("again"))));
        yield* sql`UPDATE kin_reach_limits SET lifted_at = 60, lifted_by_person_id = 'meera'`;
        yield* insert("again");
        // The pair is stored in one order only.
        const reversed = sql`INSERT INTO kin_reach_limits (limit_id, org_id, one_kind, one_id,
            other_kind, other_id, set_by_person_id, set_at)
          VALUES ('reversed', 'org', 'person', 'dev', 'agent', 'chief', 'rhea', 50)`;
        assert.isTrue(Exit.isFailure(yield* Effect.exit(reversed)));
        // Run again, it adds nothing.
        yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 188`;
        const before = yield* limits;
        assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(188));
        assert.deepStrictEqual(yield* limits, before);
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "K189 gives everyone already here the default morning page, and runs again safely",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runKinMigrations();
        yield* sql`ALTER TABLE kin_people DROP COLUMN morning_json`;
        yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 189`;
        yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES ('org', 'Kin', ${timestamp})`;
        yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
        VALUES ('rhea', 'org', 'rhea', 'Rhea', ${timestamp}),
          ('zoya', 'org', 'zoya', 'Zoya', ${timestamp})`;
        assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(189));
        const people = () =>
          sql<{ personId: string; morning: string | null }>`SELECT person_id AS "personId",
          morning_json AS morning FROM kin_people ORDER BY person_id`;
        assert.deepStrictEqual(yield* people(), [
          { personId: "rhea", morning: null },
          { personId: "zoya", morning: null },
        ]);
        yield* sql`UPDATE kin_people SET morning_json = '{"at":"07:30","days":[1],"on":false}'
        WHERE person_id = 'zoya'`;
        yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 189`;
        assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(189));
        assert.strictEqual((yield* people())[1]?.morning, '{"at":"07:30","days":[1],"on":false}');
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("K190 keeps every import run and its numbering, and lets a check keep a row", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runKinMigrations();
      yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 190`;
      yield* sql`DROP INDEX idx_kin_records_title`;
      yield* sql`DROP TABLE kin_import_runs`;
      yield* K079ImportRuns;
      yield* sql`INSERT INTO kin_orgs VALUES ('org', 'Invented Ambermill', '2026-11-11T00:00:00.000Z')`;
      for (const [batch, action, finished] of [
        ["spring", "apply", 2],
        ["spring", "undo", 3],
        ["summer", "apply", null],
      ] as const)
        yield* sql`INSERT INTO kin_import_runs (org_id, batch, action, person_id, started_at,
            finished_at, lists_json, summary_json)
          VALUES ('org', ${batch}, ${action}, 'rhea', 1, ${finished}, '["deals"]', '{"done":4}')`;
      yield* sql`DELETE FROM kin_import_runs WHERE batch = 'summer'`;
      const runs = sql`SELECT * FROM kin_import_runs ORDER BY seq`;
      const before = yield* runs;
      const check = sql`INSERT INTO kin_import_runs (org_id, batch, action, person_id, started_at)
        VALUES ('org', '', 'check', 'rhea', 4) RETURNING seq`;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(check)));

      assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(190));
      assert.deepStrictEqual(yield* runs, before);
      assert.deepStrictEqual(yield* check, [{ seq: 4 }]);
      assert.lengthOf(
        yield* sql`SELECT 1 FROM sqlite_master WHERE name = 'idx_kin_records_title'`,
        1,
      );
      // Run again, it changes nothing.
      yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 190`;
      const after = yield* runs;
      assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(190));
      assert.deepStrictEqual(yield* runs, after);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect(
    "K191 reads one wake-up's posts and a day's wake-ups by index, not the whole history",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // Each read is its own statement: the client keeps a prepared plan for a statement's text.
        const plans = Effect.fn(function* (read: string) {
          const tag = sql.literal(`/* ${read} */`);
          const posts = yield* sql<{ detail: string }>`EXPLAIN QUERY PLAN SELECT body ${tag}
          FROM kin_messages
          WHERE org_id = 'org' AND author_kind = 'agent' AND author_agent_id = 'lead'
            AND author_thread_id = 'kin:lead' AND created_at >= '2026-11-20T00:00:00.000Z'
          ORDER BY seq`;
          const failed = yield* sql<{
            detail: string;
          }>`EXPLAIN QUERY PLAN SELECT COUNT(*) AS n ${tag}
          FROM kin_wakeups WHERE org_id = 'org' AND status IN ('failed', 'timed_out')
            AND started_at >= 0`;
          return [...posts, ...failed].map((row) => row.detail).join("\n");
        });
        yield* runKinMigrations();
        const indexed = yield* plans("indexed");
        assert.include(indexed, "idx_kin_messages_agent_thread");
        assert.include(indexed, "idx_kin_wakeups_started");
        yield* sql`DROP INDEX idx_kin_messages_agent_thread`;
        yield* sql`DROP INDEX idx_kin_wakeups_started`;
        // Without them, both read every row the org ever had.
        const scanned = yield* plans("without");
        assert.include(scanned, "idx_kin_messages_changes (org_id=?)");
        assert.notInclude(scanned, "started_at>");
        yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 191`;
        assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(191));
        assert.strictEqual(yield* plans("again"), indexed);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect(
    "K194 drops the webhook sources a host still holds, and runs on one already without",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const sources = sql`SELECT name FROM sqlite_master WHERE name = 'kin_webhook_sources'`;
        yield* runKinMigrations();
        assert.deepStrictEqual(yield* sources, []);
        yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 194`;
        yield* sql`CREATE TABLE kin_webhook_sources (
        source_id TEXT NOT NULL,
        org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
        repo TEXT NOT NULL,
        scheduled_task_id TEXT NOT NULL UNIQUE,
        inbox_thread_id TEXT NOT NULL,
        github_hook_id INTEGER,
        bot_login TEXT NOT NULL,
        status TEXT NOT NULL,
        secret_sha256 TEXT,
        secret_bound_at INTEGER,
        PRIMARY KEY (org_id, source_id)
      )`;
        yield* sql`INSERT INTO kin_orgs VALUES ('org', 'Invented Ambermill', '2026-11-11T00:00:00.000Z')`;
        yield* sql`INSERT INTO kin_webhook_sources (source_id, org_id, repo, scheduled_task_id,
          inbox_thread_id, bot_login, status)
        VALUES ('source', 'org', 'ambermill/shop', 'task', 'inbox', 'kin[bot]', 'active')`;
        yield* sql`PRAGMA foreign_keys = ON`;
        assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(194));
        assert.deepStrictEqual(yield* sources, []);
        assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
        // Already gone: it runs again and changes nothing.
        yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 194`;
        assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(194));
        assert.deepStrictEqual(yield* sources, []);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect(
    "K196 gives a host on K195 the review receipt column, keeps its rows, then 197 to 203, and runs again",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const receipts = sql<{ trigger_key: string; review_url: string | null }>`
          SELECT trigger_key, review_url FROM kin_github_handled ORDER BY trigger_key`;
        const later = sql<{ name: string }>`
          SELECT name FROM pragma_table_info('kin_people_invites')
            WHERE name IN ('sees_json', 'sees_by_person_id')
          UNION ALL SELECT name FROM pragma_table_info('kin_chat_members') WHERE name = 'pinned_at'
          UNION ALL SELECT name FROM pragma_table_info('kin_records')
            WHERE name IN ('steps_json', 'urgent')
          UNION ALL SELECT name FROM pragma_table_info('kin_questions')
            WHERE name IN ('draft_json', 'approved_at', 'draft_made_json')
          ORDER BY name`;
        yield* runKinMigrations();
        // A host on K195: none of 196-200's columns yet, one handled trigger.
        yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 196`;
        yield* sql`ALTER TABLE kin_github_handled DROP COLUMN review_url`;
        for (const column of ["sees_json", "sees_by_person_id"])
          yield* sql`ALTER TABLE kin_people_invites DROP COLUMN ${sql.literal(column)}`;
        yield* undoChatPins;
        yield* undoTaskSteps;
        yield* undoSentUpDrafts;
        assert.deepStrictEqual(yield* later, []);
        yield* sql`INSERT INTO kin_github_handled (org_id, trigger_key, repo, number, outcome, at)
          VALUES ('org', 'review:ambermill/shop#7', 'ambermill/shop', 7, 'woke', 1)`;
        // Later branches' migrations run after these too; only these three are this test's.
        assert.deepStrictEqual(
          (yield* runKinMigrations()).map(([id]) => id),
          [196, 197, 198, 199, 200, 201, 202, 203, 205],
        );
        assert.deepStrictEqual(yield* receipts, [
          { trigger_key: "review:ambermill/shop#7", review_url: null },
        ]);
        assert.deepStrictEqual(
          (yield* later).map(({ name }) => name),
          [
            "approved_at",
            "draft_json",
            "draft_made_json",
            "pinned_at",
            "sees_by_person_id",
            "sees_json",
            "steps_json",
            "urgent",
          ],
        );
        // Already there: it changes nothing.
        yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 196`;
        assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(196));
        assert.deepStrictEqual(yield* receipts, [
          { trigger_key: "review:ambermill/shop#7", review_url: null },
        ]);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("a host on K196 migrates through 197 to 203, and again", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const added = sql<{ name: string }>`
        SELECT name FROM pragma_table_info('kin_people_invites')
          WHERE name IN ('sees_json', 'sees_by_person_id')
        UNION ALL SELECT name FROM pragma_table_info('kin_chat_members') WHERE name = 'pinned_at'
        UNION ALL SELECT name FROM pragma_table_info('kin_records')
          WHERE name IN ('steps_json', 'urgent')
        UNION ALL SELECT name FROM pragma_table_info('kin_questions')
          WHERE name IN ('draft_json', 'approved_at', 'draft_made_json')
        ORDER BY name`;
      yield* runKinMigrations();
      yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 197`;
      for (const column of ["sees_json", "sees_by_person_id"])
        yield* sql`ALTER TABLE kin_people_invites DROP COLUMN ${sql.literal(column)}`;
      yield* undoChatPins;
      yield* undoTaskSteps;
      yield* undoSentUpDrafts;
      assert.deepStrictEqual(yield* added, []);
      assert.deepStrictEqual(
        (yield* runKinMigrations()).map(([id]) => id),
        [197, 198, 199, 200, 201, 202, 203, 205],
      );
      const all = [
        "approved_at",
        "draft_json",
        "draft_made_json",
        "pinned_at",
        "sees_by_person_id",
        "sees_json",
        "steps_json",
        "urgent",
      ];
      assert.deepStrictEqual(
        (yield* added).map(({ name }) => name),
        all,
      );
      for (const from of [197, 198, 199, 200, 201, 202, 203, 205]) {
        yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= ${from}`;
        assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(from));
        assert.deepStrictEqual(
          (yield* added).map(({ name }) => name),
          all,
        );
      }
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect(
    "K200 gives a database at K198 the draft columns, keeps its questions, and runs again harmlessly",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const columns = sql<{ name: string; type: string; notnull: number }>`SELECT name, type,
            "notnull" FROM pragma_table_info('kin_questions')
          WHERE name IN ('draft_json', 'approved_at', 'draft_made_json') ORDER BY name`;
        const questions = sql<{ id: string; question: string; draft: string | null }>`SELECT
            question_id AS id, question, draft_json AS draft FROM kin_questions ORDER BY question_id`;
        yield* runKinMigrations();
        // A database at K198: none of this migration's columns, one open question.
        yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 200`;
        for (const column of ["draft_json", "approved_at", "draft_made_json"])
          yield* sql`ALTER TABLE kin_questions DROP COLUMN ${sql.literal(column)}`;
        assert.deepStrictEqual(yield* columns, []);
        yield* sql`INSERT INTO kin_orgs VALUES ('org', 'Invented Ambermill', '2026-11-11T00:00:00.000Z')`;
        yield* sql`INSERT INTO kin_questions (question_id, org_id, agent_id, person_id, chat_id,
            kind, question, safe, asked_at, due_at, act_at, state)
          VALUES ('q-1', 'org', 'chief', 'rhea', 'chat-1', 'card', 'Invented: Friday?', 0, 1, 2, 3,
            'open')`;
        const added = [
          { name: "approved_at", type: "INTEGER", notnull: 0 },
          { name: "draft_json", type: "TEXT", notnull: 0 },
          { name: "draft_made_json", type: "TEXT", notnull: 0 },
        ];
        const kept = [{ id: "q-1", question: "Invented: Friday?", draft: null }];
        assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(200));
        assert.deepStrictEqual(yield* columns, added);
        assert.deepStrictEqual(yield* questions, kept);
        // Already there: running it again changes nothing.
        yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 200`;
        assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(200));
        assert.deepStrictEqual(yield* columns, added);
        assert.deepStrictEqual(yield* questions, kept);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("K201 rebuilds an upgraded search index so a doc is found by its kind", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runKinMigrations();
      // Back to K200, as release 1 leaves it: the index without a kind, holding a playbook that never says "playbook".
      yield* sql`DROP TABLE kin_search`;
      yield* sql`CREATE VIRTUAL TABLE kin_search USING fts5(
        title, body, tokenize = 'unicode61 remove_diacritics 2')`;
      yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 201`;
      yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES ('org', 'Kin', 1)`;
      yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, created_at)
        VALUES ('org', 'docs', 'Docs', 'D', 1)`;
      yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, category,
          owner_kind, owner_id, created_by_kind, origin_key, created_at, updated_at)
        VALUES ('org', 'doc', 'docs', 'D-1', 'Chasing money', 'playbook', 'person', 'p',
          'person', 'owner:1', 1, 1)`;
      yield* sql`INSERT INTO kin_search_rows (org_id, record_id, part) VALUES ('org', 'doc', 'public')`;
      yield* sql`INSERT INTO kin_search (rowid, title, body)
        SELECT id, 'Chasing money', '' FROM kin_search_rows`;
      const found = sql<{
        rowid: number;
      }>`SELECT rowid FROM kin_search WHERE kin_search MATCH 'playbooks'`;
      assert.lengthOf(yield* found, 0);
      assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(201));
      assert.lengthOf(yield* found, 1);
      // Run again: the index is rebuilt from what is stored, so the doc is found once.
      yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 201`;
      assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(201));
      assert.lengthOf(yield* found, 1);
      // Without FTS5 there is no index to rebuild, and search scans.
      yield* sql`DROP TABLE kin_search`;
      yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 201`;
      assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(201));
      assert.lengthOf(yield* sql`SELECT 1 FROM sqlite_master WHERE name = 'kin_search'`, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect(
    "K202 lets a push device be an Android phone, keeps every column of a host's iPhone rows, and reruns",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const shape = sql`SELECT cid, name, type, "notnull", dflt_value, pk
          FROM pragma_table_info('kin_push_devices') ORDER BY cid`;
        const indexes = sql`SELECT name, sql FROM sqlite_master
          WHERE type = 'index' AND tbl_name = 'kin_push_devices' ORDER BY name`;
        const rows = sql`SELECT * FROM kin_push_devices ORDER BY org_id, token`;
        yield* runKinMigrations();
        // A host on K201: the table as K021 made it, holding iPhones with every column filled.
        yield* sql`DROP TABLE kin_push_devices`;
        yield* K021PushDevices;
        yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 202`;
        yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES ('org', 'Kin', 1)`;
        yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
          VALUES ('rhea', 'org', 'rhea', 'Rhea', 1), ('meera', 'org', 'meera', 'Meera', 1)`;
        const device = (token: string, platform: string) =>
          sql`INSERT INTO kin_push_devices (org_id, token, person_id, platform, aps_environment,
              device_label, session_id, proof_key_thumbprint, created_at, updated_at)
            VALUES ('org', ${token}, 'rhea', ${platform}, 'production', 'Rhea phone', 's1',
              'thumb-1', 1, 2)`;
        yield* device("a".repeat(64), "ios");
        yield* sql`INSERT INTO kin_push_devices VALUES ('org', ${"b".repeat(64)}, 'meera', 'ios',
          'development', 'Meera phone', 's2', 'thumb-2', 3, 4)`;
        assert.isTrue(Exit.isFailure(yield* Effect.exit(device("fcm:token", "android"))));
        const before = { shape: yield* shape, indexes: yield* indexes, rows: yield* rows };
        assert.lengthOf(before.rows, 2);
        assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(202));
        assert.deepStrictEqual(
          { shape: yield* shape, indexes: yield* indexes, rows: yield* rows },
          before,
        );
        yield* device("fcm:token", "android");
        assert.isTrue(Exit.isFailure(yield* Effect.exit(device("other", "windows"))));
        const after = yield* rows;
        assert.deepStrictEqual(after.slice(0, 2), before.rows);
        assert.lengthOf(after, 3);
        yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 202`;
        assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(202));
        assert.deepStrictEqual(
          { shape: yield* shape, indexes: yield* indexes, rows: yield* rows },
          { ...before, rows: after },
        );
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect(
    "K203 gives a host on K202 the watch tables and the background model, keeps its defaults, and reruns",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const tables = sql<{ name: string }>`SELECT name FROM sqlite_master
          WHERE type = 'table' AND name IN ('kin_watches', 'kin_watch_looks') ORDER BY name`;
        const defaults = sql`SELECT * FROM kin_agent_defaults ORDER BY org_id`;
        yield* runKinMigrations();
        // A host on K202: no watch tables, a company default model and no background one.
        yield* sql`DROP TABLE kin_watch_looks`;
        yield* sql`DROP TABLE kin_watches`;
        yield* sql`ALTER TABLE kin_agent_defaults DROP COLUMN scout_model_json`;
        yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 203`;
        yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES ('org', 'Kin', 1)`;
        yield* sql`INSERT INTO kin_agent_defaults (org_id, models_json)
          VALUES ('org', '{"default":"invented-model"}')`;
        assert.deepStrictEqual(yield* tables, []);
        assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(203));
        assert.deepStrictEqual(
          (yield* tables).map(({ name }) => name),
          ["kin_watch_looks", "kin_watches"],
        );
        assert.deepStrictEqual(yield* defaults, [
          { org_id: "org", models_json: '{"default":"invented-model"}', scout_model_json: null },
        ]);
        // A look must name its watch, and only a round's summary row has no watch.
        const look = (watch: string | null, counts: string | null) =>
          sql`INSERT INTO kin_watch_looks (org_id, look_id, round_id, watch_id, at, counts_json)
            VALUES ('org', ${`l-${watch ?? "round"}-${counts ?? "none"}`}, 'r', ${watch}, 1, ${counts})`;
        assert.isTrue(Exit.isFailure(yield* Effect.exit(look(null, null))));
        assert.isTrue(Exit.isFailure(yield* Effect.exit(look("w", "{}"))));
        yield* look(null, "{}");
        yield* look("w", null);
        yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 203`;
        assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(203));
        assert.lengthOf(yield* defaults, 1);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect(
    "K205 gives a host on K203 the trouble tables and held_by, one open trouble per cause, and reruns",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runKinMigrations();
        yield* sql`DROP INDEX idx_kin_events_held_by`;
        yield* sql`ALTER TABLE kin_events DROP COLUMN held_by`;
        yield* sql`DROP TABLE kin_trouble_agents`;
        yield* sql`DROP TABLE kin_troubles`;
        yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 205`;
        assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(205));
        const open = (id: string, closedAt: number | null) =>
          sql`INSERT INTO kin_troubles (trouble_id, org_id, cause, opened_at, closed_at)
            VALUES (${id}, 'org', 'space', 1, ${closedAt})`;
        yield* open("t1", 2);
        yield* open("t2", null);
        assert.isTrue(Exit.isFailure(yield* Effect.exit(open("t3", null))));
        const columns = yield* sql<{
          name: string;
        }>`SELECT name FROM pragma_table_info('kin_events')
          WHERE name = 'held_by'`;
        assert.lengthOf(columns, 1);
        yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 205`;
        assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(205));
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses to start when a registered migration sits below the latest applied one", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runKinMigrations();
      // What a database looks like when K021 merged before a lower-numbered migration.
      yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id = 5`;
      const history = yield* kinHistory;
      const exit = yield* Effect.exit(runKinMigrations());
      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "5_OneChatOwner");
      assert.include(String(exit), "below the latest applied migration 205");
      assert.deepStrictEqual(yield* kinHistory, history);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses to start when another migration already ran under the same number", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runKinMigrations();
      // What a database looks like after running another branch's K022.
      yield* sql`UPDATE kin_sql_migrations SET name = 'Budget' WHERE migration_id = 22`;
      const exit = yield* Effect.exit(runKinMigrations());
      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "22_ChatLevels");
      assert.include(String(exit), "share a number");
      assert.strictEqual(new Set(kinMigrations.map(([id]) => id)).size, kinMigrations.length);
      assert.strictEqual(new Set(kinMigrations.map(([, name]) => name)).size, kinMigrations.length);
      // Nothing a host already ran is dropped, renamed or renumbered; new ones go after it.
      assert.deepStrictEqual(kinMigrations.slice(0, shipped.length), [...shipped]);
      assert.isTrue(kinMigrations.slice(shipped.length).every(([id]) => id > shipped.at(-1)![0]));
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("persists lead records and enforces queue, tenant and running-wakeup constraints", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES ('org', 'Kin', ${timestamp})`;
      yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES ('other', 'Other', ${timestamp})`;
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
        VALUES ('owner', 'org', 'owner', 'Owner', ${timestamp})`;
      yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
        VALUES ('lead', 'org', 'Lead', 'lead', 'owner', ${timestamp})`;
      yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
        VALUES ('direct', 'org', 'direct', 'owner:lead', 0, ${timestamp})`;
      const rows = {
        kin_leads: {
          org_id: "org",
          agent_id: "lead",
          name: "tech-lead",
          level: "L0",
          level_since: 1794009600000,
          thread_id: "upstream-thread",
          models_json:
            '{"strong":{"instanceId":"codex","model":"strong"},"cheap":{"instanceId":"codex","model":"cheap"}}',
          worker_projects_json: '["upstream-project"]',
          owner_chat_id: "direct",
          domain: "engineering",
          charter: "",
          created_by_person_id: null,
          public_intro: "",
          role_tags_json: "[]",
        },
        kin_wakeups: {
          org_id: "org",
          wakeup_id: "wake",
          agent_id: "lead",
          thread_id: "upstream-thread",
          run_id: "upstream-run",
          model: "strong",
          started_at: 1794009600000,
          ended_at: null,
          status: "running",
          event_ids: '["event"]',
          tokens_json: '{"inputTokens":10,"cachedInputTokens":5,"outputTokens":2}',
          tools_json: "{}",
          memory_commit: null,
          enqueued_at: 1794009599000,
          prepared_at: 1794009600100,
          launched_at: 1794009600200,
          first_token_at: 1794009602000,
          posted_at: 1794009603000,
          resumed: 1,
          audience: "owner_only",
          shared_since: null,
          aborted_at: null,
          settled_at: null,
          retired_at: null,
        },
        kin_events: {
          org_id: "org",
          event_id: "event",
          agent_id: "lead",
          tag: "resume",
          priority: "P0",
          json: '{"_tag":"resume"}',
          dedupe_key: "resume:1",
          received_at: 1794009600000,
          queued_at: 1794009600000,
          state: "claimed",
          wakeup_id: "wake",
          not_before: null,
          attempts: 1,
          budget_deferred: 0,
          replied_at: null,
          held_by: null,
        },
        kin_workers: {
          org_id: "org",
          worker_id: "worker",
          agent_id: "lead",
          wakeup_id: "wake",
          kind: "build",
          thread_id: "worker-thread",
          review_of: null,
          model_json: '{"instanceId":"codex","model":"strong"}',
          provenance_json: '{"_tag":"system"}',
          status: "completed",
          report_json: '{"parsed":false}',
          started_at: 1794009600000,
          ended_at: 1794009600000,
          title: "Fix",
          chat_id: "chat",
          environment_id: "worker-env",
          project_id: "project",
          remote_project_id: "remote-project",
          repository_key: "github.com/acme/app",
          pull_request_url: null,
          pull_request_number: null,
          context: null,
          moved_at: null,
          target_pr: null,
          target_branch: null,
        },
        kin_memory_reads: { org_id: "org", item_id: "fixture-id", last_read_at: 1794009600000 },
        kin_cursor: { org_id: "org", consumer: "worker-tracker", after_sequence: 42 },
        kin_shadow_entries: {
          org_id: "org",
          entry_id: "shadow",
          agent_id: "lead",
          wakeup_id: "wake",
          level: "L0",
          unlocks_level: "L1",
          tool: "kin_chat_post",
          input_json: '{"text":"Ready"}',
          would_target: "direct",
          created_at: 1794009600000,
          verdict: "fine",
          verdict_note: "Keep",
          reviewed_at: 1794009600000,
        },
        kin_budget_limits: {
          org_id: "org",
          limits_json: '{"leadUnits":2000000,"workerUnits":6000000}',
        },
        kin_budget: {
          org_id: "org",
          day: "2026-11-07",
          lead_units: 3.5,
          worker_units: 9,
          exhausted_notified_at: null,
          warned_at: null,
          teammates_notified_at: null,
        },
        kin_worker_charges: {
          org_id: "org",
          worker_id: "worker",
          run_id: "worker-run",
          day: "2026-11-07",
          units: 1.5,
          tokens_json: "[]",
        },
        kin_org_state: {
          org_id: "org",
          paused: 1,
          paused_at: 1794009600000,
          paused_by: "owner",
          reason: "Stop",
        },
      };
      const crossOrgLead = yield* Effect.exit(
        sql`INSERT INTO kin_leads ${sql.insert({ ...rows.kin_leads, org_id: "other" })}`,
      );
      assert.isTrue(Exit.isFailure(crossOrgLead));
      assert.include(String(crossOrgLead), "FOREIGN KEY constraint failed");
      for (const [table, row] of Object.entries(rows)) {
        yield* sql`INSERT INTO ${sql(table)} ${sql.insert(row)}`;
        assert.deepStrictEqual(yield* sql`SELECT * FROM ${sql(table)} WHERE org_id = 'org'`, [row]);
      }
      yield* sql`INSERT INTO kin_memory_reads (org_id, item_id, last_read_at) VALUES ('other', 'fixture-id', 1)`;
      assert.deepStrictEqual(
        yield* sql`SELECT org_id, item_id, last_read_at FROM kin_memory_reads ORDER BY org_id, item_id`,
        [rows.kin_memory_reads, { org_id: "other", item_id: "fixture-id", last_read_at: 1 }],
      );
      const rejected = [
        {
          table: "kin_memory_reads",
          row: { org_id: "missing", item_id: "fixture", last_read_at: 1 },
          error: "FOREIGN KEY constraint failed",
        },
        {
          table: "kin_memory_reads",
          row: { org_id: "org", item_id: "invalid-time", last_read_at: "invalid" },
          error: "CHECK constraint failed",
        },
        {
          table: "kin_org_state",
          row: { ...rows.kin_org_state, org_id: "other", paused_at: null, paused_by: null },
          error: "CHECK constraint failed",
        },
        {
          table: "kin_workers",
          row: { ...rows.kin_workers, worker_id: "worker-duplicate-thread" },
          error: "UNIQUE constraint failed",
        },
        {
          table: "kin_budget",
          row: { ...rows.kin_budget, day: "tomorrow" },
          error: "CHECK constraint failed",
        },
        {
          table: "kin_org_state",
          row: { ...rows.kin_org_state, org_id: "other" },
          error: "FOREIGN KEY constraint failed",
        },
        {
          table: "kin_events",
          row: { ...rows.kin_events, event_id: "duplicate" },
          error: "UNIQUE constraint failed",
        },
        {
          table: "kin_wakeups",
          row: { ...rows.kin_wakeups, wakeup_id: "overlap" },
          error: "UNIQUE constraint failed",
        },
        {
          table: "kin_events",
          row: { ...rows.kin_events, event_id: "cross-org", org_id: "other", dedupe_key: null },
          error: "FOREIGN KEY constraint failed",
        },
        {
          table: "kin_events",
          row: { ...rows.kin_events, event_id: "invalid", state: "unknown", dedupe_key: null },
          error: "CHECK constraint failed",
        },
        {
          table: "kin_budget",
          row: { ...rows.kin_budget, day: "2026-11-08", lead_units: -1 },
          error: "CHECK constraint failed",
        },
      ];
      for (const { table, row, error } of rejected) {
        const result = yield* Effect.exit(sql`INSERT INTO ${sql(table)} ${sql.insert(row)}`);
        assert.isTrue(Exit.isFailure(result));
        assert.include(String(result), error);
      }
      for (const eventId of ["no-dedupe-1", "no-dedupe-2"]) {
        yield* sql`INSERT INTO kin_events ${sql.insert({ ...rows.kin_events, event_id: eventId, dedupe_key: null })}`;
      }
      assert.strictEqual((yield* sql`SELECT * FROM kin_events`).length, 3);
      for (const { eventId, priority, receivedAt, notBefore } of [
        { eventId: "later", priority: "P0", receivedAt: 1000, notBefore: 2000 },
        { eventId: "ready-low", priority: "P2", receivedAt: 9, notBefore: null },
        { eventId: "ready-high", priority: "P0", receivedAt: 10, notBefore: null },
      ]) {
        yield* sql`INSERT INTO kin_events ${sql.insert({
          ...rows.kin_events,
          event_id: eventId,
          tag: "future-event",
          priority,
          received_at: receivedAt,
          not_before: notBefore,
          state: "queued",
          dedupe_key: null,
        })}`;
      }
      assert.deepStrictEqual(
        yield* sql`SELECT event_id FROM kin_events
          WHERE org_id = 'org' AND agent_id = 'lead' AND state = 'queued'
            AND (not_before IS NULL OR not_before <= 1000)
          ORDER BY priority, received_at`,
        [{ event_id: "ready-high" }, { event_id: "ready-low" }],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT typeof(received_at) AS received_type, typeof(not_before) AS not_before_type
          FROM kin_events WHERE event_id = 'later'`,
        [{ received_type: "integer", not_before_type: "integer" }],
      );
      yield* sql`UPDATE kin_workers SET status = 'future-upstream-status' WHERE worker_id = 'worker'`;
      assert.deepStrictEqual(
        yield* sql`SELECT status FROM kin_workers WHERE worker_id = 'worker'`,
        [{ status: "future-upstream-status" }],
      );
      yield* sql`UPDATE kin_workers SET status = ${rows.kin_workers.status} WHERE worker_id = 'worker'`;

      assert.deepStrictEqual(yield* runKinMigrations(), []);
      for (const [table, row] of Object.entries(rows)) {
        if (table === "kin_events") continue;
        assert.deepStrictEqual(yield* sql`SELECT * FROM ${sql(table)} WHERE org_id = 'org'`, [row]);
      }
      assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("accepts phase-2 authors and records while enforcing chat and message uniqueness", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES ('org', 'Kin', ${timestamp})`;
      for (const person of ["owner", "person", "guest"]) {
        yield* sql`
          INSERT INTO kin_people (person_id, org_id, handle, display_name, github_login, created_at)
          VALUES (${person}, 'org', ${person}, ${person}, NULL, ${timestamp})
        `;
      }
      for (const [agent, role] of [
        ["lead", "lead"],
        ["router", "router"],
      ]) {
        yield* sql`
          INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at, retired_at)
          VALUES (${agent}, 'org', ${agent}, ${role}, 'owner', ${timestamp}, NULL)
        `;
        yield* sql`
          INSERT INTO kin_agent_threads (thread_id, org_id, agent_id, started_at, ended_at)
          VALUES (${`thread-${agent}`}, 'org', ${agent}, ${timestamp}, NULL)
        `;
      }
      yield* sql`
        INSERT INTO kin_session_bindings (session_id, org_id, person_id, bound_at, revoked_at)
        VALUES ('upstream-session-not-required', 'org', 'person', ${timestamp}, NULL)
      `;
      for (const kind of ["team_group", "project_group", "router", "direct"]) {
        yield* sql`
          INSERT INTO kin_chats (
            chat_id, org_id, kind, title, team_id, direct_key, last_seq, last_message_at, created_at, archived_at
          ) VALUES (
            ${kind}, 'org', ${kind}, ${kind === "direct" ? null : "Team"},
            ${kind === "team_group" ? "team" : null}, ${kind === "direct" ? "owner:lead" : null},
            0, NULL, ${timestamp}, NULL
          )
        `;
      }
      const members = [
        { id: "owner", kind: "person", role: "owner" },
        { id: "person", kind: "person", role: "member" },
        { id: "guest", kind: "person", role: "guest" },
        { id: "lead", kind: "agent", role: "member" },
        { id: "router", kind: "agent", role: "member" },
      ];
      for (const member of members) {
        yield* sql`
          INSERT INTO kin_chat_members (
            member_id, org_id, chat_id, principal_kind, person_id, agent_id, role, joined_at, left_at, muted_until
          ) VALUES (
            ${`member-${member.id}`}, 'org', 'team_group', ${member.kind},
            ${member.kind === "person" ? member.id : null}, ${member.kind === "agent" ? member.id : null},
            ${member.role}, ${timestamp}, NULL, NULL
          )
        `;
      }
      const authors = [
        ...members.map((member) => ({
          id: member.id,
          kind: member.kind === "agent" ? "agent" : "human",
          role: member.role,
        })),
        { id: "system", kind: "system", role: "member" },
      ];
      for (const [index, author] of authors.entries()) {
        yield* sql`
          INSERT INTO kin_messages (
            message_id, org_id, chat_id, seq, author_kind, author_person_id, author_agent_id,
            author_owner_person_id, author_thread_id, author_member_id, author_role, kind, body,
            intent, mentions_json, reply_to, widget_id, floor_run_id, status, sent_by,
            client_message_id, created_at, edited_at
          ) VALUES (
            ${`message-${author.id}`}, 'org', 'team_group', ${index + 1}, ${author.kind},
            ${author.kind === "human" ? author.id : null}, ${author.kind === "agent" ? author.id : null},
            ${author.kind === "agent" ? "owner" : null}, ${author.kind === "agent" ? `thread-${author.id}` : null},
            ${author.kind === "system" ? null : `member-${author.id}`}, ${author.role},
            ${author.kind === "system" ? "system" : "text"}, ${`From ${author.id}`},
            ${author.kind === "agent" ? "question" : null}, '["member-owner"]', NULL,
            ${author.id === "lead" ? "widget" : null}, ${author.kind === "agent" ? "floor-run" : null},
            ${author.id === "guest" ? "suggested" : "posted"}, NULL,
            ${author.kind === "human" ? "client-1" : null}, ${timestamp}, NULL
          )
        `;
      }
      yield* sql`
        INSERT INTO kin_widgets (
          widget_id, org_id, chat_id, message_id, widget_class, type, revision, state_json,
          source_thread_id, source_item_id, feed_kind, feed_key, awaiting_json, pinned_at, closed_at, updated_at
        ) VALUES (
          'widget', 'org', 'team_group', 'message-lead', 'native', 'decision', 1, '{"question":"Ship?"}',
          NULL, NULL, NULL, NULL, '["owner"]', NULL, NULL, ${timestamp}
        )
      `;
      yield* sql`
        INSERT INTO kin_read_state (chat_id, member_id, org_id, last_read_seq, updated_at)
        VALUES ('team_group', 'member-owner', 'org', 2, ${timestamp})
      `;
      yield* sql`
        INSERT INTO kin_waiting (
          waiting_id, org_id, person_id, chat_id, message_id, widget_id, reason, created_at, resolved_at, resolution
        ) VALUES ('waiting', 'org', 'owner', 'team_group', 'message-lead', 'widget', 'decision', ${timestamp}, NULL, NULL)
      `;
      assert.deepStrictEqual(yield* sql`SELECT person_id FROM kin_people ORDER BY person_id`, [
        { person_id: "guest" },
        { person_id: "owner" },
        { person_id: "person" },
      ]);
      assert.strictEqual((yield* sql`SELECT * FROM kin_chat_members`).length, 5);
      assert.strictEqual((yield* sql`SELECT * FROM kin_agents`).length, 2);
      assert.strictEqual((yield* sql`SELECT * FROM kin_agent_threads`).length, 2);
      assert.deepStrictEqual(yield* sql`SELECT session_id, revoked_at FROM kin_session_bindings`, [
        { session_id: "upstream-session-not-required", revoked_at: null },
      ]);
      assert.deepStrictEqual(
        yield* sql`SELECT author_kind, author_role, status, author_thread_id, author_owner_person_id FROM kin_messages ORDER BY seq`,
        authors.map((author) => ({
          author_kind: author.kind,
          author_role: author.role,
          status: author.id === "guest" ? "suggested" : "posted",
          author_thread_id: author.kind === "agent" ? `thread-${author.id}` : null,
          author_owner_person_id: author.kind === "agent" ? "owner" : null,
        })),
      );
      assert.deepStrictEqual(yield* sql`SELECT state_json, closed_at FROM kin_widgets`, [
        { state_json: '{"question":"Ship?"}', closed_at: null },
      ]);
      assert.deepStrictEqual(yield* sql`SELECT last_read_seq FROM kin_read_state`, [
        { last_read_seq: 2 },
      ]);
      assert.deepStrictEqual(
        yield* sql`SELECT person_id, reason, resolved_at, resolution FROM kin_waiting`,
        [{ person_id: "owner", reason: "decision", resolved_at: null, resolution: null }],
      );
      const duplicateDirect = yield* Effect.exit(sql`
        INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
        VALUES ('duplicate', 'org', 'direct', 'owner:lead', 0, ${timestamp})
      `);
      assert.isTrue(Exit.isFailure(duplicateDirect));
      assert.include(
        String(duplicateDirect),
        "UNIQUE constraint failed: kin_chats.org_id, kin_chats.direct_key",
      );
      const duplicateSeq = yield* Effect.exit(sql`
        INSERT INTO kin_messages (
          message_id, org_id, chat_id, seq, author_kind, author_role, kind, body, mentions_json, status, created_at
        ) VALUES ('duplicate', 'org', 'team_group', 1, 'system', 'member', 'system', '', '[]', 'posted', ${timestamp})
      `);
      assert.isTrue(Exit.isFailure(duplicateSeq));
      assert.include(
        String(duplicateSeq),
        "UNIQUE constraint failed: kin_messages.chat_id, kin_messages.seq",
      );
      const duplicateClientId = yield* Effect.exit(sql`
        INSERT INTO kin_messages (
          message_id, org_id, chat_id, seq, author_kind, author_person_id, author_member_id,
          author_role, kind, body, mentions_json, status, client_message_id, created_at
        ) VALUES (
          'duplicate-client', 'org', 'team_group', 7, 'human', 'owner', 'member-owner',
          'owner', 'text', '', '[]', 'posted', 'client-1', ${timestamp}
        )
      `);
      assert.isTrue(Exit.isFailure(duplicateClientId));
      assert.include(
        String(duplicateClientId),
        "UNIQUE constraint failed: kin_messages.chat_id, kin_messages.author_member_id, kin_messages.client_message_id",
      );
      const rejected = [
        {
          name: "second owner",
          query: sql`UPDATE kin_chat_members SET role = 'owner' WHERE member_id = 'member-person'`,
          error: "UNIQUE constraint failed: kin_chat_members.org_id, kin_chat_members.chat_id",
        },
        {
          name: "direct chat without direct_key",
          query: sql`
            INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
            VALUES ('direct-no-key', 'org', 'direct', NULL, 0, ${timestamp})
          `,
          error: "CHECK constraint failed",
        },
        {
          name: "human message without a person",
          query: sql`
            INSERT INTO kin_messages (
              message_id, org_id, chat_id, seq, author_kind, author_role, kind, body, mentions_json, status, created_at
            ) VALUES ('human-no-person', 'org', 'team_group', 8, 'human', 'owner', 'text', '', '[]', 'posted', ${timestamp})
          `,
          error: "CHECK constraint failed",
        },
        {
          name: "agent message without a thread",
          query: sql`
            INSERT INTO kin_messages (
              message_id, org_id, chat_id, seq, author_kind, author_agent_id, author_owner_person_id,
              author_member_id, author_role, kind, body, intent, mentions_json, status, created_at
            ) VALUES (
              'agent-no-thread', 'org', 'team_group', 9, 'agent', 'lead', 'owner', 'member-lead',
              'member', 'text', '', 'answer', '[]', 'posted', ${timestamp}
            )
          `,
          error: "CHECK constraint failed",
        },
        {
          name: "second open waiting row for one widget and person",
          query: sql`
            INSERT INTO kin_waiting (waiting_id, org_id, person_id, chat_id, widget_id, reason, created_at)
            VALUES ('waiting-again', 'org', 'owner', 'team_group', 'widget', 'decision', ${timestamp})
          `,
          error: "UNIQUE constraint failed: kin_waiting.widget_id, kin_waiting.person_id",
        },
      ];
      for (const { name, query, error } of rejected) {
        const exit = yield* Effect.exit(query);
        assert.isTrue(Exit.isFailure(exit), name);
        assert.include(String(exit), error, name);
      }
      for (const member of [members[0]!, members[3]!]) {
        const duplicateMember = yield* Effect.exit(sql`
          INSERT INTO kin_chat_members (
            member_id, org_id, chat_id, principal_kind, person_id, agent_id, role, joined_at
          ) VALUES (
            ${`duplicate-${member.id}`}, 'org', 'team_group', ${member.kind},
            ${member.kind === "person" ? member.id : null}, ${member.kind === "agent" ? member.id : null},
            ${member.role === "owner" ? "member" : member.role}, ${timestamp}
          )
        `);
        assert.isTrue(Exit.isFailure(duplicateMember));
        assert.include(
          String(duplicateMember),
          `UNIQUE constraint failed: kin_chat_members.chat_id, kin_chat_members.${member.kind}_id`,
        );
      }
      assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
    }).pipe(Effect.provide(layer)),
  );
});

it.effect("K038 preserves legacy session bindings and millisecond timestamps", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE kin_orgs (org_id TEXT PRIMARY KEY)`;
    yield* sql`CREATE TABLE kin_people (person_id TEXT PRIMARY KEY)`;
    yield* sql`INSERT INTO kin_orgs VALUES ('org')`;
    yield* sql`INSERT INTO kin_people VALUES ('person')`;
    yield* sql`CREATE TABLE kin_session_bindings (
      session_id TEXT, org_id TEXT, person_id TEXT, bound_at TEXT, revoked_at TEXT,
      PRIMARY KEY(session_id, org_id))`;
    yield* sql`INSERT INTO kin_session_bindings VALUES ('device', 'org', 'person',
      '2026-11-07T00:00:00.123Z', '2026-11-07T00:00:00.456Z')`;
    yield* PeopleInvitesMigration;
    assert.deepStrictEqual(
      yield* sql`SELECT bound_at, revoked_at, typeof(bound_at) AS kind
      FROM kin_session_bindings WHERE org_id = 'org' AND session_id = 'device'`,
      [{ bound_at: 1794009600123, revoked_at: 1794009600456, kind: "integer" }],
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("K058 adds Work to a database at K057, keeps its rows, and reruns without changes", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runKinMigrations();
    yield* sql`DROP TABLE kin_record_cursors`;
    yield* sql`DROP TABLE kin_record_changes`;
    yield* sql`DROP TABLE kin_record_links`;
    yield* sql`DROP TABLE kin_records`;
    yield* sql`DROP TABLE kin_registers`;
    yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 58`;
    yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES ('org', 'Kin', ${timestamp})`;
    assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(58));
    assert.deepStrictEqual(yield* sql`SELECT org_id FROM kin_orgs`, [{ org_id: "org" }]);
    yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, created_at)
      VALUES ('org', 'work', 'Work', 'W', 1)`;
    yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, owner_kind,
        owner_id, created_by_kind, origin_key, created_at, updated_at)
      VALUES ('org', 'rec', 'work', 'W-1', 'Ship the invented report', 'person', 'p', 'person',
        'owner:1', 1, 1)`;
    assert.deepStrictEqual(
      yield* sql`SELECT state, side, rev, sensitive, confirmed FROM kin_records`,
      [{ state: "open", side: "ours", rev: 1, sensitive: 0, confirmed: 1 }],
    );
    // Five states, nothing else.
    assert.isTrue(
      Exit.isFailure(yield* sql`UPDATE kin_records SET state = 'backlog'`.pipe(Effect.exit)),
    );
    assert.deepStrictEqual(yield* runKinMigrations(), []);
    yield* K058Work;
    assert.lengthOf(yield* sql`SELECT 1 FROM kin_records`, 1);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "K059 to K061 upgrade a database at K058 to attempts alone, and K061 reruns without changes",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runKinMigrations();
      yield* sql`DROP TABLE kin_worker_attempts`;
      yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 59`;
      yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES ('org', 'Kin', ${timestamp})`;
      assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(59));
      assert.lengthOf(
        yield* sql`SELECT 1 FROM sqlite_master WHERE name = 'kin_worker_withdrawals'`,
        0,
      );
      yield* sql`INSERT INTO kin_worker_attempts (org_id, worker_id, started_at, agent_id)
        VALUES ('org', 'wk-1', 5, 'lead')`;
      // A stop is whole: its time, key and state together, or none of them.
      assert.isTrue(
        Exit.isFailure(yield* sql`UPDATE kin_worker_attempts SET stopped_at = 6`.pipe(Effect.exit)),
      );
      assert.isTrue(
        Exit.isFailure(
          yield* sql`UPDATE kin_worker_attempts SET intent = 'merge'`.pipe(Effect.exit),
        ),
      );
      assert.deepStrictEqual(yield* runKinMigrations(), []);
      yield* K061WorkerAttempts;
      assert.lengthOf(yield* sql`SELECT 1 FROM kin_worker_attempts`, 1);
    }).pipe(Effect.provide(layer)),
);

it.effect("K061 turns the withdrawals K059 stored into stops of those attempts", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runKinMigrations();
    yield* sql`DROP TABLE kin_worker_attempts`;
    yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 61`;
    yield* K059WorkerWithdrawals;
    yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES ('org', 'Kin', ${timestamp})`;
    yield* sql`INSERT INTO kin_worker_withdrawals (org_id, record_id, seq, worker_id, started_at,
        agent_id, record_key, state, created_at)
      VALUES ('org', 'rec', 3, 'wk-1', 5, 'lead', 'W-1', 'pending', 7),
        ('org', 'rec', 4, 'wk-1', 5, 'lead', 'W-1', 'settled', 8),
        ('org', 'rec', 3, 'wk-2', 9, 'lead', 'W-1', 'failed', 7),
        ('org', 'rec', 3, 'wk-3', 9, 'lead', 'W-1', 'settled', 7)`;
    assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(61));
    assert.deepStrictEqual(
      yield* sql`SELECT worker_id, started_at, agent_id, withdrawn_at, stopped_at, stop_key,
          stop_label, stop_state FROM kin_worker_attempts ORDER BY worker_id`,
      [
        {
          worker_id: "wk-1",
          started_at: 5,
          agent_id: "lead",
          withdrawn_at: 7,
          stopped_at: 7,
          stop_key: "kin-withdrawn:wk-1:3",
          stop_label: "W-1",
          stop_state: "pending",
        },
        {
          worker_id: "wk-2",
          started_at: 9,
          agent_id: "lead",
          withdrawn_at: 7,
          stopped_at: 7,
          stop_key: "kin-withdrawn:wk-2:3",
          stop_label: "W-1",
          stop_state: "failed",
        },
        {
          worker_id: "wk-3",
          started_at: 9,
          agent_id: "lead",
          withdrawn_at: 7,
          stopped_at: 7,
          stop_key: "kin-withdrawn:wk-3:3",
          stop_label: "W-1",
          stop_state: "sent",
        },
      ],
    );
    assert.lengthOf(
      yield* sql`SELECT 1 FROM sqlite_master WHERE name = 'kin_worker_withdrawals'`,
      0,
    );
    assert.deepStrictEqual(yield* runKinMigrations(), []);
    yield* K061WorkerAttempts;
    assert.lengthOf(yield* sql`SELECT 1 FROM kin_worker_attempts`, 3);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "K060 gives a K059 database's entries a repository and keeps them, and reruns cleanly",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runKinMigrations();
      // Back to K059: the table as K058 made it, with an entry in it.
      yield* sql`DROP INDEX idx_kin_records_register`;
      yield* sql`DROP INDEX idx_kin_records_repo`;
      yield* sql`ALTER TABLE kin_records DROP COLUMN repo`;
      yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 60`;
      yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES ('org', 'Kin', ${timestamp})`;
      yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, created_at)
      VALUES ('org', 'work', 'Work', 'W', 1)`;
      yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, owner_kind,
        owner_id, created_by_kind, origin_key, created_at, updated_at)
      VALUES ('org', 'rec', 'work', 'W-1', 'Ship the invented report', 'person', 'p', 'person',
        'owner:1', 1, 1)`;
      assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(60));
      assert.deepStrictEqual(yield* sql`SELECT key, repo FROM kin_records`, [
        { key: "W-1", repo: null },
      ]);
      assert.deepStrictEqual(yield* runKinMigrations(), []);
      yield* K060WorkClients;
      assert.lengthOf(yield* sql`SELECT 1 FROM kin_records`, 1);
    }).pipe(Effect.provide(layer)),
);

it.effect("K062 upgrades a database at K061, keeps its attempts, and reruns cleanly", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runKinMigrations();
    // Back to K061: its attempts table as it made it, with an attempt in it.
    yield* sql`DROP INDEX idx_kin_worker_attempts_ready`;
    yield* sql`DROP TABLE kin_wakeup_sensitive_reads`;
    for (const column of [
      "visibility",
      "reviewed_sha",
      "files_json",
      "public_at",
      "sensitive_at",
      "ready_at",
      "ready_sha",
      "ready_title",
      "ready_card_id",
      "approved_sha",
      "approved_title",
      "approved_by",
      "approved_at",
      "declined_by",
      "declined_at",
    ])
      yield* sql.unsafe(`ALTER TABLE kin_worker_attempts DROP COLUMN ${column}`);
    yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 62`;
    yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES ('org', 'Kin', ${timestamp})`;
    yield* sql`INSERT INTO kin_worker_attempts (org_id, worker_id, started_at, agent_id, pushed_sha)
      VALUES ('org', 'wk-1', 5, 'lead', 'abc')`;
    assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(62));
    assert.deepStrictEqual(
      yield* sql`SELECT worker_id, pushed_sha, visibility, sensitive_at, ready_sha, approved_sha,
          declined_at FROM kin_worker_attempts`,
      [
        {
          worker_id: "wk-1",
          pushed_sha: "abc",
          visibility: null,
          sensitive_at: null,
          ready_sha: null,
          approved_sha: null,
          declined_at: null,
        },
      ],
    );
    assert.lengthOf(yield* sql`SELECT 1 FROM kin_wakeup_sensitive_reads`, 0);
    assert.deepStrictEqual(yield* runKinMigrations(), []);
    yield* K062WorkerPublishApproval;
    assert.lengthOf(yield* sql`SELECT 1 FROM kin_worker_attempts`, 1);
  }).pipe(Effect.provide(layer)),
);

it.effect.each([
  ["K058", 59],
  ["K062", 63],
] as const)(
  "K063 gives a worker still open at %s a legacy attempt naming no event, and reruns cleanly",
  ([, from]) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runKinMigrations();
      if (from === 59) yield* sql`DROP TABLE kin_worker_attempts`;
      else yield* sql`ALTER TABLE kin_worker_attempts DROP COLUMN legacy`;
      yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= ${from}`;
      yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES ('org', 'Kin', ${timestamp})`;
      // Workers alone: their lead and wake-up rows add nothing here.
      yield* sql`PRAGMA foreign_keys = OFF`;
      yield* sql`INSERT INTO kin_workers (worker_id, org_id, agent_id, wakeup_id, kind, thread_id,
          model_json, provenance_json, status, started_at, ended_at)
        VALUES ('wk-open', 'org', 'lead', 'w', 'build', 't-1', '{}', '{}', 'running', 5, NULL),
          ('wk-ended', 'org', 'lead', 'w', 'build', 't-2', '{}', '{}', 'completed', 5, 6),
          ('wk-tracked', 'org', 'lead', 'w', 'build', 't-3', '{}', '{}', 'running', 7, NULL),
          ('wk-lazy', 'org', 'lead', 'w', 'build', 't-4', '{}', '{}', 'running', 8, NULL)`;
      // At K062 a row could already exist for an old worker, made lazily and naming no event.
      if (from === 63)
        yield* sql`INSERT INTO kin_worker_attempts (org_id, worker_id, started_at, agent_id,
            source_event_id)
          VALUES ('org', 'wk-tracked', 7, 'lead', 'ask'), ('org', 'wk-lazy', 8, 'lead', NULL)`;
      const applied = (yield* runKinMigrations()).map(([id]) => id);
      assert.include(applied, 63);
      const rows = () =>
        sql`SELECT worker_id, started_at, source_event_id, legacy, withdrawn_at, stopped_at
          FROM kin_worker_attempts ORDER BY worker_id`;
      const open = { withdrawn_at: null, stopped_at: null };
      const expected = [
        { worker_id: "wk-lazy", started_at: 8, source_event_id: null, legacy: 1, ...open },
        { worker_id: "wk-open", started_at: 5, source_event_id: null, legacy: 1, ...open },
        from === 63
          ? { worker_id: "wk-tracked", started_at: 7, source_event_id: "ask", legacy: 0, ...open }
          : { worker_id: "wk-tracked", started_at: 7, source_event_id: null, legacy: 1, ...open },
      ];
      assert.deepStrictEqual(yield* rows(), expected);
      assert.deepStrictEqual(
        yield* sql`SELECT worker_id, status, ended_at FROM kin_workers ORDER BY worker_id`,
        // K164 ends what was still open, now that workers are gone.
        [
          { worker_id: "wk-ended", status: "completed", ended_at: 6 },
          { worker_id: "wk-lazy", status: "failed", ended_at: 0 },
          { worker_id: "wk-open", status: "failed", ended_at: 0 },
          { worker_id: "wk-tracked", status: "failed", ended_at: 0 },
        ],
      );
      assert.deepStrictEqual(yield* runKinMigrations(), []);
      yield* K063LegacyWorkerAttempts;
      assert.deepStrictEqual(yield* rows(), expected);
    }).pipe(Effect.provide(layer)),
);

it.effect("K164 keeps a worker's PR on the Work entry it belongs to, and reruns cleanly", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runKinMigrations();
    yield* sql`DROP TABLE kin_task_charges`;
    yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 164`;
    // Workers and links alone: their lead, wake-up and entry rows add nothing here.
    yield* sql`PRAGMA foreign_keys = OFF`;
    yield* sql`INSERT INTO kin_workers (worker_id, org_id, agent_id, wakeup_id, kind, thread_id,
        model_json, provenance_json, status, started_at, ended_at, pull_request_number,
        pull_request_url)
      VALUES ('wk-pr', 'org', 'lead', 'w', 'build', 't-1', '{}', '{}', 'completed', 5, 6, 12,
          'https://github.com/owner/repo/pull/12'),
        ('wk-none', 'org', 'lead', 'w', 'build', 't-2', '{}', '{}', 'running', 5, NULL, NULL, NULL)`;
    yield* sql`INSERT INTO kin_record_links (org_id, record_id, kind, target, relation, created_at)
      VALUES ('org', 'entry', 'worker', 'wk-pr', 'attempt', 1),
        ('org', 'entry', 'worker', 'wk-none', 'attempt', 1)`;
    assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(164));
    const links = sql`SELECT kind, target, relation, label FROM kin_record_links ORDER BY kind, target`;
    const expected = [
      {
        kind: "pull_request",
        target: "https://github.com/owner/repo/pull/12",
        relation: "attempt",
        label: "PR #12",
      },
      { kind: "worker", target: "wk-none", relation: "attempt", label: null },
      { kind: "worker", target: "wk-pr", relation: "attempt", label: null },
    ];
    assert.deepStrictEqual(yield* links, expected);
    yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 164`;
    yield* runKinMigrations();
    assert.deepStrictEqual(yield* links, expected);
  }).pipe(Effect.provide(layer)),
);

it.effect("K166 declines a review still waiting on its Post card and clears the card", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runKinMigrations();
    yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 166`;
    // Posts, their cards and the chat (its change counter) alone: org and lead rows add nothing.
    yield* sql`PRAGMA foreign_keys = OFF`;
    yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
      VALUES ('dm', 'org', 'direct', 'owner:lead', 2, ${timestamp})`;
    for (const [post, state, seq] of [
      ["open", "open", 1],
      ["posted", "posted", 2],
    ] as const) {
      const widgetId = `review-${post}`;
      yield* sql`INSERT INTO kin_pr_review_posts (org_id, post_id, agent_id, repo, number,
          review_json, state, widget_id, proposed_at)
        VALUES ('org', ${post}, 'lead', 'owner/repo', 12, '{}', ${state}, ${widgetId}, 1)`;
      yield* sql`INSERT INTO kin_messages (org_id, chat_id, message_id, seq, author_kind,
          author_role, kind, body, mentions_json, widget_id, status, created_at)
        VALUES ('org', 'dm', ${widgetId}, ${seq}, 'system', 'member', 'system', 'Post?', '[]',
          ${widgetId}, 'posted', ${timestamp})`;
      yield* sql`INSERT INTO kin_widgets (widget_id, org_id, chat_id, message_id, widget_class,
          type, revision, state_json, awaiting_json, updated_at)
        VALUES (${widgetId}, 'org', 'dm', ${widgetId}, 'native', 'choice', 1, '{}', '["owner"]',
          ${timestamp})`;
      yield* sql`INSERT INTO kin_waiting (waiting_id, org_id, person_id, chat_id, message_id,
          widget_id, reason, created_at)
        VALUES (${`waiting-${post}`}, 'org', 'owner', 'dm', ${widgetId}, ${widgetId}, 'decision',
          ${timestamp})`;
    }
    assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(166));
    const shown = sql`SELECT p.post_id AS post, p.state, m.status,
        w.closed_at IS NOT NULL AS closed, q.resolved_at IS NOT NULL AS resolved
      FROM kin_pr_review_posts p
        JOIN kin_messages m ON m.message_id = p.widget_id
        JOIN kin_widgets w ON w.widget_id = p.widget_id
        JOIN kin_waiting q ON q.widget_id = p.widget_id
      ORDER BY p.post_id`;
    const expected = [
      { post: "open", state: "declined", status: "dismissed", closed: 1, resolved: 1 },
      { post: "posted", state: "posted", status: "posted", closed: 0, resolved: 0 },
    ];
    assert.deepStrictEqual(yield* shown, expected);
    yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 166`;
    yield* runKinMigrations();
    assert.deepStrictEqual(yield* shown, expected);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "K064 records who retired an agent and what retiring held, on a fresh or a K063 database, and reruns cleanly",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const shape = Effect.gen(function* () {
        const agents = yield* sql<{ name: string }>`PRAGMA table_info(kin_agents)`;
        const holds = yield* sql<{ name: string }>`PRAGMA table_info(kin_retirement_holds)`;
        return {
          retiredBy: agents.some((column) => column.name === "retired_by_person_id"),
          holds: holds.map((column) => column.name),
        };
      });
      const fresh = {
        retiredBy: true,
        holds: ["org_id", "agent_id", "kind", "target_id", "next_run_at", "held_at"],
      };
      yield* runKinMigrations();
      assert.deepStrictEqual(yield* shape, fresh);
      // Back to K063, with an agent retired before anyone recorded who did it.
      yield* sql`DROP TABLE kin_retirement_holds`;
      yield* sql`ALTER TABLE kin_agents DROP COLUMN retired_by_person_id`;
      yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 64`;
      yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES ('org', 'Kin', ${timestamp})`;
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
        VALUES ('owner', 'org', 'owner', 'Owner', ${timestamp})`;
      yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id,
          created_at, retired_at)
        VALUES ('old', 'org', 'Old', 'lead', 'owner', ${timestamp}, ${timestamp})`;
      assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(64));
      assert.deepStrictEqual(yield* shape, fresh);
      assert.deepStrictEqual(
        yield* sql`SELECT agent_id, retired_at, retired_by_person_id FROM kin_agents`,
        [{ agent_id: "old", retired_at: timestamp, retired_by_person_id: null }],
      );
      assert.deepStrictEqual(yield* runKinMigrations(), []);
      yield* K064AgentRetirement;
      assert.deepStrictEqual(yield* shape, fresh);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "K065 marks the wake-ups retiring aborted, on a fresh or a K064 database, and reruns cleanly",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const column = sql<{ name: string; type: string }>`SELECT name, type
        FROM pragma_table_info('kin_wakeups') WHERE name = 'retired_at'`;
      const fresh = [{ name: "retired_at", type: "INTEGER" }];
      yield* runKinMigrations();
      assert.deepStrictEqual(yield* column, fresh);
      // Back to K064, with a turn a join aborted.
      yield* sql`DROP INDEX idx_kin_wakeups_unretired_agent`;
      yield* sql`ALTER TABLE kin_wakeups DROP COLUMN retired_at`;
      yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 65`;
      yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES ('org', 'Kin', ${timestamp})`;
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
        VALUES ('owner', 'org', 'owner', 'Owner', ${timestamp})`;
      yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id,
          created_at)
        VALUES ('lead', 'org', 'Lead', 'lead', 'owner', ${timestamp})`;
      yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at)
        VALUES ('leads', 'org', 'project_group', 0, ${timestamp})`;
      yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json,
          worker_projects_json, owner_chat_id)
        VALUES ('lead', 'org', 'Lead', 0, '{}', '[]', 'leads')`;
      yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, model, started_at, status,
          event_ids, aborted_at)
        VALUES ('wake', 'org', 'lead', 'cheap', 1, 'running', '[]', 2)`;
      assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(65));
      assert.deepStrictEqual(yield* column, fresh);
      assert.deepStrictEqual(
        yield* sql`SELECT wakeup_id, aborted_at, retired_at FROM kin_wakeups`,
        [{ wakeup_id: "wake", aborted_at: 2, retired_at: null }],
      );
      const notInteger = yield* Effect.exit(
        sql`UPDATE kin_wakeups SET retired_at = 'soon' WHERE wakeup_id = 'wake'`,
      );
      assert.isTrue(Exit.isFailure(notInteger));
      assert.deepStrictEqual(yield* runKinMigrations(), []);
      yield* K065WakeupRetired;
      assert.deepStrictEqual(yield* column, fresh);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "K066 indexes each agent's unretired wake-ups, on a fresh or a K065 database, and reruns cleanly",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const index = sql<{ sql: string }>`SELECT sql FROM sqlite_master
        WHERE type = 'index' AND name = 'idx_kin_wakeups_unretired_agent'`;
      const plan = sql<{ detail: string }>`EXPLAIN QUERY PLAN UPDATE kin_wakeups SET retired_at = 1
        WHERE org_id = 'org' AND agent_id = 'lead' AND retired_at IS NULL`;
      yield* runKinMigrations();
      const fresh = yield* index;
      assert.strictEqual(fresh.length, 1);
      assert.include(fresh[0]!.sql, "WHERE retired_at IS NULL");
      assert.include(
        (yield* plan).map((row) => row.detail).join("\n"),
        "idx_kin_wakeups_unretired_agent",
      );
      // Back to K065.
      yield* sql`DROP INDEX idx_kin_wakeups_unretired_agent`;
      yield* sql`DROP TABLE kin_worker_network`;
      yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 66`;
      assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(66));
      assert.deepStrictEqual(yield* index, fresh);
      assert.deepStrictEqual(yield* runKinMigrations(), []);
      yield* K066WakeupsUnretiredIndex;
      assert.deepStrictEqual(yield* index, fresh);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "K067 indexes a K066 database's entries for search, and reruns without a second copy",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const found = sql<{
        rowid: number;
      }>`SELECT rowid FROM kin_search WHERE kin_search MATCH 'invented'`;
      yield* runKinMigrations();
      // Back to K066, with an entry in it.
      yield* sql`DROP TABLE kin_search`;
      yield* sql`DROP TABLE kin_search_rows`;
      yield* sql`DROP TABLE kin_doc_versions`;
      yield* sql`ALTER TABLE kin_messages DROP COLUMN refs_json`;
      yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 67`;
      yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES ('org', 'Kin', ${timestamp})`;
      yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, created_at)
      VALUES ('org', 'work', 'Work', 'W', 1)`;
      yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, owner_kind,
        owner_id, created_by_kind, origin_key, created_at, updated_at)
      VALUES ('org', 'rec', 'work', 'W-1', 'Ship the invented report', 'person', 'p', 'person',
        'owner:1', 1, 1)`;
      assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(67));
      const indexed = yield* found;
      assert.lengthOf(indexed, 1);
      assert.deepStrictEqual(yield* runKinMigrations(), []);
      yield* K067Docs;
      assert.deepStrictEqual(yield* found, indexed);
    }).pipe(Effect.provide(layer)),
);

it.effect("K068 adds money to a database at K067, keeps its entries, and reruns cleanly", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runKinMigrations();
    // Back to K067.
    yield* sql`DROP TABLE kin_company_profile`;
    yield* sql`DROP TABLE kin_list_proposals`;
    yield* sql`DROP TABLE kin_record_payments`;
    yield* sql`DROP INDEX idx_kin_records_due`;
    yield* sql`DROP INDEX idx_kin_records_date`;
    yield* sql`ALTER TABLE kin_records DROP COLUMN date_all_day`;
    yield* sql`ALTER TABLE kin_registers DROP COLUMN rev`;
    yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 68`;
    yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES ('org', 'Kin', ${timestamp})`;
    yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, created_at)
      VALUES ('org', 'work', 'Work', 'W', 1)`;
    yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, owner_kind,
        owner_id, created_by_kind, origin_key, created_at, updated_at, amount_minor, currency)
      VALUES ('org', 'rec', 'work', 'W-1', 'Pay the invented vendor', 'person', 'p', 'person',
        'owner:1', 1, 1, 4200000, 'INR')`;
    assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(68));
    assert.deepStrictEqual(
      yield* sql`SELECT r.amount_minor, r.currency, r.date_all_day, g.rev FROM kin_records r
        JOIN kin_registers g ON g.org_id = r.org_id AND g.register_id = r.register_id`,
      [{ amount_minor: 4200000, currency: "INR", date_all_day: 0, rev: 1 }],
    );
    const pay = (id: string, minor: number) =>
      sql`INSERT INTO kin_record_payments (org_id, payment_id, record_id, amount_minor, currency,
          paid_on, origin_key, created_at, created_by_kind)
        VALUES ('org', ${id}, 'rec', ${minor}, 'INR', '2026-11-01', ${id}, 1, 'person')`.pipe(
        Effect.exit,
      );
    assert.isTrue(Exit.isSuccess(yield* pay("pay-1", 100)));
    // Payments are positive amounts, and one origin records one payment.
    assert.isTrue(Exit.isFailure(yield* pay("pay-2", 0)));
    assert.isTrue(
      Exit.isFailure(
        yield* sql`INSERT INTO kin_record_payments (org_id, payment_id, record_id, amount_minor,
            currency, paid_on, origin_key, created_at, created_by_kind)
          VALUES ('org', 'pay-3', 'rec', 5, 'INR', '2026-11-01', 'pay-1', 1, 'person')`.pipe(
          Effect.exit,
        ),
      ),
    );
    assert.deepStrictEqual(yield* runKinMigrations(), []);
    yield* K068WorkMoney;
    assert.lengthOf(yield* sql`SELECT 1 FROM kin_record_payments`, 1);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "K069 keeps one network change per org and host, allowed or removed, and reruns cleanly",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runKinMigrations();
      const write = (host: string, allowed: number) =>
        sql`INSERT INTO kin_worker_network (org_id, host, allowed, changed_at, changed_by)
          VALUES ('org', ${host}, ${allowed}, 1, 'owner')`;
      yield* write("example.com", 1);
      yield* write("github.com", 0);
      assert.isTrue((yield* Effect.exit(write("example.com", 0)))._tag === "Failure");
      assert.isTrue((yield* Effect.exit(write("other.com", 2)))._tag === "Failure");
      yield* sql`DROP TABLE kin_worker_network`;
      yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 69`;
      assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(69));
      yield* K069WorkerNetwork;
      assert.deepStrictEqual(yield* runKinMigrations(), []);
    }).pipe(Effect.provide(layer)),
);

it.effect("K071 adds a proposal's card and one profile change per card, and reruns cleanly", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runKinMigrations();
    yield* sql`INSERT INTO kin_list_proposals (org_id, proposal_id, agent_id, chat_id, wakeup_id,
        register_id, extends_existing, definition_json, chat_seq, proposed_at, widget_id)
      VALUES ('org', 'lp_1', 'lead', 'chat', 'wake', 'leave', 0, '{}', 0, 0, 'choice:card')`;
    const change = (id: string, widget: string | null) =>
      sql`INSERT INTO kin_profile_changes (org_id, change_id, agent_id, wakeup_id, patch_json,
          base_rev, widget_id, proposed_at)
        VALUES ('org', ${id}, 'lead', 'wake', '{}', 0, ${widget}, 0)`;
    yield* change("one", "choice:a");
    yield* change("two", null);
    yield* change("three", null);
    assert.isTrue((yield* Effect.exit(change("four", "choice:a")))._tag === "Failure");
    yield* sql`DROP TABLE kin_profile_changes`;
    yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 71`;
    assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(71));
    yield* K071OwnerAnswerCards;
    assert.deepStrictEqual(yield* runKinMigrations(), []);
    assert.lengthOf(
      yield* sql`SELECT 1 FROM kin_list_proposals WHERE widget_id = 'choice:card'`,
      1,
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("K072 issues each number once per series and entry, and reruns cleanly", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runKinMigrations();
    const issue = (seq: number, number: string, recordId: string) =>
      sql`INSERT INTO kin_issued_numbers (org_id, register_id, series, seq, number, record_id,
          issued_at, issued_by_kind, issued_by_id)
        VALUES ('org', 'invoices', 'INV|26-27', ${seq}, ${number}, ${recordId}, 1, 'person', 'p')`.pipe(
        Effect.exit,
      );
    yield* sql`PRAGMA foreign_keys = OFF`;
    assert.isTrue(Exit.isSuccess(yield* issue(1, "INV/26-27/001", "rec-1")));
    // One number per entry, one entry per number, one seq per series.
    assert.isTrue(Exit.isFailure(yield* issue(2, "INV/26-27/002", "rec-1")));
    assert.isTrue(Exit.isFailure(yield* issue(2, "INV/26-27/001", "rec-2")));
    assert.isTrue(Exit.isFailure(yield* issue(1, "INV/26-27/009", "rec-3")));
    yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 72`;
    assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(72));
    yield* K072GeneratedDocuments;
    assert.lengthOf(yield* sql`SELECT 1 FROM kin_issued_numbers`, 1);
  }).pipe(Effect.provide(layer)),
);

it.effect("K073 owes one push per key change, each notice's once, and reruns cleanly", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runKinMigrations();
    const owe = (thumbprint: string, change: string, messageId: string | null) =>
      sql`INSERT INTO kin_key_pushes (org_id, thumbprint, change, body, message_id, owed_at)
        VALUES ('org', ${thumbprint}, ${change}, 'Notice', ${messageId}, 1)`.pipe(Effect.exit);
    assert.isTrue(Exit.isSuccess(yield* owe("k1", "added", "kin-key-added:k1")));
    assert.isTrue(Exit.isSuccess(yield* owe("k1", "removed", null)));
    assert.isTrue(Exit.isSuccess(yield* owe("k2", "removed", null)));
    assert.isTrue(Exit.isFailure(yield* owe("k1", "added", null)));
    assert.isTrue(Exit.isFailure(yield* owe("k3", "added", "kin-key-added:k1")));
    assert.isTrue(Exit.isFailure(yield* owe("k3", "renamed", null)));
    yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 73`;
    assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(73));
    yield* K073KeyPushes;
    assert.lengthOf(yield* sql`SELECT 1 FROM kin_key_pushes`, 3);
  }).pipe(Effect.provide(layer)),
);

it.effect("K074 owes every document job's worktree until it is removed, and reruns cleanly", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runKinMigrations();
    yield* sql`INSERT INTO kin_doc_jobs (org_id, worker_id, agent_id, wakeup_id, mode,
        recipe_commit, inputs_sha256, sensitive, doc_origin, worktree_path, branch, audience,
        created_at)
      VALUES ('org', 'wk-1', 'lead', 'wake', 'document', '', 'h', 0, 'o', '/w', 'b', 'owner_only', 1)`;
    const owed = sql<{ workerId: string }>`SELECT worker_id AS "workerId" FROM kin_doc_jobs
      WHERE removed_at IS NULL ORDER BY worker_id`;
    assert.deepStrictEqual(yield* owed, [{ workerId: "wk-1" }]);
    yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 74`;
    assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(74));
    yield* K074DocJobCleanup;
    assert.deepStrictEqual(yield* owed, [{ workerId: "wk-1" }]);
  }).pipe(Effect.provide(layer)),
);

it.effect("K075 keeps what a rendered document was asked with, and reruns cleanly", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runKinMigrations();
    yield* sql`INSERT INTO kin_doc_jobs (org_id, worker_id, agent_id, wakeup_id, mode,
        recipe_commit, inputs_sha256, sensitive, doc_origin, worktree_path, branch, audience,
        created_at, removed_at, given_json, title, asked_by_person_id)
      VALUES ('org', 'rd-1', '', '', 'document', 'c', 'h', 0, 'o', '', '', 'owner_only', 1, 1,
        '{}', 'Invoice', 'person-1')`;
    yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 75`;
    assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(75));
    yield* K075ServerRenderedDocuments;
    assert.deepStrictEqual(
      yield* sql`SELECT given_json AS "givenJson", title, asked_by_person_id AS "by"
        FROM kin_doc_jobs`,
      [{ givenJson: "{}", title: "Invoice", by: "person-1" }],
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("K077 adds recipe labels and request fingerprints, and reruns cleanly", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runKinMigrations();
    yield* sql`INSERT INTO kin_orgs VALUES ('org', 'Invented Co', '2026-11-12T00:00:00.000Z')`;
    yield* sql`INSERT INTO kin_recipe_labels (org_id, recipe, commit_sha, sensitive, labelled_at)
      VALUES ('org', 'invoice', 'c1', 1, 1)`;
    yield* sql`INSERT INTO kin_doc_jobs (org_id, worker_id, agent_id, wakeup_id, mode,
        recipe_commit, inputs_sha256, sensitive, doc_origin, worktree_path, branch, audience,
        created_at, request_sha256)
      VALUES ('org', 'rd-1', '', '', 'document', 'c', 'h', 0, 'o', '', '', 'owner_only', 1, 'f')`;
    yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 77`;
    assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(77));
    yield* K077DocumentLabels;
    assert.deepStrictEqual(
      yield* sql`SELECT l.sensitive, j.request_sha256 AS "request" FROM kin_recipe_labels l
        JOIN kin_doc_jobs j ON j.org_id = l.org_id`,
      [{ sensitive: 1, request: "f" }],
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("K078 keeps one baseline per workspace, and reruns cleanly", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runKinMigrations();
    yield* sql`INSERT INTO kin_orgs VALUES ('org', 'Invented Co', '2026-11-12T00:00:00.000Z')`;
    yield* sql`INSERT INTO kin_recipe_label_baselines (org_id, commit_sha, recorded_at)
      VALUES ('org', ${"a".repeat(40)}, 1)`;
    yield* sql`INSERT INTO kin_recipe_label_baselines (org_id, commit_sha, recorded_at)
      VALUES ('org', ${"b".repeat(40)}, 2) ON CONFLICT (org_id) DO NOTHING`;
    yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 78`;
    // Later migrations rerun with it, and K080 leaves the column it already added.
    assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(78));
    assert.deepStrictEqual(
      yield* sql`SELECT commit_sha AS "commit" FROM kin_recipe_label_baselines`,
      [{ commit: "a".repeat(40) }],
    );
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "K137 makes the reserved owner the owner and everyone else a member, K143 no places, once",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runKinMigrations();
      yield* sql`INSERT INTO kin_orgs VALUES ('org', 'Invented Co', '2026-11-12T00:00:00.000Z')`;
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
      VALUES ('kin-default-owner', 'org', 'asha', 'Asha', '2026-11-12T00:00:00.000Z'),
        ('ravi', 'org', 'ravi', 'Ravi', '2026-11-12T00:00:00.000Z')`;
      yield* sql`UPDATE kin_people SET access = NULL`;
      yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 137`;
      assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(137));
      assert.deepStrictEqual(
        yield* sql`SELECT person_id AS "personId", access FROM kin_people ORDER BY person_id`,
        [
          { personId: "kin-default-owner", access: "owner" },
          { personId: "ravi", access: "member" },
        ],
      );
      // K143: everyone already here keeps Tasks alone.
      assert.deepStrictEqual(
        yield* sql`SELECT DISTINCT sees_clients + sees_docs + sees_money AS places FROM kin_people`,
        [{ places: 0 }],
      );
      for (const change of [
        sql`UPDATE kin_people SET access = 'owner' WHERE person_id = 'ravi'`,
        sql`UPDATE kin_people SET access = 'admin' WHERE person_id = 'ravi'`,
      ])
        assert.isTrue(Exit.isFailure(yield* Effect.exit(change)));
    }).pipe(Effect.provide(layer)),
);

it.effect("K088 lets a Dates list take an amount, keeps rendered figures, and reruns", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runKinMigrations();
    yield* sql`INSERT INTO kin_orgs VALUES ('org', 'Invented Co', '2026-11-12T00:00:00.000Z')`;
    for (const [id, prefix] of [
      ["dates", "DT"],
      ["leave", "LV"],
    ])
      yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in,
          definition_json, created_at)
        VALUES ('org', ${id}, ${id}, ${prefix}, 0, '{"noun":"date","amount":false}', 1)`;
    yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 88`;
    assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(88));
    yield* K088MoneyRecords;
    // What an issued document showed is never edited or removed.
    yield* sql`INSERT INTO kin_doc_jobs (org_id, worker_id, agent_id, wakeup_id, mode,
        recipe_commit, inputs_sha256, sensitive, doc_origin, worktree_path, branch, audience,
        created_at)
      VALUES ('org', 'rd-1', '', '', 'document', 'c', 'h', 1, 'recipe:invoice:r1', '', '',
        'owner_only', 1)`;
    yield* sql`INSERT INTO kin_doc_job_figures (org_id, worker_id, entry_record_id, number,
        total_minor, tax_minor, currency, taxes_json, rendered_at)
      VALUES ('org', 'rd-1', 'r1', 'INV/26-27/001', 118000, 18000, 'INR', '[]', 1)`;
    for (const change of [
      sql`UPDATE kin_doc_job_figures SET total_minor = 100000`,
      sql`DELETE FROM kin_doc_job_figures`,
    ])
      assert.isTrue(Exit.isFailure(yield* Effect.exit(change)));
    assert.deepStrictEqual(yield* sql`SELECT total_minor AS total FROM kin_doc_job_figures`, [
      { total: 118000 },
    ]);
    assert.deepStrictEqual(
      yield* sql`SELECT register_id AS id, json_extract(definition_json, '$.amount') AS amount,
          json_extract(definition_json, '$.noun') AS noun, rev
        FROM kin_registers ORDER BY register_id`,
      [
        { id: "dates", amount: 1, noun: "date", rev: 2 },
        { id: "leave", amount: 0, noun: "date", rev: 1 },
      ],
    );
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "K107 adds connections to a database at K106 with no outside reads, and reruns cleanly",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runKinMigrations();
      for (const table of [
        "kin_connection_calls",
        "kin_connection_tools",
        "kin_connections",
        "kin_wakeup_outside_reads",
        "kin_connection_turn_spend",
        "kin_event_outside",
      ])
        yield* sql.unsafe(`DROP TABLE ${table}`);
      yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 107`;
      yield* sql`INSERT INTO kin_orgs VALUES ('org', 'Invented Co', '2026-11-15T00:00:00.000Z')`;
      assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(107));
      yield* K107Connections;
      assert.deepStrictEqual(yield* sql`SELECT wakeup_id FROM kin_wakeup_outside_reads`, []);
      yield* sql`INSERT INTO kin_connections (org_id, connection_id, label, kind, url_host, auth,
        reach, state, created_at, updated_at)
      VALUES ('org', 'c1', 'Docs', 'remote', 'mcp.example.com', 'none', 'open', 'active', 1, 1)`;
      const refused = yield* sql`INSERT INTO kin_connections (org_id, connection_id, label, kind,
        url_host, auth, reach, state, created_at, updated_at)
      VALUES ('org', 'c2', 'Docs', 'remote', 'mcp.example.com', 'none', 'anywhere', 'active', 1, 1)`.pipe(
        Effect.exit,
      );
      assert.isTrue(Exit.isFailure(refused));
    }).pipe(Effect.provide(layer)),
);

it.effect("K131 carries each statement's wrong passwords into its budget, and reruns cleanly", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runKinMigrations();
    yield* sql`INSERT INTO kin_orgs VALUES ('org', 'Invented Co', '2026-11-12T00:00:00.000Z')`;
    for (const [id, card, chat] of [
      ["st_a", 5, 0],
      ["st_b", 2, 3],
      ["st_c", 0, 0],
    ] as const)
      yield* sql`INSERT INTO kin_bank_statements (org_id, statement_id, attachment_id, file_name,
          chat_id, agent_id, wakeup_id, status, created_at, password_attempts,
          chat_password_attempts)
        VALUES ('org', ${id}, ${`att-${id}`}, 'invented.pdf', 'chat', 'lead', 'wake',
          'needs_password', 1, ${card}, ${chat})`;
    yield* sql`DELETE FROM kin_statement_password_budget`;
    yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 131`;
    assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(131));
    const budget = sql`SELECT budget_key AS key, remaining, refill_at IS NOT NULL AS "refills"
      FROM kin_statement_password_budget ORDER BY budget_key`;
    // One out of tries takes a password again at once, as sending the file again let it before.
    const carried = [
      { key: "card:st:st_a", remaining: 0, refills: 1 },
      { key: "card:st:st_b", remaining: 3, refills: 0 },
      { key: "chat:st:st_b", remaining: 2, refills: 0 },
    ];
    assert.deepStrictEqual(yield* budget, carried);
    yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 131`;
    assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(131));
    assert.deepStrictEqual(yield* budget, carried);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "K142 lets Microsoft connections in and keeps every connection and what refers to it",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runKinMigrations();
      const schemaOf = () =>
        sql<{ name: string; sql: string }>`SELECT name, sql FROM sqlite_schema
        WHERE tbl_name = 'kin_connections' AND sql IS NOT NULL ORDER BY name`;
      const widened = yield* schemaOf();
      // Back to K141: the same rebuild, narrowing the CHECK again.
      yield* Effect.gen(function* () {
        yield* sql`PRAGMA defer_foreign_keys = ON`;
        yield* sql`CREATE TABLE back AS SELECT * FROM kin_connections`;
        yield* sql`DROP TABLE kin_connections`;
        for (const entry of widened)
          yield* sql.unsafe(entry.sql.replace("'zoho_books', 'microsoft')", "'zoho_books')"));
        yield* sql`INSERT INTO kin_connections SELECT * FROM back`;
        yield* sql`DROP TABLE back`;
      }).pipe(sql.withTransaction);
      yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 142`;
      yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES ('org', 'Kin', ${timestamp})`;
      const connection = (id: string, preset: string) =>
        sql`INSERT INTO kin_connections (org_id, connection_id, preset, label, kind, url_host, auth,
          reach, state, created_at, updated_at)
        VALUES ('org', ${id}, ${preset}, ${id}, 'builtin', 'mail.example', 'oauth', 'closed',
          'active', 1, 1)`.pipe(Effect.exit);
      assert.isTrue(Exit.isSuccess(yield* connection("conn_google", "google")));
      assert.isTrue(Exit.isFailure(yield* connection("conn_early", "microsoft")));
      yield* sql`INSERT INTO kin_connection_tools (org_id, connection_id, tool_name, definition_json,
        pin_digest, mode, suggested_mode, open_world, first_seen_at)
      VALUES ('org', 'conn_google', 'mail_send', '{}', 'd', 'ask', 'ask', 0, 1)`;
      yield* sql`INSERT INTO kin_connection_cursors (org_id, connection_id, checked_until, updated_at)
      VALUES ('org', 'conn_google', 5, 1)`;

      assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(142));
      assert.deepStrictEqual(yield* schemaOf(), widened);
      assert.isTrue(Exit.isSuccess(yield* connection("conn_outlook", "microsoft")));
      assert.isTrue(Exit.isFailure(yield* connection("conn_other", "yahoo")));
      assert.deepStrictEqual(
        yield* sql`SELECT t.tool_name, c.checked_until FROM kin_connection_tools t
        JOIN kin_connection_cursors c USING (org_id, connection_id)`,
        [{ tool_name: "mail_send", checked_until: 5 }],
      );
      assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
      // A tool of a connection that isn't there is still refused.
      assert.isTrue(
        Exit.isFailure(
          yield* sql`INSERT INTO kin_connection_tools (org_id, connection_id, tool_name,
            definition_json, pin_digest, mode, suggested_mode, open_world, first_seen_at)
          VALUES ('org', 'conn_gone', 'x', '{}', 'd', 'off', 'off', 0, 1)`.pipe(Effect.exit),
        ),
      );
      assert.deepStrictEqual(yield* runKinMigrations(), []);
    }).pipe(Effect.provide(layer)),
);

it.effect("K175 leaves existing K174 hand-offs with a null answer preference", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runKinMigrations();
    yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES ('org', 'Ambermill', ${timestamp})`;
    yield* sql`INSERT INTO kin_handoffs (org_id, message_id, from_agent_id, to_agent_id, event_id, created_at)
      VALUES ('org', 'legacy', 'chief', 'finance', 'event', 0)`;
    const columns = yield* sql<{ name: string }>`PRAGMA table_info(kin_handoffs)`;
    if (columns.some((column) => column.name === "wants_answer"))
      yield* sql`ALTER TABLE kin_handoffs DROP COLUMN wants_answer`;
    yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 175`;
    assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(175));
    assert.deepStrictEqual(yield* sql`SELECT wants_answer FROM kin_handoffs`, [
      { wants_answer: null },
    ]);
    assert.deepStrictEqual(yield* runKinMigrations(), []);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "K176 adds comments to a database at K175, leaving its entries without a stored asker",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runKinMigrations();
      yield* sql`DROP TABLE kin_record_comment_files`;
      yield* sql`DROP TABLE kin_record_comments`;
      yield* sql`ALTER TABLE kin_records DROP COLUMN asked_by_person_id`;
      yield* sql`ALTER TABLE kin_record_changes DROP COLUMN asked_by_person_id`;
      yield* sql`DROP INDEX idx_kin_record_changes_wakeup`;
      yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 176`;
      yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES ('org', 'Ambermill', ${timestamp})`;
      yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in, created_at)
      VALUES ('org', 'work', 'Work', 'W', 1, 0)`;
      yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, owner_kind,
        owner_id, created_by_kind, created_by_id, origin_key, created_at, updated_at)
      VALUES ('org', 'r1', 'work', 'W-1', 'Invented task', 'person', 'rhea', 'person', 'rhea',
        'o1', 0, 0)`;
      yield* sql`INSERT INTO kin_record_changes (org_id, record_id, rev, at, actor_kind, actor_id,
        via, kind, fields_json)
      VALUES ('org', 'r1', 1, 0, 'agent', 'chief', 'lead', 'created', '[]')`;
      assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(176));
      assert.deepStrictEqual(yield* sql`SELECT asked_by_person_id FROM kin_records`, [
        { asked_by_person_id: null },
      ]);
      assert.deepStrictEqual(yield* sql`SELECT asked_by_person_id FROM kin_record_changes`, [
        { asked_by_person_id: null },
      ]);
      assert.deepStrictEqual(yield* sql`SELECT * FROM kin_record_comments`, []);
      assert.deepStrictEqual(yield* runKinMigrations(), []);
    }).pipe(Effect.provide(layer)),
);

it.effect("K178 counts a send under way at the upgrade as started, and nothing else", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runKinMigrations();
    yield* sql`ALTER TABLE kin_connection_asks DROP COLUMN outside_from`;
    yield* sql`ALTER TABLE kin_connection_asks DROP COLUMN dispatched_at`;
    yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 178`;
    yield* sql`PRAGMA foreign_keys = OFF`;
    // Payloads as older builds stored them: a mail from before accounts, an event before F4.
    const mail = JSON.stringify({
      _tag: "email",
      to: ["meera@ambermill.example"],
      cc: [],
      subject: "Invoice INV-1",
      body: "Attached.",
      threadId: null,
      inReplyTo: null,
      references: null,
      attachments: [],
    });
    const event = JSON.stringify({
      _tag: "event",
      calendarId: "primary",
      eventId: "evt_1",
      title: "Weekly sync",
      start: "2026-11-20T15:00:00+05:30",
      end: "2026-11-20T15:30:00+05:30",
      timeZone: null,
      location: null,
      notes: null,
      invitees: [],
    });
    for (const [askId, state, decided, payload] of [
      ["open", "open", null, event],
      ["sending", "sending", 7, mail],
      ["sent", "sent", 5, mail],
    ] as const)
      yield* sql`INSERT INTO kin_connection_asks (org_id, ask_id, connection_id, tool_name,
          pin_digest, payload_json, agent_id, wakeup_id, chat_id, state, proposed_at, decided_at)
        VALUES ('org', ${askId}, 'conn', 'mail_send', 'pin', ${payload}, 'finance', 'wake', 'chat',
          ${state}, 1, ${decided})`;
    assert.deepStrictEqual(yield* runKinMigrations(), kinMigrationsFrom(178));
    const rows = yield* sql<{
      ask_id: string;
      outside_from: string | null;
      dispatched_at: number | null;
      payload_json: string;
    }>`SELECT ask_id, outside_from, dispatched_at, payload_json FROM kin_connection_asks
        ORDER BY ask_id`;
    assert.deepStrictEqual(
      rows.map(({ payload_json: _, ...row }) => row),
      [
        { ask_id: "open", outside_from: null, dispatched_at: null },
        { ask_id: "sending", outside_from: null, dispatched_at: 7 },
        { ask_id: "sent", outside_from: null, dispatched_at: null },
      ],
    );
    assert.deepStrictEqual(
      rows.map((row) => decodePrepared(row.payload_json)._tag),
      ["event", "email", "email"],
    );
    assert.deepStrictEqual(yield* runKinMigrations(), []);
  }).pipe(Effect.provide(layer)),
);
