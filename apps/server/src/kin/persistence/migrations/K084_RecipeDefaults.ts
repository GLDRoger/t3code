import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** The recipe the owner picked to make a list's documents, over the one its front matter marks. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_recipe_defaults (
    org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    list TEXT NOT NULL,
    recipe TEXT NOT NULL,
    set_by_person_id TEXT NOT NULL,
    set_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, list)
  )`;
});
