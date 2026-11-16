import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(kin_records)`;
  // What a person's create asked for (`KinRecords.requestHashOf`); null for leads' and older rows.
  if (!columns.some((column) => column.name === "request_hash"))
    yield* sql`ALTER TABLE kin_records ADD COLUMN request_hash TEXT`;
});
