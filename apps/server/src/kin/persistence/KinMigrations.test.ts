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
  "kin_chat_members",
  "kin_chats",
  "kin_messages",
  "kin_orgs",
  "kin_people",
  "kin_ping_ledger",
  "kin_read_state",
  "kin_session_bindings",
  "kin_trigger_fires",
  "kin_trigger_inbox",
  "kin_trigger_settings",
  "kin_triggers",
  "kin_waiting",
  "kin_webhook_sources",
  "kin_widgets",
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
  it.effect("creates Kin tables in their own track after upstream and reruns without changes", () =>
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
        { migration_id: 3, name: "Triggers" },
      ]);
      assert.deepStrictEqual(
        upstreamBefore.map((row) => [row.migration_id, row.name] as const),
        migrationManifest,
      );
      for (const [table, names] of [
        ["kin_triggers", ["next_run_at", "created_at", "updated_at"]],
        ["kin_trigger_fires", ["fired_at"]],
        ["kin_trigger_inbox", ["received_at", "claimed_at", "consumed_at"]],
        ["kin_ping_ledger", ["pinged_at", "escalated_at"]],
      ] as const) {
        const columns = yield* sql<{ name: string; type: string }>`
          SELECT name, type FROM pragma_table_info(${table})
        `;
        for (const name of names) {
          assert.strictEqual(columns.find((column) => column.name === name)?.type, "INTEGER");
        }
      }
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
        { migration_id: 3, name: "Triggers" },
      ]);
      assert.deepStrictEqual(yield* upstreamHistory, upstreamBefore);
      assert.deepStrictEqual(yield* sql`SELECT * FROM kin_orgs`, [
        { org_id: "org", name: "Kin", created_at: timestamp },
      ]);
      const indexes = yield* sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'index' AND name GLOB 'idx_kin_*' ORDER BY name
      `;
      assert.deepStrictEqual(indexes, [
        { name: "idx_kin_trigger_fires_retention" },
        { name: "idx_kin_trigger_inbox_pending" },
        { name: "idx_kin_triggers_due" },
        { name: "idx_kin_waiting_open_widget_person" },
        { name: "idx_kin_waiting_person_resolved_at" },
        { name: "idx_kin_widgets_type_closed_at" },
      ]);
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
        [3, "Triggers"],
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
      yield* runMigrations();
      assert.deepStrictEqual(
        (yield* upstreamHistory).map((row) => [row.migration_id, row.name] as const),
        migrationManifest,
      );
      assert.deepStrictEqual(yield* kinSchema, before);
      assert.deepStrictEqual(yield* kinHistory, [
        { migration_id: 1, name: "ChatCore" },
        { migration_id: 3, name: "Triggers" },
      ]);
      assert.deepStrictEqual(yield* runKinMigrations(), []);
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* sql`SELECT org_id FROM kin_orgs`, [{ org_id: "org" }]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
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
            ${member.role}, ${timestamp}
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
