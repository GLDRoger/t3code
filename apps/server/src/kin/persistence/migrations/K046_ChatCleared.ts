import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A cleared chat's rows are deleted, so no changed row tells a returning client they are gone.
 * The chat's `change_seq` at its last clear does: a cursor below it is from before the clear.
 * `cleared_seq` is its `last_seq` then, since seqs keep counting: no message is at or below it.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(kin_chats)`;
  for (const name of ["cleared_change_seq", "cleared_seq"])
    if (!columns.some((column) => column.name === name))
      yield* sql`ALTER TABLE kin_chats ADD COLUMN ${sql.literal(name)} INTEGER NOT NULL DEFAULT 0`;
});
