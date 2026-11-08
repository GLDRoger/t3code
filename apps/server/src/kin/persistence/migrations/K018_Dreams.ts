import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE kin_dream_runs (
    org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    owner_date TEXT NOT NULL CHECK (owner_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    dream_id TEXT NOT NULL,
    full INTEGER NOT NULL CHECK (full IN (0, 1)),
    status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
    branch TEXT NOT NULL,
    base_head TEXT,
    head TEXT,
    material_from INTEGER NOT NULL CHECK (typeof(material_from) = 'integer'),
    material_until INTEGER NOT NULL CHECK (typeof(material_until) = 'integer'),
    thread_id TEXT,
    dream_json TEXT,
    failure TEXT,
    started_at INTEGER NOT NULL CHECK (typeof(started_at) = 'integer'),
    ended_at INTEGER CHECK (ended_at IS NULL OR typeof(ended_at) = 'integer'),
    PRIMARY KEY (org_id, owner_date),
    UNIQUE (org_id, dream_id),
    CHECK ((status = 'running') = (ended_at IS NULL)),
    CHECK (status <> 'succeeded' OR head IS NOT NULL)
  )`;
  yield* sql`CREATE INDEX idx_kin_dream_runs_material ON kin_dream_runs (org_id, status, material_until)`;
});
