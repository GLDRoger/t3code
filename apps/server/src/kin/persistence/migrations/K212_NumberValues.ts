import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_number_values (
    org_id TEXT NOT NULL,
    record_id TEXT NOT NULL,
    as_of TEXT NOT NULL,
    seq INTEGER NOT NULL CHECK (seq > 0),
    value TEXT NOT NULL,
    person_id TEXT,
    agent_id TEXT,
    recorder_name TEXT NOT NULL,
    source TEXT,
    created_at INTEGER NOT NULL,
    write_key TEXT,
    request_hash TEXT,
    UNIQUE (org_id, write_key),
    CHECK ((person_id IS NULL) <> (agent_id IS NULL)),
    PRIMARY KEY (org_id, record_id, as_of, seq)
  )`;
});
