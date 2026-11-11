import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = new Set(
    (yield* sql<{ name: string }>`PRAGMA table_info(kin_memory_labels)`).map(({ name }) => name),
  );
  const first = !columns.has("suggested_rev");
  // The team may know an item only by a stored authorisation of its exact content (`shared_*`).
  // Anything else that says "not sensitive" is a suggestion for the owner (`suggested_*`).
  if (!columns.has("shared_content"))
    yield* sql`ALTER TABLE kin_memory_labels ADD COLUMN shared_content TEXT`;
  if (!columns.has("shared_how"))
    yield* sql`ALTER TABLE kin_memory_labels ADD COLUMN shared_how TEXT CHECK (shared_how IS NULL
      OR shared_how IN ('owner_message', 'owner_label', 'owner_setting', 'owner_confirmed', 'teammate'))`;
  if (!columns.has("shared_at"))
    yield* sql`ALTER TABLE kin_memory_labels ADD COLUMN shared_at INTEGER`;
  if (!columns.has("suggested_content"))
    yield* sql`ALTER TABLE kin_memory_labels ADD COLUMN suggested_content TEXT`;
  if (first) yield* sql`ALTER TABLE kin_memory_labels ADD COLUMN suggested_rev INTEGER`;
  // Only ever grows, so confirming "everything up to revision N" never takes a later suggestion.
  yield* sql`
    CREATE TABLE IF NOT EXISTS kin_memory_label_revisions (
      org_id TEXT NOT NULL PRIMARY KEY REFERENCES kin_orgs(org_id),
      revision INTEGER NOT NULL CHECK (revision >= 0)
    )
  `;
  // What the nightly pass let the team know becomes a suggestion; its content was never recorded.
  if (first) {
    yield* sql`INSERT OR IGNORE INTO kin_memory_label_revisions (org_id, revision)
      SELECT DISTINCT org_id, 1 FROM kin_memory_labels WHERE classified = 0`;
    yield* sql`UPDATE kin_memory_labels SET suggested_rev = 1 WHERE classified = 0`;
  }
  // Each memory write a shared turn made, by whose message it cites, for the per-person daily cap.
  yield* sql`
    CREATE TABLE IF NOT EXISTS kin_memory_shared_writes (
      org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
      wakeup_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      person_id TEXT NOT NULL,
      bytes INTEGER NOT NULL CHECK (bytes >= 0),
      written_at INTEGER NOT NULL,
      PRIMARY KEY (org_id, wakeup_id, item_id)
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS kin_memory_shared_writes_person
    ON kin_memory_shared_writes (org_id, person_id, written_at)`;
});
