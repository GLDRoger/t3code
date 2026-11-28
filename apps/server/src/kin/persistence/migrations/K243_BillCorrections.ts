import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [existing] = yield* sql`SELECT 1 FROM pragma_table_info('kin_bill_reads')
    WHERE name = 'said_json'`;
  if (existing !== undefined) return;
  yield* sql`ALTER TABLE kin_bill_reads ADD COLUMN said_json TEXT`;
});
