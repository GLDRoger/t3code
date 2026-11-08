import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // One row per device token per org; the latest person and session to register it own it.
  yield* sql`
    CREATE TABLE kin_push_devices (
      org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
      token TEXT NOT NULL,
      person_id TEXT NOT NULL REFERENCES kin_people(person_id),
      platform TEXT NOT NULL CHECK (platform IN ('ios')),
      aps_environment TEXT NOT NULL CHECK (aps_environment IN ('development', 'production')),
      device_label TEXT,
      session_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (org_id, token)
    )
  `;
  yield* sql`CREATE INDEX idx_kin_push_devices_person ON kin_push_devices(org_id, person_id)`;
});
