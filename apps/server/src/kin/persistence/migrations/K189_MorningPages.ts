import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A person's own morning page as they set it (`pulse/personMorning.ts`): its time, days and
 * whether it comes. Null keeps the default, the start of their working hours.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`SELECT name FROM pragma_table_info('kin_people')
    WHERE name = 'morning_json'`;
  if (columns.length === 0) yield* sql`ALTER TABLE kin_people ADD COLUMN morning_json TEXT`;
});
