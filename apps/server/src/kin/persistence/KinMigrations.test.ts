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
  "kin_budget",
  "kin_budget_charges",
  "kin_budget_limits",
  "kin_chat_members",
  "kin_chats",
  "kin_cursor",
  "kin_events",
  "kin_floor_grants",
  "kin_floor_notices",
  "kin_floor_runs",
  "kin_judge_log",
  "kin_leads",
  "kin_memory_reads",
  "kin_messages",
  "kin_org_state",
  "kin_orgs",
  "kin_people",
  "kin_ping_deliveries",
  "kin_ping_escalations",
  "kin_ping_items",
  "kin_ping_ledger",
  "kin_read_state",
  "kin_session_bindings",
  "kin_shadow_entries",
  "kin_trigger_fires",
  "kin_trigger_inbox",
  "kin_trigger_settings",
  "kin_triggers",
  "kin_waiting",
  "kin_wakeups",
  "kin_webhook_sources",
  "kin_widgets",
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
        ]);
        assert.deepStrictEqual(
          upstreamBefore.map((row) => [row.migration_id, row.name] as const),
          migrationManifest,
        );
        for (const [table, names] of [
          ["kin_triggers", ["next_run_at", "created_at", "updated_at"]],
          ["kin_trigger_fires", ["fired_at"]],
          ["kin_trigger_inbox", ["received_at", "consumed_at"]],
          ["kin_ping_ledger", ["pinged_at", "escalated_at"]],
          ["kin_floor_runs", ["opened_at"]],
          ["kin_floor_grants", ["expires_at", "consumed_at"]],
          ["kin_floor_notices", ["posted_at"]],
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
        for (const { name } of before) {
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
        ]);
        assert.deepStrictEqual(yield* upstreamHistory, upstreamBefore);
        assert.deepStrictEqual(yield* sql`SELECT * FROM kin_orgs`, [
          { org_id: "org", name: "Kin", created_at: timestamp },
        ]);
        assert.deepStrictEqual(
          yield* sql`SELECT name FROM pragma_index_info('idx_kin_triggers_due') ORDER BY seqno`,
          ["next_run_at", "org_id", "trigger_id"].map((name) => ({ name })),
        );
        const indexes = yield* sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'index' AND name GLOB 'idx_kin_*' ORDER BY name
      `;
        assert.deepStrictEqual(indexes, [
          { name: "idx_kin_agents_org_agent" },
          { name: "idx_kin_chat_members_agent" },
          { name: "idx_kin_chat_members_person" },
          { name: "idx_kin_chats_org_chat" },
          { name: "idx_kin_events_dedupe" },
          { name: "idx_kin_events_queue" },
          { name: "idx_kin_events_wakeup" },
          { name: "idx_kin_floor_grant_scope" },
          { name: "idx_kin_floor_latest" },
          { name: "idx_kin_floor_notices_rate" },
          { name: "idx_kin_floor_open" },
          { name: "idx_kin_messages_changes" },
          { name: "idx_kin_people_org_person" },
          { name: "idx_kin_ping_items_item" },
          { name: "idx_kin_ping_items_pending" },
          { name: "idx_kin_shadow_entries_promotion" },
          { name: "idx_kin_shadow_entries_review" },
          { name: "idx_kin_trigger_fires_retention" },
          { name: "idx_kin_trigger_inbox_pending" },
          { name: "idx_kin_trigger_inbox_retention" },
          { name: "idx_kin_triggers_due" },
          { name: "idx_kin_waiting_open_widget_person" },
          { name: "idx_kin_waiting_person_resolved_at" },
          { name: "idx_kin_wakeups_running_org" },
          { name: "idx_kin_widgets_chat_message" },
          { name: "idx_kin_widgets_type_closed_at" },
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
      yield* sql`ALTER TABLE kin_messages DROP COLUMN change_seq`;
      yield* sql`ALTER TABLE kin_chats DROP COLUMN change_seq`;
      yield* sql`DROP TABLE kin_judge_log`;
      yield* sql`DROP TABLE kin_floor_notices`;
      yield* sql`DROP TABLE kin_floor_grants`;
      yield* sql`DROP TABLE kin_floor_runs`;
      yield* sql`DROP TABLE kin_ping_deliveries`;
      yield* sql`DROP TABLE kin_ping_escalations`;
      yield* sql`DROP TABLE kin_ping_items`;
      yield* sql`DROP INDEX kin_chat_members_one_owner`;
      yield* sql`DROP TABLE kin_budget_charges`;
      yield* sql`ALTER TABLE kin_events DROP COLUMN budget_deferred`;
      yield* sql`UPDATE kin_chats SET last_seq = 1 WHERE org_id = 'org' AND chat_id = 'existing-chat'`;
      yield* sql`INSERT INTO kin_messages (org_id, chat_id, message_id, seq, author_kind, author_role, kind, body, mentions_json, status, created_at)
        VALUES ('org', 'existing-chat', 'existing-message', 1, 'system', 'member', 'system', 'Before upgrade', '[]', 'posted', ${timestamp})`;
      yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 5`;
      assert.deepStrictEqual(yield* runKinMigrations(), [
        [5, "OneChatOwner"],
        [6, "Pings"],
        [7, "Budget"],
        [8, "Floor"],
        [9, "JudgeLog"],
        [10, "ChatChanges"],
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
      ]);
      assert.deepStrictEqual(yield* runKinMigrations(), []);
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* sql`SELECT org_id FROM kin_orgs`, [{ org_id: "org" }]);
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
