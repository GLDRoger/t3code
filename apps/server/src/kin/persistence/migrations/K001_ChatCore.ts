import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE kin_orgs (
      org_id TEXT NOT NULL PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE kin_people (
      person_id TEXT NOT NULL PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
      handle TEXT NOT NULL,
      display_name TEXT NOT NULL,
      github_login TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (org_id, handle)
    )
  `;
  yield* sql`
    CREATE TABLE kin_agents (
      agent_id TEXT NOT NULL PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
      display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('lead', 'architect', 'builder', 'qa', 'release', 'router', 'specialist')),
      owner_person_id TEXT NOT NULL REFERENCES kin_people(person_id),
      created_at TEXT NOT NULL,
      retired_at TEXT
    )
  `;
  yield* sql`
    CREATE TABLE kin_agent_threads (
      thread_id TEXT NOT NULL PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
      agent_id TEXT NOT NULL REFERENCES kin_agents(agent_id),
      started_at TEXT NOT NULL,
      ended_at TEXT
    )
  `;
  yield* sql`
    CREATE TABLE kin_session_bindings (
      session_id TEXT NOT NULL,
      org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
      person_id TEXT NOT NULL REFERENCES kin_people(person_id),
      bound_at TEXT NOT NULL,
      revoked_at TEXT,
      PRIMARY KEY (session_id, org_id)
    )
  `;
  yield* sql`
    CREATE TABLE kin_chats (
      chat_id TEXT NOT NULL PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
      kind TEXT NOT NULL CHECK (kind IN ('direct', 'team_group', 'project_group', 'router')),
      title TEXT,
      team_id TEXT,
      direct_key TEXT,
      last_seq INTEGER NOT NULL CHECK (last_seq >= 0),
      last_message_at TEXT,
      created_at TEXT NOT NULL,
      archived_at TEXT,
      UNIQUE (org_id, direct_key),
      CHECK ((kind = 'direct') = (direct_key IS NOT NULL))
    )
  `;
  yield* sql`
    CREATE TABLE kin_chat_members (
      member_id TEXT NOT NULL PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
      chat_id TEXT NOT NULL REFERENCES kin_chats(chat_id),
      principal_kind TEXT NOT NULL CHECK (principal_kind IN ('person', 'agent')),
      person_id TEXT REFERENCES kin_people(person_id),
      agent_id TEXT REFERENCES kin_agents(agent_id),
      role TEXT NOT NULL CHECK (role IN ('owner', 'member', 'guest')),
      joined_at TEXT NOT NULL,
      left_at TEXT,
      muted_until TEXT,
      UNIQUE (chat_id, person_id),
      UNIQUE (chat_id, agent_id),
      CHECK (
        (principal_kind = 'person' AND person_id IS NOT NULL AND agent_id IS NULL) OR
        (principal_kind = 'agent' AND agent_id IS NOT NULL AND person_id IS NULL AND role = 'member')
      )
    )
  `;
  yield* sql`
    CREATE TABLE kin_messages (
      message_id TEXT NOT NULL PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
      chat_id TEXT NOT NULL REFERENCES kin_chats(chat_id),
      seq INTEGER NOT NULL CHECK (seq > 0),
      author_kind TEXT NOT NULL CHECK (author_kind IN ('human', 'agent', 'system')),
      author_person_id TEXT REFERENCES kin_people(person_id),
      author_agent_id TEXT REFERENCES kin_agents(agent_id),
      author_owner_person_id TEXT REFERENCES kin_people(person_id),
      author_thread_id TEXT,
      author_member_id TEXT REFERENCES kin_chat_members(member_id),
      author_role TEXT NOT NULL CHECK (author_role IN ('owner', 'member', 'guest')),
      kind TEXT NOT NULL CHECK (kind IN ('text', 'widget_action', 'system')),
      body TEXT NOT NULL,
      intent TEXT CHECK (intent IN ('answer', 'evidence', 'objection', 'decision', 'question')),
      mentions_json TEXT NOT NULL,
      reply_to TEXT REFERENCES kin_messages(message_id),
      widget_id TEXT,
      floor_run_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('posted', 'suggested', 'dismissed', 'deleted')),
      sent_by TEXT REFERENCES kin_people(person_id),
      client_message_id TEXT,
      created_at TEXT NOT NULL,
      edited_at TEXT,
      UNIQUE (chat_id, seq),
      UNIQUE (chat_id, author_member_id, client_message_id),
      CHECK (
        (author_kind = 'human' AND author_person_id IS NOT NULL AND author_member_id IS NOT NULL
          AND author_agent_id IS NULL AND author_owner_person_id IS NULL AND author_thread_id IS NULL) OR
        (author_kind = 'agent' AND author_agent_id IS NOT NULL AND author_member_id IS NOT NULL
          AND author_owner_person_id IS NOT NULL AND author_thread_id IS NOT NULL AND author_person_id IS NULL) OR
        (author_kind = 'system' AND author_person_id IS NULL AND author_agent_id IS NULL
          AND author_member_id IS NULL AND author_owner_person_id IS NULL AND author_thread_id IS NULL)
      )
    )
  `;
  yield* sql`
    CREATE TABLE kin_widgets (
      widget_id TEXT NOT NULL PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
      chat_id TEXT NOT NULL REFERENCES kin_chats(chat_id),
      message_id TEXT NOT NULL REFERENCES kin_messages(message_id),
      widget_class TEXT NOT NULL CHECK (widget_class IN ('native', 'generated', 'live')),
      type TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      state_json TEXT NOT NULL,
      source_thread_id TEXT,
      source_item_id TEXT,
      feed_kind TEXT,
      feed_key TEXT,
      awaiting_json TEXT NOT NULL,
      pinned_at TEXT,
      closed_at TEXT,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX idx_kin_widgets_type_closed_at ON kin_widgets(type, closed_at)`;
  yield* sql`
    CREATE TABLE kin_read_state (
      chat_id TEXT NOT NULL REFERENCES kin_chats(chat_id),
      member_id TEXT NOT NULL REFERENCES kin_chat_members(member_id),
      org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
      last_read_seq INTEGER NOT NULL CHECK (last_read_seq >= 0),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (chat_id, member_id)
    )
  `;
  yield* sql`
    CREATE TABLE kin_waiting (
      waiting_id TEXT NOT NULL PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
      person_id TEXT NOT NULL REFERENCES kin_people(person_id),
      chat_id TEXT NOT NULL REFERENCES kin_chats(chat_id),
      message_id TEXT REFERENCES kin_messages(message_id),
      widget_id TEXT REFERENCES kin_widgets(widget_id),
      reason TEXT NOT NULL CHECK (reason IN ('approval', 'decision', 'question', 'suggestion', 'mention')),
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      resolution TEXT
    )
  `;
  yield* sql`CREATE INDEX idx_kin_waiting_person_resolved_at ON kin_waiting(person_id, resolved_at)`;
  yield* sql`
    CREATE UNIQUE INDEX idx_kin_waiting_open_widget_person ON kin_waiting(widget_id, person_id)
    WHERE resolved_at IS NULL AND widget_id IS NOT NULL
  `;
  yield* sql`CREATE INDEX idx_kin_chat_members_person ON kin_chat_members(org_id, person_id)`;
  yield* sql`CREATE INDEX idx_kin_chat_members_agent ON kin_chat_members(org_id, agent_id)`;
  yield* sql`CREATE INDEX idx_kin_chats_org ON kin_chats(org_id)`;
  yield* sql`CREATE INDEX idx_kin_widgets_chat_message ON kin_widgets(org_id, chat_id, message_id)`;
});
