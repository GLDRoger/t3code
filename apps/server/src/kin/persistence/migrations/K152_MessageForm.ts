import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * An agent's check-in or weekly brief, kept on its reply so every client draws it as one; and
 * entries by their printed number, which a message's links look up on every read.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`SELECT name
    FROM pragma_table_info('kin_messages') WHERE name = 'form'`;
  if (columns.length === 0)
    yield* sql`ALTER TABLE kin_messages ADD COLUMN form TEXT CHECK (form IS NULL OR form = 'brief')`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_kin_records_number
    ON kin_records (org_id, json_extract(fields_json, '$.number'))
    WHERE json_extract(fields_json, '$.number') IS NOT NULL`;
});
