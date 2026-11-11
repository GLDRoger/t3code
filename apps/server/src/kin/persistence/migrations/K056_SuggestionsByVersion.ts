import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A yes now always names the items and the words the owner was shown, so suggestions no longer
 * need an order: the revision counter goes, and `suggested_rev` becomes when it was suggested.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = new Set(
    (yield* sql<{ name: string }>`PRAGMA table_info(kin_memory_labels)`).map(({ name }) => name),
  );
  if (columns.has("suggested_rev")) {
    // A rerun of K053 adds the old column back beside the new one.
    if (columns.has("suggested_at"))
      yield* sql`ALTER TABLE kin_memory_labels DROP COLUMN suggested_rev`;
    else {
      yield* sql`ALTER TABLE kin_memory_labels RENAME COLUMN suggested_rev TO suggested_at`;
      yield* sql`UPDATE kin_memory_labels
        SET suggested_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
        WHERE suggested_at IS NOT NULL`;
    }
  }
  yield* sql`DROP TABLE IF EXISTS kin_memory_label_revisions`;
});
