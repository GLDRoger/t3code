import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** A push device may be an Android phone, reached through FCM. Every iPhone row stays as it was. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [table] = yield* sql<{ sql: string }>`SELECT sql FROM sqlite_master
    WHERE type = 'table' AND name = 'kin_push_devices'`;
  if (table === undefined || table.sql.includes("'android'")) return;
  // SQLite can't widen a CHECK in place: the table is rebuilt, and keeps its rows.
  yield* sql`CREATE TABLE kin_push_devices_next (
    org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    token TEXT NOT NULL,
    person_id TEXT NOT NULL REFERENCES kin_people(person_id),
    platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
    aps_environment TEXT NOT NULL CHECK (aps_environment IN ('development', 'production')),
    device_label TEXT,
    session_id TEXT NOT NULL,
    proof_key_thumbprint TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, token)
  )`;
  yield* sql`INSERT INTO kin_push_devices_next (org_id, token, person_id, platform,
      aps_environment, device_label, session_id, proof_key_thumbprint, created_at, updated_at)
    SELECT org_id, token, person_id, platform, aps_environment, device_label, session_id,
      proof_key_thumbprint, created_at, updated_at
    FROM kin_push_devices ORDER BY org_id, token`;
  yield* sql`DROP TABLE kin_push_devices`;
  yield* sql`ALTER TABLE kin_push_devices_next RENAME TO kin_push_devices`;
  yield* sql`CREATE INDEX idx_kin_push_devices_person ON kin_push_devices(org_id, person_id)`;
});
