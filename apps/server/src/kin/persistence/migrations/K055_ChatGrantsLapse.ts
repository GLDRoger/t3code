import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * An earlier build let chat store the owner's authorisation as `owner_label`; no current path
 * grants one and none is honoured. Each lapses to a suggestion of the words it covered, at a new
 * revision, so the owner sees it under waiting. A held item's simply lapses, and a pending
 * suggestion, which came after the grant, is kept.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE kin_memory_labels SET shared_content = NULL, shared_how = NULL, shared_at = NULL
    WHERE shared_how = 'owner_label'
      AND (shared_content IS NULL OR held_at IS NOT NULL OR suggested_rev IS NOT NULL)`;
  yield* sql`INSERT INTO kin_memory_label_revisions (org_id, revision)
    SELECT DISTINCT org_id, 1 FROM kin_memory_labels WHERE shared_how = 'owner_label'
    ON CONFLICT (org_id) DO UPDATE SET revision = revision + 1`;
  yield* sql`UPDATE kin_memory_labels SET suggested_content = shared_content,
      suggested_rev = (SELECT revision FROM kin_memory_label_revisions r
        WHERE r.org_id = kin_memory_labels.org_id),
      shared_content = NULL, shared_how = NULL, shared_at = NULL
    WHERE shared_how = 'owner_label'`;
});
