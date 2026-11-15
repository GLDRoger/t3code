import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Connections the owner made to outside services, the tools each one lists with their pinned
 * definitions and the owner's marks, and every call an agent asked for. No credential is stored
 * here: it lives in the server's secret store. A wake-up's outside read is recorded once, sticky.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_connections (
    org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    connection_id TEXT NOT NULL,
    preset TEXT CHECK (preset IN ('github', 'posthog', 'sentry', 'google', 'zoho_books')),
    label TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('remote', 'builtin')),
    url TEXT,
    url_host TEXT NOT NULL,
    auth TEXT NOT NULL CHECK (auth IN ('none', 'key', 'oauth')),
    auth_header TEXT,
    reach TEXT NOT NULL CHECK (reach IN ('closed', 'open')),
    state TEXT NOT NULL CHECK (state IN ('active', 'needs_sign_in', 'needs_review', 'error')),
    account_label TEXT,
    issuer TEXT,
    resource TEXT,
    protocol_version TEXT,
    instructions_text TEXT,
    instructions_digest TEXT,
    instructions_accepted_text TEXT,
    instructions_accepted_digest TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    listed_at INTEGER,
    last_ok_at INTEGER,
    last_error TEXT,
    removed_at INTEGER,
    PRIMARY KEY (org_id, connection_id)
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_connection_tools (
    org_id TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    definition_json TEXT NOT NULL,
    accepted_json TEXT,
    pin_digest TEXT NOT NULL,
    accepted_digest TEXT,
    mode TEXT NOT NULL CHECK (mode IN ('off', 'read', 'ask')),
    suggested_mode TEXT NOT NULL CHECK (suggested_mode IN ('off', 'read', 'ask')),
    open_world INTEGER NOT NULL CHECK (open_world IN (0, 1)),
    first_seen_at INTEGER NOT NULL,
    changed_at INTEGER,
    accepted_at INTEGER,
    removed_at INTEGER,
    PRIMARY KEY (org_id, connection_id, tool_name),
    FOREIGN KEY (org_id, connection_id) REFERENCES kin_connections(org_id, connection_id)
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_connection_calls (
    org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    call_id TEXT NOT NULL,
    connection_id TEXT,
    tool_name TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    wakeup_id TEXT NOT NULL,
    mode TEXT CHECK (mode IN ('off', 'read', 'ask')),
    action_id TEXT,
    args_json TEXT,
    reason TEXT,
    status TEXT NOT NULL
      CHECK (status IN ('ok', 'error', 'refused', 'awaiting_approval', 'offered')),
    refused_reason TEXT,
    result_chars INTEGER,
    result_bytes INTEGER,
    duration_ms INTEGER,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, call_id)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_kin_connection_calls_wakeup
    ON kin_connection_calls (org_id, wakeup_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_kin_connection_calls_connection
    ON kin_connection_calls (org_id, connection_id, created_at)`;
  // Its own table, as `kin_wakeup_sensitive_reads`: upstream migrations also alter kin_wakeups.
  yield* sql`CREATE TABLE IF NOT EXISTS kin_wakeup_outside_reads (
    org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    wakeup_id TEXT NOT NULL,
    read_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, wakeup_id)
  )`;
});
