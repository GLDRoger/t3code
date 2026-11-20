import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A record set aside until a day, or until someone lifts it (`pulse/holds.ts`): one live hold per
 * record for the company (`for_person_id` NULL), and one per teammate for their own view. Who set
 * it, on whose word when an agent did, and when and by whom it was lifted.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_holds (
    hold_id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    record_id TEXT NOT NULL,
    for_person_id TEXT NULL,
    until_at INTEGER NULL,
    set_by_kind TEXT NOT NULL CHECK (set_by_kind IN ('person', 'agent')),
    set_by_id TEXT NOT NULL,
    on_word_of TEXT NULL,
    note TEXT NULL,
    set_at INTEGER NOT NULL,
    lifted_at INTEGER NULL,
    lifted_by_kind TEXT NULL CHECK (lifted_by_kind IN ('person', 'agent')),
    lifted_by_id TEXT NULL
  )`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS kin_holds_live
    ON kin_holds (org_id, record_id, COALESCE(for_person_id, '')) WHERE lifted_at IS NULL`;
});
