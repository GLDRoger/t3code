import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * What Kin passed over instead of doing late (`host/offlineSkips.ts`): one row per skipped
 * message, scheduled slot or check-in slot, keyed so a restart never counts it twice. `at` is
 * when the thing arrived or was due. Rows go after 30 days.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_offline_skips (
    org_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('message', 'scheduled', 'check_in')),
    ref TEXT NOT NULL,
    reason TEXT NOT NULL,
    at INTEGER NOT NULL CHECK (typeof(at) = 'integer'),
    PRIMARY KEY (org_id, kind, ref)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_kin_offline_skips_at
    ON kin_offline_skips (org_id, kind, at)`;
});
