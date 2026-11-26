import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(kin_record_payments)`;
  const has = (name: string) => columns.some((column) => column.name === name);
  if (!has("received_minor"))
    yield* sql`ALTER TABLE kin_record_payments ADD COLUMN received_minor INTEGER`;
  if (!has("received_currency"))
    yield* sql`ALTER TABLE kin_record_payments ADD COLUMN received_currency TEXT`;
  // Received units per one invoice-currency unit, to six decimal places.
  if (!has("rate")) yield* sql`ALTER TABLE kin_record_payments ADD COLUMN rate TEXT`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_kin_record_payments_rate
    ON kin_record_payments (org_id, received_currency, currency, paid_on)
    WHERE received_currency IS NOT NULL`;
});
