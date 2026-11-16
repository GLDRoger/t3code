import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The Team room's discussions: what one is about, whose call it is, where it stands and what its
 * caps leave. A message in a discussion names it, and a row one agent sends into another's chat
 * (or what comes back) names who sent it. A hand-off records the reply carried back to its asker.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_discussions (
    org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    discussion_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    topic TEXT NOT NULL,
    question TEXT NOT NULL,
    widened INTEGER NOT NULL DEFAULT 0 CHECK (widened IN (0, 1)),
    decider_agent_id TEXT NOT NULL,
    opened_by_agent_id TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('owner', 'agent')),
    ask_chat_id TEXT,
    ask_agent_id TEXT,
    state TEXT NOT NULL CHECK (state IN ('open', 'closing', 'decided', 'parked', 'escalated')),
    final INTEGER NOT NULL DEFAULT 0 CHECK (final IN (0, 1)),
    outcome TEXT,
    did_json TEXT NOT NULL DEFAULT '[]',
    messages INTEGER NOT NULL DEFAULT 0,
    units INTEGER NOT NULL DEFAULT 0,
    objection_used INTEGER NOT NULL DEFAULT 0 CHECK (objection_used IN (0, 1)),
    after_objection INTEGER,
    pending_json TEXT NOT NULL DEFAULT '[]',
    turn_json TEXT,
    offers_json TEXT NOT NULL DEFAULT '{}',
    speakers_json TEXT NOT NULL DEFAULT '[]',
    chaired INTEGER NOT NULL DEFAULT 0 CHECK (chaired IN (0, 1)),
    created_at INTEGER NOT NULL,
    last_at INTEGER NOT NULL,
    ended_at INTEGER,
    told_at INTEGER,
    open_key TEXT,
    PRIMARY KEY (org_id, discussion_id)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS kin_discussions_open
    ON kin_discussions (org_id, final, created_at)`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS kin_discussions_open_key
    ON kin_discussions (org_id, open_key) WHERE open_key IS NOT NULL`;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(kin_messages)`;
  if (!columns.some((column) => column.name === "discussion_id"))
    yield* sql`ALTER TABLE kin_messages ADD COLUMN discussion_id TEXT`;
  if (!columns.some((column) => column.name === "relay_json"))
    yield* sql`ALTER TABLE kin_messages ADD COLUMN relay_json TEXT`;
  const handoffs = yield* sql<{ name: string }>`PRAGMA table_info(kin_handoffs)`;
  if (!handoffs.some((column) => column.name === "reply_message_id"))
    yield* sql`ALTER TABLE kin_handoffs ADD COLUMN reply_message_id TEXT`;
  if (!handoffs.some((column) => column.name === "to_chat_id"))
    yield* sql`ALTER TABLE kin_handoffs ADD COLUMN to_chat_id TEXT`;
});
