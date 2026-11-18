import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A link a person made for one more of their own devices: who made it and from which session,
 * so removing that device cancels the link and every device linked from it; and on each device,
 * the link it joined with.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columnsOf = (table: string) =>
    sql<{ name: string }>`SELECT name FROM pragma_table_info(${table})`.pipe(
      Effect.map((columns) => new Set(columns.map((column) => column.name))),
    );
  const invites = yield* columnsOf("kin_people_invites");
  if (!invites.has("made_by_person_id"))
    yield* sql`ALTER TABLE kin_people_invites ADD COLUMN made_by_person_id TEXT`;
  if (!invites.has("made_by_session_id"))
    yield* sql`ALTER TABLE kin_people_invites ADD COLUMN made_by_session_id TEXT`;
  const bindings = yield* columnsOf("kin_session_bindings");
  if (!bindings.has("parent_session_id"))
    yield* sql`ALTER TABLE kin_session_bindings ADD COLUMN parent_session_id TEXT`;
  if (!bindings.has("link_id"))
    yield* sql`ALTER TABLE kin_session_bindings ADD COLUMN link_id TEXT`;
  yield* sql`CREATE INDEX IF NOT EXISTS kin_session_bindings_parent
    ON kin_session_bindings (parent_session_id) WHERE parent_session_id IS NOT NULL`;
});
