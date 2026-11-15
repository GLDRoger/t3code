import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The pulse's facts as the tick last saw them: when each was first and last true, when it woke
 * its agent, and who said they had it in hand. The facts themselves are recomputed on every read.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_pulse_facts (
    org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    fact_key TEXT NOT NULL,
    sense TEXT NOT NULL,
    subject_record_id TEXT,
    scope_json TEXT NOT NULL DEFAULT '{}',
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    cleared_at INTEGER,
    woke_at INTEGER,
    handled_by_kind TEXT CHECK (handled_by_kind IN ('person', 'agent')),
    handled_by_id TEXT,
    handled_at INTEGER,
    handled_until INTEGER,
    handled_note TEXT,
    PRIMARY KEY (org_id, fact_key)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_kin_pulse_facts_open
    ON kin_pulse_facts (org_id, cleared_at, sense)`;
});
