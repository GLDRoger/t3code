import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Statements: an undo counter that is part of a later confirm's retry keys, the owner's
 * selection on the stored review, wrong-password tries, and what each applied entry looked like
 * right after, so undo can tell what a person changed since. Payments learn tax withheld at
 * source, which settles an invoice without being money received.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const has = (columns: ReadonlyArray<{ readonly name: string }>, name: string) =>
    columns.some((column) => column.name === name);
  const statements = yield* sql<{ name: string }>`PRAGMA table_info(kin_bank_statements)`;
  if (!has(statements, "generation"))
    yield* sql`ALTER TABLE kin_bank_statements ADD COLUMN generation INTEGER NOT NULL DEFAULT 0`;
  if (!has(statements, "selection_json"))
    yield* sql`ALTER TABLE kin_bank_statements ADD COLUMN selection_json TEXT`;
  if (!has(statements, "password_attempts"))
    yield* sql`ALTER TABLE kin_bank_statements ADD COLUMN password_attempts INTEGER NOT NULL DEFAULT 0`;
  const entries = yield* sql<{ name: string }>`PRAGMA table_info(kin_bank_statement_entries)`;
  if (!has(entries, "after_json"))
    yield* sql`ALTER TABLE kin_bank_statement_entries ADD COLUMN after_json TEXT`;
  const payments = yield* sql<{ name: string }>`PRAGMA table_info(kin_record_payments)`;
  if (!has(payments, "withheld")) {
    yield* sql`ALTER TABLE kin_record_payments ADD COLUMN withheld INTEGER NOT NULL DEFAULT 0`;
    // Statements recorded TDS as a payment keyed `statement:<id>:<n>:<row>:tds`.
    yield* sql`UPDATE kin_record_payments SET withheld = 1
      WHERE origin_key LIKE 'statement:%:tds'`;
  }
});
