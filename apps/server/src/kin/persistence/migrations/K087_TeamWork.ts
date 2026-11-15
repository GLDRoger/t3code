import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Entries the owner shared with the team. Every entry that exists when this lands stays the
 * owner's alone until he shares it; teammates see only those and their own (`teamView.ts`).
 * `title_by` and `notes_by` name the person whose words the title and notes are; before this,
 * only the owner and his leads wrote Work. `kin_team_seqs` is each teammate's own change number.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = new Set(
    (yield* sql<{ name: string }>`PRAGMA table_info(kin_records)`).map((column) => column.name),
  );
  if (!columns.has("team_shared"))
    yield* sql`ALTER TABLE kin_records
      ADD COLUMN team_shared INTEGER NOT NULL DEFAULT 0 CHECK (team_shared IN (0, 1))`;
  if (!columns.has("title_by")) yield* sql`ALTER TABLE kin_records ADD COLUMN title_by TEXT`;
  if (!columns.has("notes_by")) yield* sql`ALTER TABLE kin_records ADD COLUMN notes_by TEXT`;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_team_seqs (
    org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    person_id TEXT NOT NULL,
    seq INTEGER NOT NULL CHECK (seq >= 0),
    PRIMARY KEY (org_id, person_id)
  )`;
});
