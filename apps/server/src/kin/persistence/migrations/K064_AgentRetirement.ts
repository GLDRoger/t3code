import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Who retired an agent (null for the host's command and for retirements before this), and what
 * retiring it paused, so restoring it resumes exactly those and nothing the owner paused himself.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(kin_agents)`;
  if (!columns.some((column) => column.name === "retired_by_person_id"))
    yield* sql`ALTER TABLE kin_agents ADD COLUMN retired_by_person_id TEXT`;
  // kind 'trigger': a kin_triggers row (target its trigger id), and the next run it had then.
  // kind 'schedule': a kin_schedules row (target its task id), paused through pending_enabled.
  yield* sql`CREATE TABLE IF NOT EXISTS kin_retirement_holds (
    org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    agent_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('trigger', 'schedule')),
    target_id TEXT NOT NULL,
    next_run_at INTEGER CHECK (next_run_at IS NULL OR typeof(next_run_at) = 'integer'),
    held_at INTEGER NOT NULL CHECK (typeof(held_at) = 'integer'),
    PRIMARY KEY (org_id, agent_id, kind, target_id)
  )`;
});
