import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Each person's kind: the org's owner, a co-owner, or a member. Owner and co-owner are
 * owner-level (`people/KinAccess.ts`); everyone already here besides the owner is a member.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = new Set(
    (yield* sql<{ name: string }>`PRAGMA table_info(kin_people)`).map((column) => column.name),
  );
  if (!columns.has("access"))
    yield* sql`ALTER TABLE kin_people ADD COLUMN access TEXT
      CHECK (access IS NULL OR access IN ('owner', 'co_owner', 'member'))`;
  // The owner is the reserved person bootstrap creates (`KinChatRepository.bootstrapIdentity`).
  yield* sql`UPDATE kin_people SET access = CASE WHEN person_id = 'kin-default-owner'
    THEN 'owner' ELSE 'member' END WHERE access IS NULL`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_kin_people_one_owner
    ON kin_people(org_id) WHERE access = 'owner'`;
});
