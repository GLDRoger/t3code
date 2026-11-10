import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE kin_session_bindings RENAME TO kin_session_bindings_legacy`;
  yield* sql`CREATE TABLE kin_session_bindings (
    session_id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    person_id TEXT NOT NULL REFERENCES kin_people(person_id), bound_at INTEGER NOT NULL,
    revoked_at INTEGER, PRIMARY KEY (session_id, org_id)
  )`;
  yield* sql`INSERT INTO kin_session_bindings SELECT session_id, org_id, person_id,
    CASE WHEN typeof(bound_at) = 'integer' THEN bound_at ELSE CAST(ROUND((julianday(bound_at) - 2440587.5) * 86400000) AS INTEGER) END,
    CASE WHEN typeof(revoked_at) = 'integer' THEN revoked_at ELSE CAST(ROUND((julianday(revoked_at) - 2440587.5) * 86400000) AS INTEGER) END FROM kin_session_bindings_legacy`;
  yield* sql`DROP TABLE kin_session_bindings_legacy`;
  yield* sql`CREATE TABLE kin_people_invites (
    invite_id TEXT PRIMARY KEY NOT NULL,
    org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    person_id TEXT,
    display_name TEXT NOT NULL,
    handle TEXT NOT NULL,
    secret_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER,
    revoked_at INTEGER
  )`;
});
