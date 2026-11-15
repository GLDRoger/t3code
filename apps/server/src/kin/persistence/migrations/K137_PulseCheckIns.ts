import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Check-ins and nudges. A schedule with `loose_at` fires once inside a window around that time;
 * `check_in` makes its runs pulse check-ins. A nudge row per person per working day bounds them.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE kin_schedules ADD COLUMN loose_at TEXT`;
  yield* sql`ALTER TABLE kin_schedules ADD COLUMN check_in INTEGER NOT NULL DEFAULT 0
    CHECK (check_in IN (0, 1))`;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_pulse_nudges (
    org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    person_id TEXT NOT NULL,
    day TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    fact_key TEXT NOT NULL,
    sent_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, person_id, day)
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_pulse_seeds (
    org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    seed TEXT NOT NULL,
    seeded_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, seed)
  )`;
});
