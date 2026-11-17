import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Away until a day on their own calendar, and the time a message names for each reader's clock. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const people = new Set(
    (yield* sql<{ name: string }>`SELECT name FROM pragma_table_info('kin_people')`).map(
      (column) => column.name,
    ),
  );
  if (!people.has("away_until")) yield* sql`ALTER TABLE kin_people ADD COLUMN away_until TEXT`;
  const messages = new Set(
    (yield* sql<{ name: string }>`SELECT name FROM pragma_table_info('kin_messages')`).map(
      (column) => column.name,
    ),
  );
  if (!messages.has("when_json")) yield* sql`ALTER TABLE kin_messages ADD COLUMN when_json TEXT`;
});
