import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE kin_judge_log (
    org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    message_id TEXT NOT NULL REFERENCES kin_messages(message_id),
    judge TEXT NOT NULL,
    verdict_json TEXT,
    floor_decision_json TEXT NOT NULL,
    latency_ms INTEGER NOT NULL CHECK (latency_ms >= 0),
    error TEXT CHECK (error IN ('timeout', 'judge_error')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, id),
    UNIQUE (org_id, message_id),
    FOREIGN KEY (org_id, chat_id) REFERENCES kin_chats(org_id, chat_id)
  )`;
});
