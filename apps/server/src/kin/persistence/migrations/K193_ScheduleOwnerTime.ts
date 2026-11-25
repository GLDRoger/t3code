import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A check-in set in Settings keeps the owner's own time (`owner_time_json`) beside the host
 * time Kin wrote, so a clock change in either zone moves the host time and not his.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = new Set(
    (yield* sql<{ name: string }>`SELECT name FROM pragma_table_info('kin_schedules')`).map(
      (row) => row.name,
    ),
  );
  if (!columns.has("owner_time_json"))
    yield* sql`ALTER TABLE kin_schedules ADD COLUMN owner_time_json TEXT`;
});
