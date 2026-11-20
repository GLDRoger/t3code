import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The review Kin posted for a claimed head someone asked for (`github/reviewAsk.ts`): its link on
 * GitHub, set once by the post. NULL on every row before this and on every head not yet posted.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(kin_github_handled)`;
  if (!columns.some((row) => row.name === "review_url"))
    yield* sql`ALTER TABLE kin_github_handled ADD COLUMN review_url TEXT NULL`;
});
