import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(kin_issued_numbers)`;
  if (!columns.some(({ name }) => name === "tax_by_customer"))
    yield* sql`ALTER TABLE kin_issued_numbers ADD COLUMN tax_by_customer INTEGER`;
});
