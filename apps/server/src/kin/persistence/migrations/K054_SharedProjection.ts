import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Authorisations now cover the shared projection of an item, not its old word list, so none
 * stored before still matches. Each one the owner gave lapses to a suggestion, which binds to the
 * item's words when the owner is next shown it (`bindSuggestions`); a held one simply lapses.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE kin_memory_labels SET shared_content = NULL, shared_how = NULL, shared_at = NULL
    WHERE shared_content IS NOT NULL AND held_at IS NOT NULL`;
  yield* sql`INSERT INTO kin_memory_label_revisions (org_id, revision)
    SELECT DISTINCT org_id, 1 FROM kin_memory_labels WHERE shared_content IS NOT NULL
    ON CONFLICT (org_id) DO UPDATE SET revision = revision + 1`;
  yield* sql`UPDATE kin_memory_labels SET suggested_content = NULL,
      suggested_rev = (SELECT revision FROM kin_memory_label_revisions r
        WHERE r.org_id = kin_memory_labels.org_id),
      shared_content = NULL, shared_how = NULL, shared_at = NULL
    WHERE shared_content IS NOT NULL`;
});
