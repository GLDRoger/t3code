import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Kin house-line tables. The integrator may renumber this migration when
 * other Kin lanes add their own files.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS kin_house (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      agent_map_path TEXT,
      UNIQUE (project_id, name)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS kin_house_pattern (
      project_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      pattern TEXT NOT NULL,
      house_id TEXT NOT NULL,
      PRIMARY KEY (project_id, position)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS kin_line (
      id TEXT PRIMARY KEY,
      house_id TEXT NOT NULL,
      root_lane_id TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS kin_lane (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      house_id TEXT NOT NULL,
      label TEXT NOT NULL,
      thread_id TEXT NOT NULL UNIQUE,
      line_id TEXT NOT NULL,
      profile TEXT NOT NULL,
      role TEXT NOT NULL,
      crownable INTEGER NOT NULL,
      sees_wills INTEGER NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      state TEXT NOT NULL,
      touched_paths_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS kin_lane_project_idx ON kin_lane (project_id, id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS kin_crowning (
      id TEXT PRIMARY KEY,
      lane_id TEXT NOT NULL UNIQUE,
      house_id TEXT NOT NULL,
      regnal_number INTEGER NOT NULL,
      agent_profile TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      crowned_at TEXT NOT NULL,
      UNIQUE (house_id, regnal_number)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS kin_will (
      id TEXT PRIMARY KEY,
      crowning_id TEXT NOT NULL UNIQUE,
      body TEXT NOT NULL,
      written_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS kin_note (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      author_lane_id TEXT,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      flagged_misleading_by_json TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS kin_note_project_idx ON kin_note (project_id, created_at, id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS kin_note_house (
      note_id TEXT NOT NULL,
      house_id TEXT NOT NULL,
      PRIMARY KEY (note_id, house_id)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS kin_lane_report (
      lane_id TEXT PRIMARY KEY,
      first_reads_json TEXT NOT NULL,
      misleading_notes_json TEXT NOT NULL,
      verified_reads_json TEXT NOT NULL,
      mismatch INTEGER NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS kin_read_log (
      id TEXT PRIMARY KEY,
      lane_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      read_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS kin_read_log_lane_idx ON kin_read_log (lane_id, kind, target_id)
  `;
});
