import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = new Set(
    (yield* sql<{ name: string }>`SELECT name FROM pragma_table_info('kin_bill_reads')`).map(
      ({ name }) => name,
    ),
  );
  if (!columns.has("parent_sha256"))
    yield* sql`ALTER TABLE kin_bill_reads ADD COLUMN parent_sha256 TEXT`;
  if (!columns.has("cut_page")) yield* sql`ALTER TABLE kin_bill_reads ADD COLUMN cut_page INTEGER`;
  if (!columns.has("cut_box_json"))
    yield* sql`ALTER TABLE kin_bill_reads ADD COLUMN cut_box_json TEXT`;
});
