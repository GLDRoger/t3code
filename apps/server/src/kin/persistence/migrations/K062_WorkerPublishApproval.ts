import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The owner's say over a worker's publication. An attempt records what Kin last saw of GitHub's
 * visibility and the commit it checked, whether its work was ever sensitive (sticky), the commit
 * and title it holds for the owner and their card, and the owner's one decision. A wake-up records
 * that the lead was shown a sensitive Work entry, so work it starts counts as sensitive.
 */
const ATTEMPT_COLUMNS = [
  ["visibility", "TEXT CHECK (visibility IN ('public', 'private', 'unknown'))"],
  ["reviewed_sha", "TEXT"],
  ["files_json", "TEXT"],
  ["public_at", "INTEGER"],
  ["sensitive_at", "INTEGER"],
  ["ready_at", "INTEGER"],
  ["ready_sha", "TEXT"],
  ["ready_title", "TEXT"],
  ["ready_card_id", "TEXT"],
  ["approved_sha", "TEXT"],
  ["approved_title", "TEXT"],
  ["approved_by", "TEXT"],
  ["approved_at", "INTEGER"],
  ["declined_by", "TEXT"],
  ["declined_at", "INTEGER"],
] as const;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const attempts = yield* sql<{ name: string }>`PRAGMA table_info(kin_worker_attempts)`;
  for (const [name, type] of ATTEMPT_COLUMNS)
    if (!attempts.some((column) => column.name === name))
      yield* sql.unsafe(`ALTER TABLE kin_worker_attempts ADD COLUMN ${name} ${type}`);
  // Its own table: upstream migrations also alter kin_wakeups, in either order.
  yield* sql`CREATE TABLE IF NOT EXISTS kin_wakeup_sensitive_reads (
    org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    wakeup_id TEXT NOT NULL,
    read_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, wakeup_id)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_kin_worker_attempts_ready
    ON kin_worker_attempts (org_id, ready_card_id) WHERE ready_card_id IS NOT NULL`;
});
