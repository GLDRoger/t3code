import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Contact with a client that a person told us about: a call, a meeting, an email. What Kin
 * already holds (issued invoices and quotes, payments, passed meetings) is read with these and
 * never copied here. Removing one keeps the row, so a retry of its log still finds it.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_client_touches (
    org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    touch_id TEXT NOT NULL,
    party_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('call', 'meeting', 'email', 'message', 'other')),
    person_id TEXT,
    note TEXT NOT NULL DEFAULT '',
    logged_by_kind TEXT NOT NULL CHECK (logged_by_kind IN ('person', 'agent')),
    logged_by_id TEXT NOT NULL,
    origin_key TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    removed_at INTEGER,
    PRIMARY KEY (org_id, touch_id),
    UNIQUE (org_id, origin_key),
    FOREIGN KEY (org_id, party_id) REFERENCES kin_records(org_id, record_id)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_kin_client_touches_party
    ON kin_client_touches (org_id, party_id, at)`;
});
