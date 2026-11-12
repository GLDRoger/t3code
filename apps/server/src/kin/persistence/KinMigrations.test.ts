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
import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "../../persistence/Migrations.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { runKinMigrations } from "./KinMigrations.ts";
import * as KinPersistence from "./KinPersistence.ts";

const tableNames = [
  "kin_agent_threads",
  "kin_agents",
  "kin_approver_key_confirmations",
  "kin_approver_keys",
  "kin_audit",
  "kin_auth_key_repairs",
  "kin_auth_paired_sessions",
  "kin_auth_session_keys",
  "kin_budget",
  "kin_budget_charges",
  "kin_budget_limits",
  "kin_chat_levels",
  "kin_chat_members",
  "kin_chats",
  "kin_company_profile",
  "kin_cursor",
  "kin_deferral_runs",
  "kin_doc_files",
  "kin_doc_jobs",
  "kin_doc_versions",
  "kin_dream_runs",
  "kin_events",
  "kin_executions",
  "kin_floor_grants",
  "kin_floor_notices",
  "kin_floor_runs",
  "kin_grants",
  "kin_handoffs",
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
  "kin_memory_review_pulls",
  "kin_memory_shared_writes",
  "kin_message_attachments",
  "kin_messages",
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
  "kin_profile_changes",
  "kin_push_devices",
  "kin_reaction_wakes",
  "kin_reactions",
  "kin_read_state",
  "kin_recipe_label_baselines",
  "kin_recipe_labels",
  "kin_record_changes",
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
  "kin_trigger_fires",
  "kin_trigger_inbox",
  "kin_trigger_settings",
  "kin_triggers",
  "kin_visual_hosts",
  "kin_waiting",
  "kin_wakeup_sensitive_reads",
  "kin_wakeups",
  "kin_webhook_sources",
  "kin_widgets",
  "kin_worker_attempts",
  "kin_worker_charges",
  "kin_worker_network",
  "kin_workers",
];
const timestamp = "2026-11-07T00:00:00.000Z";
const layer = Layer.provideMerge(KinPersistence.layer, Sqlite.layerMemory);

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
        assert.deepStrictEqual(yield* kinHistory, [
          { migration_id: 1, name: "ChatCore" },
          { migration_id: 2, name: "Lead" },
          { migration_id: 3, name: "Triggers" },
          { migration_id: 4, name: "MemoryReads" },
          { migration_id: 5, name: "OneChatOwner" },
          { migration_id: 6, name: "Pings" },
          { migration_id: 7, name: "Budget" },
          { migration_id: 8, name: "Floor" },
          { migration_id: 9, name: "JudgeLog" },
          { migration_id: 10, name: "ChatChanges" },
          { migration_id: 11, name: "MemoryHeads" },
          { migration_id: 12, name: "SecretAllow" },
          { migration_id: 13, name: "Routines" },
          { migration_id: 14, name: "LeadToolCalls" },
          { migration_id: 15, name: "AuthSessionKeys" },
          { migration_id: 16, name: "DeferralRuns" },
          { migration_id: 17, name: "Workers" },
          { migration_id: 18, name: "Dreams" },
          { migration_id: 19, name: "WebhookSecretHash" },
          { migration_id: 20, name: "Approvals" },
          { migration_id: 21, name: "PushDevices" },
          { migration_id: 22, name: "ChatLevels" },
          { migration_id: 23, name: "ExecutionWriteStarted" },
          { migration_id: 24, name: "MemoryReviewPulls" },
          { migration_id: 25, name: "FloorGrantWakeup" },
          { migration_id: 26, name: "Reactions" },
          { migration_id: 27, name: "AuthorityBinding" },
          { migration_id: 28, name: "WakeupTimings" },
          { migration_id: 29, name: "DropJudgeLog" },
          { migration_id: 30, name: "ManyLeads" },
          { migration_id: 31, name: "LeadDeliveries" },
          { migration_id: 32, name: "WorkerEnvironment" },
          { migration_id: 33, name: "ApproverKeyConfirmations" },
          { migration_id: 34, name: "PerLeadWakeups" },
          { migration_id: 35, name: "RetireLevelCards" },
          { migration_id: 38, name: "PeopleInvites" },
          { migration_id: 39, name: "LeadHandoffs" },
          { migration_id: 40, name: "MessageAttachments" },
          { migration_id: 41, name: "GroupLead" },
          { migration_id: 42, name: "ReactionWakes" },
          { migration_id: 43, name: "WakeupAudience" },
          { migration_id: 44, name: "WakeupSharedSince" },
          { migration_id: 45, name: "WakeupAudienceAbort" },
          { migration_id: 46, name: "ChatCleared" },
          { migration_id: 47, name: "SilentMessages" },
          { migration_id: 50, name: "LeadAccess" },
          { migration_id: 51, name: "ChatSharing" },
          { migration_id: 52, name: "MemoryLabels" },
          { migration_id: 53, name: "MemorySharing" },
          { migration_id: 54, name: "SharedProjection" },
          { migration_id: 55, name: "ChatGrantsLapse" },
          { migration_id: 56, name: "SuggestionsByVersion" },
          { migration_id: 57, name: "Schedules" },
          { migration_id: 58, name: "Work" },
          { migration_id: 59, name: "WorkerWithdrawals" },
          { migration_id: 60, name: "WorkClients" },
          { migration_id: 61, name: "WorkerAttempts" },
          { migration_id: 62, name: "WorkerPublishApproval" },
          { migration_id: 63, name: "LegacyWorkerAttempts" },
          { migration_id: 64, name: "AgentRetirement" },
          { migration_id: 65, name: "WakeupRetired" },
          { migration_id: 66, name: "WakeupsUnretiredIndex" },
          { migration_id: 67, name: "Docs" },
          { migration_id: 68, name: "WorkMoney" },
          { migration_id: 69, name: "WorkerNetwork" },
          { migration_id: 70, name: "VisualHosts" },
          { migration_id: 71, name: "OwnerAnswerCards" },
          { migration_id: 72, name: "GeneratedDocuments" },
          { migration_id: 73, name: "KeyPushes" },
          { migration_id: 74, name: "DocJobCleanup" },
          { migration_id: 75, name: "ServerRenderedDocuments" },
          { migration_id: 76, name: "DocFiles" },
          { migration_id: 77, name: "DocumentLabels" },
          { migration_id: 78, name: "RecipeLabelBaselines" },
          { migration_id: 79, name: "ImportRuns" },
          { migration_id: 80, name: "RecipeJobPasses" },
        ]);
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
        assert.deepStrictEqual(
          yield* sql`SELECT name FROM pragma_table_info('kin_webhook_sources') WHERE pk > 0 ORDER BY pk`,
          [{ name: "org_id" }, { name: "source_id" }],
        );
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
        assert.deepStrictEqual(yield* kinHistory, [
          { migration_id: 1, name: "ChatCore" },
          { migration_id: 2, name: "Lead" },
          { migration_id: 3, name: "Triggers" },
          { migration_id: 4, name: "MemoryReads" },
          { migration_id: 5, name: "OneChatOwner" },
          { migration_id: 6, name: "Pings" },
          { migration_id: 7, name: "Budget" },
          { migration_id: 8, name: "Floor" },
          { migration_id: 9, name: "JudgeLog" },
          { migration_id: 10, name: "ChatChanges" },
          { migration_id: 11, name: "MemoryHeads" },
          { migration_id: 12, name: "SecretAllow" },
          { migration_id: 13, name: "Routines" },
          { migration_id: 14, name: "LeadToolCalls" },
          { migration_id: 15, name: "AuthSessionKeys" },
          { migration_id: 16, name: "DeferralRuns" },
          { migration_id: 17, name: "Workers" },
          { migration_id: 18, name: "Dreams" },
          { migration_id: 19, name: "WebhookSecretHash" },
          { migration_id: 20, name: "Approvals" },
          { migration_id: 21, name: "PushDevices" },
          { migration_id: 22, name: "ChatLevels" },
          { migration_id: 23, name: "ExecutionWriteStarted" },
          { migration_id: 24, name: "MemoryReviewPulls" },
          { migration_id: 25, name: "FloorGrantWakeup" },
          { migration_id: 26, name: "Reactions" },
          { migration_id: 27, name: "AuthorityBinding" },
          { migration_id: 28, name: "WakeupTimings" },
          { migration_id: 29, name: "DropJudgeLog" },
          { migration_id: 30, name: "ManyLeads" },
          { migration_id: 31, name: "LeadDeliveries" },
          { migration_id: 32, name: "WorkerEnvironment" },
          { migration_id: 33, name: "ApproverKeyConfirmations" },
          { migration_id: 34, name: "PerLeadWakeups" },
          { migration_id: 35, name: "RetireLevelCards" },
          { migration_id: 38, name: "PeopleInvites" },
          { migration_id: 39, name: "LeadHandoffs" },
          { migration_id: 40, name: "MessageAttachments" },
          { migration_id: 41, name: "GroupLead" },
          { migration_id: 42, name: "ReactionWakes" },
          { migration_id: 43, name: "WakeupAudience" },
          { migration_id: 44, name: "WakeupSharedSince" },
          { migration_id: 45, name: "WakeupAudienceAbort" },
          { migration_id: 46, name: "ChatCleared" },
          { migration_id: 47, name: "SilentMessages" },
          { migration_id: 50, name: "LeadAccess" },
          { migration_id: 51, name: "ChatSharing" },
          { migration_id: 52, name: "MemoryLabels" },
          { migration_id: 53, name: "MemorySharing" },
          { migration_id: 54, name: "SharedProjection" },
          { migration_id: 55, name: "ChatGrantsLapse" },
          { migration_id: 56, name: "SuggestionsByVersion" },
          { migration_id: 57, name: "Schedules" },
          { migration_id: 58, name: "Work" },
          { migration_id: 59, name: "WorkerWithdrawals" },
          { migration_id: 60, name: "WorkClients" },
          { migration_id: 61, name: "WorkerAttempts" },
          { migration_id: 62, name: "WorkerPublishApproval" },
          { migration_id: 63, name: "LegacyWorkerAttempts" },
          { migration_id: 64, name: "AgentRetirement" },
          { migration_id: 65, name: "WakeupRetired" },
          { migration_id: 66, name: "WakeupsUnretiredIndex" },
          { migration_id: 67, name: "Docs" },
          { migration_id: 68, name: "WorkMoney" },
          { migration_id: 69, name: "WorkerNetwork" },
          { migration_id: 70, name: "VisualHosts" },
          { migration_id: 71, name: "OwnerAnswerCards" },
          { migration_id: 72, name: "GeneratedDocuments" },
          { migration_id: 73, name: "KeyPushes" },
          { migration_id: 74, name: "DocJobCleanup" },
          { migration_id: 75, name: "ServerRenderedDocuments" },
          { migration_id: 76, name: "DocFiles" },
          { migration_id: 77, name: "DocumentLabels" },
          { migration_id: 78, name: "RecipeLabelBaselines" },
          { migration_id: 79, name: "ImportRuns" },
          { migration_id: 80, name: "RecipeJobPasses" },
        ]);
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
          { name: "idx_kin_doc_versions_file" },
          { name: "idx_kin_dream_runs_material" },
          { name: "idx_kin_events_dedupe" },
          { name: "idx_kin_events_queue" },
          { name: "idx_kin_events_wakeup" },
          { name: "idx_kin_floor_grant_scope" },
          { name: "idx_kin_floor_latest" },
          { name: "idx_kin_floor_notices_rate" },
          { name: "idx_kin_floor_open" },
          { name: "idx_kin_lead_access_person" },
          { name: "idx_kin_lead_deliveries_pending" },
          { name: "idx_kin_leads_org_domain" },
          { name: "idx_kin_messages_changes" },
          { name: "idx_kin_pending_actions_approved" },
          { name: "idx_kin_pending_actions_expiry" },
          { name: "idx_kin_pending_actions_org_state" },
          { name: "idx_kin_people_org_person" },
          { name: "idx_kin_ping_items_item" },
          { name: "idx_kin_ping_items_pending" },
          { name: "idx_kin_push_devices_person" },
          { name: "idx_kin_reaction_wakes_chat" },
          { name: "idx_kin_reactions_woke" },
          { name: "idx_kin_record_changes_org" },
          { name: "idx_kin_record_changes_record" },
          { name: "idx_kin_record_links_target" },
          { name: "idx_kin_record_payments_paid" },
          { name: "idx_kin_record_payments_record" },
          { name: "idx_kin_records_date" },
          { name: "idx_kin_records_due" },
          { name: "idx_kin_records_owner" },
          { name: "idx_kin_records_party" },
          { name: "idx_kin_records_project" },
          { name: "idx_kin_records_register" },
          { name: "idx_kin_records_repo" },
          { name: "idx_kin_records_state_due" },
          { name: "idx_kin_shadow_entries_promotion" },
          { name: "idx_kin_shadow_entries_review" },
          { name: "idx_kin_trigger_fires_retention" },
          { name: "idx_kin_trigger_inbox_pending" },
          { name: "idx_kin_trigger_inbox_retention" },
          { name: "idx_kin_triggers_due" },
          { name: "idx_kin_waiting_open_widget_person" },
          { name: "idx_kin_waiting_person_resolved_at" },
          { name: "idx_kin_wakeups_running_lead" },
          { name: "idx_kin_wakeups_unretired_agent" },
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
      }).pipe(Effect.provide(layer)),
  );

  it.effect("also migrates before upstream without creating or changing upstream history", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA foreign_keys = ON`;
      assert.deepStrictEqual(yield* runKinMigrations(), [
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
        [80, "RecipeJobPasses"],
      ]);
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
      yield* sql`ALTER TABLE kin_messages DROP COLUMN refs_json`;
      yield* sql`ALTER TABLE kin_messages DROP COLUMN silent`;
      yield* sql`ALTER TABLE kin_messages DROP COLUMN change_seq`;
      yield* sql`ALTER TABLE kin_chats DROP COLUMN change_seq`;
      yield* sql`ALTER TABLE kin_webhook_sources DROP COLUMN secret_sha256`;
      yield* sql`ALTER TABLE kin_webhook_sources DROP COLUMN secret_bound_at`;
      yield* sql`DROP TABLE kin_dream_runs`;
      yield* sql`DROP TABLE kin_deferral_runs`;
      yield* sql`DROP TABLE kin_auth_paired_sessions`;
      yield* sql`DROP TABLE kin_auth_key_repairs`;
      yield* sql`DROP TABLE kin_auth_session_keys`;
      yield* sql`DROP TABLE kin_worker_charges`;
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
      for (const column of ["public_intro", "domain", "charter", "created_by_person_id"])
        yield* sql`ALTER TABLE kin_leads DROP COLUMN ${sql(column)}`;
      for (const table of [
        "kin_reaction_wakes",
        "kin_reactions",
        "kin_memory_review_pulls",
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
      yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 5`;
      assert.deepStrictEqual(yield* runKinMigrations(), [
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
        [80, "RecipeJobPasses"],
      ]);
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
      assert.deepStrictEqual(yield* kinHistory, [
        { migration_id: 1, name: "ChatCore" },
        { migration_id: 2, name: "Lead" },
        { migration_id: 3, name: "Triggers" },
        { migration_id: 4, name: "MemoryReads" },
        { migration_id: 5, name: "OneChatOwner" },
        { migration_id: 6, name: "Pings" },
        { migration_id: 7, name: "Budget" },
        { migration_id: 8, name: "Floor" },
        { migration_id: 9, name: "JudgeLog" },
        { migration_id: 10, name: "ChatChanges" },
        { migration_id: 11, name: "MemoryHeads" },
        { migration_id: 12, name: "SecretAllow" },
        { migration_id: 13, name: "Routines" },
        { migration_id: 14, name: "LeadToolCalls" },
        { migration_id: 15, name: "AuthSessionKeys" },
        { migration_id: 16, name: "DeferralRuns" },
        { migration_id: 17, name: "Workers" },
        { migration_id: 18, name: "Dreams" },
        { migration_id: 19, name: "WebhookSecretHash" },
        { migration_id: 20, name: "Approvals" },
        { migration_id: 21, name: "PushDevices" },
        { migration_id: 22, name: "ChatLevels" },
        { migration_id: 23, name: "ExecutionWriteStarted" },
        { migration_id: 24, name: "MemoryReviewPulls" },
        { migration_id: 25, name: "FloorGrantWakeup" },
        { migration_id: 26, name: "Reactions" },
        { migration_id: 27, name: "AuthorityBinding" },
        { migration_id: 28, name: "WakeupTimings" },
        { migration_id: 29, name: "DropJudgeLog" },
        { migration_id: 30, name: "ManyLeads" },
        { migration_id: 31, name: "LeadDeliveries" },
        { migration_id: 32, name: "WorkerEnvironment" },
        { migration_id: 33, name: "ApproverKeyConfirmations" },
        { migration_id: 34, name: "PerLeadWakeups" },
        { migration_id: 35, name: "RetireLevelCards" },
        { migration_id: 38, name: "PeopleInvites" },
        { migration_id: 39, name: "LeadHandoffs" },
        { migration_id: 40, name: "MessageAttachments" },
        { migration_id: 41, name: "GroupLead" },
        { migration_id: 42, name: "ReactionWakes" },
        { migration_id: 43, name: "WakeupAudience" },
        { migration_id: 44, name: "WakeupSharedSince" },
        { migration_id: 45, name: "WakeupAudienceAbort" },
        { migration_id: 46, name: "ChatCleared" },
        { migration_id: 47, name: "SilentMessages" },
        { migration_id: 50, name: "LeadAccess" },
        { migration_id: 51, name: "ChatSharing" },
        { migration_id: 52, name: "MemoryLabels" },
        { migration_id: 53, name: "MemorySharing" },
        { migration_id: 54, name: "SharedProjection" },
        { migration_id: 55, name: "ChatGrantsLapse" },
        { migration_id: 56, name: "SuggestionsByVersion" },
        { migration_id: 57, name: "Schedules" },
        { migration_id: 58, name: "Work" },
        { migration_id: 59, name: "WorkerWithdrawals" },
        { migration_id: 60, name: "WorkClients" },
        { migration_id: 61, name: "WorkerAttempts" },
        { migration_id: 62, name: "WorkerPublishApproval" },
        { migration_id: 63, name: "LegacyWorkerAttempts" },
        { migration_id: 64, name: "AgentRetirement" },
        { migration_id: 65, name: "WakeupRetired" },
        { migration_id: 66, name: "WakeupsUnretiredIndex" },
        { migration_id: 67, name: "Docs" },
        { migration_id: 68, name: "WorkMoney" },
        { migration_id: 69, name: "WorkerNetwork" },
        { migration_id: 70, name: "VisualHosts" },
        { migration_id: 71, name: "OwnerAnswerCards" },
        { migration_id: 72, name: "GeneratedDocuments" },
        { migration_id: 73, name: "KeyPushes" },
        { migration_id: 74, name: "DocJobCleanup" },
        { migration_id: 75, name: "ServerRenderedDocuments" },
        { migration_id: 76, name: "DocFiles" },
        { migration_id: 77, name: "DocumentLabels" },
        { migration_id: 78, name: "RecipeLabelBaselines" },
        { migration_id: 79, name: "ImportRuns" },
        { migration_id: 80, name: "RecipeJobPasses" },
      ]);
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
      for (const column of ["public_intro", "domain", "charter", "created_by_person_id"])
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
      assert.deepStrictEqual(yield* runKinMigrations(), [
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
        [80, "RecipeJobPasses"],
      ]);
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
      assert.deepStrictEqual(yield* runKinMigrations(), [
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
        [80, "RecipeJobPasses"],
      ]);
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
        assert.deepStrictEqual(yield* runKinMigrations(), [
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
          [80, "RecipeJobPasses"],
        ]);
        assert.deepStrictEqual((yield* kinHistory).slice(-45), [
          { migration_id: 32, name: "WorkerEnvironment" },
          { migration_id: 33, name: "ApproverKeyConfirmations" },
          { migration_id: 34, name: "PerLeadWakeups" },
          { migration_id: 35, name: "RetireLevelCards" },
          { migration_id: 38, name: "PeopleInvites" },
          { migration_id: 39, name: "LeadHandoffs" },
          { migration_id: 40, name: "MessageAttachments" },
          { migration_id: 41, name: "GroupLead" },
          { migration_id: 42, name: "ReactionWakes" },
          { migration_id: 43, name: "WakeupAudience" },
          { migration_id: 44, name: "WakeupSharedSince" },
          { migration_id: 45, name: "WakeupAudienceAbort" },
          { migration_id: 46, name: "ChatCleared" },
          { migration_id: 47, name: "SilentMessages" },
          { migration_id: 50, name: "LeadAccess" },
          { migration_id: 51, name: "ChatSharing" },
          { migration_id: 52, name: "MemoryLabels" },
          { migration_id: 53, name: "MemorySharing" },
          { migration_id: 54, name: "SharedProjection" },
          { migration_id: 55, name: "ChatGrantsLapse" },
          { migration_id: 56, name: "SuggestionsByVersion" },
          { migration_id: 57, name: "Schedules" },
          { migration_id: 58, name: "Work" },
          { migration_id: 59, name: "WorkerWithdrawals" },
          { migration_id: 60, name: "WorkClients" },
          { migration_id: 61, name: "WorkerAttempts" },
          { migration_id: 62, name: "WorkerPublishApproval" },
          { migration_id: 63, name: "LegacyWorkerAttempts" },
          { migration_id: 64, name: "AgentRetirement" },
          { migration_id: 65, name: "WakeupRetired" },
          { migration_id: 66, name: "WakeupsUnretiredIndex" },
          { migration_id: 67, name: "Docs" },
          { migration_id: 68, name: "WorkMoney" },
          { migration_id: 69, name: "WorkerNetwork" },
          { migration_id: 70, name: "VisualHosts" },
          { migration_id: 71, name: "OwnerAnswerCards" },
          { migration_id: 72, name: "GeneratedDocuments" },
          { migration_id: 73, name: "KeyPushes" },
          { migration_id: 74, name: "DocJobCleanup" },
          { migration_id: 75, name: "ServerRenderedDocuments" },
          { migration_id: 76, name: "DocFiles" },
          { migration_id: 77, name: "DocumentLabels" },
          { migration_id: 78, name: "RecipeLabelBaselines" },
          { migration_id: 79, name: "ImportRuns" },
          { migration_id: 80, name: "RecipeJobPasses" },
        ]);
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
      assert.deepStrictEqual(yield* runKinMigrations(), [
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
        [80, "RecipeJobPasses"],
      ]);
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
        assert.deepStrictEqual(yield* runKinMigrations(), [
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
          [80, "RecipeJobPasses"],
        ]);
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

      assert.deepStrictEqual(yield* runKinMigrations(), [
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
        [80, "RecipeJobPasses"],
      ]);
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

      assert.deepStrictEqual(yield* runKinMigrations(), [
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
        [80, "RecipeJobPasses"],
      ]);
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

      assert.deepStrictEqual(yield* runKinMigrations(), [
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
        [80, "RecipeJobPasses"],
      ]);
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
      assert.deepStrictEqual(yield* runKinMigrations(), [
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
        [80, "RecipeJobPasses"],
      ]);
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
      assert.deepStrictEqual(yield* runKinMigrations(), [
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
        [80, "RecipeJobPasses"],
      ]);
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
      assert.include(String(exit), "below the latest applied migration 80");
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
    assert.deepStrictEqual(yield* runKinMigrations(), [
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
      [80, "RecipeJobPasses"],
    ]);
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
      assert.deepStrictEqual(yield* runKinMigrations(), [
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
        [80, "RecipeJobPasses"],
      ]);
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
    assert.deepStrictEqual(yield* runKinMigrations(), [
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
      [80, "RecipeJobPasses"],
    ]);
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
      assert.deepStrictEqual(yield* runKinMigrations(), [
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
        [80, "RecipeJobPasses"],
      ]);
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
    assert.deepStrictEqual(yield* runKinMigrations(), [
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
      [80, "RecipeJobPasses"],
    ]);
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
        yield* sql`SELECT worker_id, ended_at FROM kin_workers ORDER BY worker_id`,
        [
          { worker_id: "wk-ended", ended_at: 6 },
          { worker_id: "wk-lazy", ended_at: null },
          { worker_id: "wk-open", ended_at: null },
          { worker_id: "wk-tracked", ended_at: null },
        ],
      );
      assert.deepStrictEqual(yield* runKinMigrations(), []);
      yield* K063LegacyWorkerAttempts;
      assert.deepStrictEqual(yield* rows(), expected);
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
      assert.deepStrictEqual(yield* runKinMigrations(), [
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
        [80, "RecipeJobPasses"],
      ]);
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
      assert.deepStrictEqual(yield* runKinMigrations(), [
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
        [80, "RecipeJobPasses"],
      ]);
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
      assert.deepStrictEqual(yield* runKinMigrations(), [
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
        [80, "RecipeJobPasses"],
      ]);
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
      assert.deepStrictEqual(yield* runKinMigrations(), [
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
        [80, "RecipeJobPasses"],
      ]);
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
    assert.deepStrictEqual(yield* runKinMigrations(), [
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
      [80, "RecipeJobPasses"],
    ]);
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
      assert.deepStrictEqual(yield* runKinMigrations(), [
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
        [80, "RecipeJobPasses"],
      ]);
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
    assert.deepStrictEqual(yield* runKinMigrations(), [
      [71, "OwnerAnswerCards"],
      [72, "GeneratedDocuments"],
      [73, "KeyPushes"],
      [74, "DocJobCleanup"],
      [75, "ServerRenderedDocuments"],
      [76, "DocFiles"],
      [77, "DocumentLabels"],
      [78, "RecipeLabelBaselines"],
      [79, "ImportRuns"],
      [80, "RecipeJobPasses"],
    ]);
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
    assert.deepStrictEqual(yield* runKinMigrations(), [
      [72, "GeneratedDocuments"],
      [73, "KeyPushes"],
      [74, "DocJobCleanup"],
      [75, "ServerRenderedDocuments"],
      [76, "DocFiles"],
      [77, "DocumentLabels"],
      [78, "RecipeLabelBaselines"],
      [79, "ImportRuns"],
      [80, "RecipeJobPasses"],
    ]);
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
    assert.deepStrictEqual(yield* runKinMigrations(), [
      [73, "KeyPushes"],
      [74, "DocJobCleanup"],
      [75, "ServerRenderedDocuments"],
      [76, "DocFiles"],
      [77, "DocumentLabels"],
      [78, "RecipeLabelBaselines"],
      [79, "ImportRuns"],
      [80, "RecipeJobPasses"],
    ]);
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
    assert.deepStrictEqual(yield* runKinMigrations(), [
      [74, "DocJobCleanup"],
      [75, "ServerRenderedDocuments"],
      [76, "DocFiles"],
      [77, "DocumentLabels"],
      [78, "RecipeLabelBaselines"],
      [79, "ImportRuns"],
      [80, "RecipeJobPasses"],
    ]);
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
    assert.deepStrictEqual(yield* runKinMigrations(), [
      [75, "ServerRenderedDocuments"],
      [76, "DocFiles"],
      [77, "DocumentLabels"],
      [78, "RecipeLabelBaselines"],
      [79, "ImportRuns"],
      [80, "RecipeJobPasses"],
    ]);
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
    assert.deepStrictEqual(yield* runKinMigrations(), [
      [77, "DocumentLabels"],
      [78, "RecipeLabelBaselines"],
      [79, "ImportRuns"],
      [80, "RecipeJobPasses"],
    ]);
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
    assert.deepStrictEqual(yield* runKinMigrations(), [
      [78, "RecipeLabelBaselines"],
      [79, "ImportRuns"],
      [80, "RecipeJobPasses"],
    ]);
    assert.deepStrictEqual(
      yield* sql`SELECT commit_sha AS "commit" FROM kin_recipe_label_baselines`,
      [{ commit: "a".repeat(40) }],
    );
  }).pipe(Effect.provide(layer)),
);
