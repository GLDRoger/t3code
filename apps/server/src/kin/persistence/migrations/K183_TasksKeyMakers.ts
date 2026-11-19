import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The app session a coding-agent key was made from, so removing that device ends the key. NULL on
 * keys made before this: nothing records their maker, so nothing ends them but their own revoke.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const keys = yield* sql<{ name: string }>`PRAGMA table_info(kin_tasks_keys)`;
  if (!keys.some((column) => column.name === "made_by_session_id"))
    yield* sql`ALTER TABLE kin_tasks_keys ADD COLUMN made_by_session_id TEXT NULL`;
});
