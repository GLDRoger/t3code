import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE kin_floor_runs (
    org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    run_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    opened_by TEXT NOT NULL REFERENCES kin_messages(message_id),
    mention_queue TEXT NOT NULL,
    spoken TEXT NOT NULL DEFAULT '[]',
    agent_turns INTEGER NOT NULL DEFAULT 0 CHECK (agent_turns BETWEEN 0 AND 6),
    last_speaker TEXT,
    state TEXT NOT NULL CHECK (state IN ('open', 'closed')),
    opened_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, run_id),
    FOREIGN KEY (org_id, chat_id) REFERENCES kin_chats(org_id, chat_id)
  )`;
  yield* sql`CREATE UNIQUE INDEX idx_kin_floor_open ON kin_floor_runs(org_id, chat_id) WHERE state = 'open'`;
  yield* sql`CREATE INDEX idx_kin_floor_latest ON kin_floor_runs(org_id, chat_id, opened_at DESC)`;
  yield* sql`CREATE TABLE kin_floor_grants (
    org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    token TEXT NOT NULL,
    run_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER,
    PRIMARY KEY (org_id, token),
    FOREIGN KEY (org_id, run_id) REFERENCES kin_floor_runs(org_id, run_id),
    FOREIGN KEY (org_id, chat_id) REFERENCES kin_chats(org_id, chat_id),
    FOREIGN KEY (org_id, agent_id) REFERENCES kin_agents(org_id, agent_id)
  )`;
  yield* sql`CREATE INDEX idx_kin_floor_grant_scope ON kin_floor_grants(org_id, chat_id, agent_id, run_id, expires_at) WHERE consumed_at IS NULL`;
  yield* sql`CREATE TABLE kin_floor_notices (
    org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    message_id TEXT NOT NULL REFERENCES kin_messages(message_id),
    chat_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    posted_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, message_id),
    FOREIGN KEY (org_id, chat_id) REFERENCES kin_chats(org_id, chat_id),
    FOREIGN KEY (org_id, agent_id) REFERENCES kin_agents(org_id, agent_id)
  )`;
  yield* sql`CREATE INDEX idx_kin_floor_notices_rate ON kin_floor_notices(org_id, chat_id, agent_id, posted_at)`;
});
