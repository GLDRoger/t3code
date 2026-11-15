import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A Dates list takes an amount, as a renewal's fee, changed only by adding that. What each issued
 * document showed, kept as rendered: the evidence a later check of an entry's amount reads. And
 * which issued invoices with no amount the owner was told about, so each is told once.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE kin_registers
    SET definition_json = json_set(definition_json, '$.amount', json('true')), rev = rev + 1
    WHERE register_id = 'dates' AND built_in = 0
      AND json_extract(definition_json, '$.amount') = 0`;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_doc_job_figures (
    org_id TEXT NOT NULL,
    worker_id TEXT NOT NULL,
    entry_record_id TEXT NOT NULL,
    number TEXT NOT NULL,
    total_minor INTEGER NOT NULL,
    tax_minor INTEGER NOT NULL,
    currency TEXT NOT NULL CHECK (length(currency) = 3),
    taxes_json TEXT NOT NULL,
    rendered_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, worker_id),
    FOREIGN KEY (org_id, worker_id) REFERENCES kin_doc_jobs(org_id, worker_id)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS kin_doc_job_figures_entry
    ON kin_doc_job_figures (org_id, entry_record_id, rendered_at)`;
  yield* sql`CREATE TRIGGER IF NOT EXISTS kin_doc_job_figures_no_update
    BEFORE UPDATE ON kin_doc_job_figures
    BEGIN SELECT RAISE(ABORT, 'a rendered figure is kept as it was rendered'); END`;
  yield* sql`CREATE TRIGGER IF NOT EXISTS kin_doc_job_figures_no_delete
    BEFORE DELETE ON kin_doc_job_figures
    BEGIN SELECT RAISE(ABORT, 'a rendered figure is kept as it was rendered'); END`;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_amount_notices (
    org_id TEXT NOT NULL,
    record_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    reported_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, record_id)
  )`;
});
