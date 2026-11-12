import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Lists as configuration and money: an entry's own date can be a whole day, lists have a
 * revision, invoices take payments, a lead's proposed list waits for the owner's answer, and the
 * company has one sensitive profile. Amounts are integer minor units with an ISO code.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const records = yield* sql<{ name: string }>`PRAGMA table_info(kin_records)`;
  if (!records.some((column) => column.name === "date_all_day"))
    yield* sql`ALTER TABLE kin_records ADD COLUMN date_all_day INTEGER NOT NULL DEFAULT 0
      CHECK (date_all_day IN (0, 1))`;
  const registers = yield* sql<{ name: string }>`PRAGMA table_info(kin_registers)`;
  if (!registers.some((column) => column.name === "rev"))
    yield* sql`ALTER TABLE kin_registers ADD COLUMN rev INTEGER NOT NULL DEFAULT 1`;
  // The dates view reads every list by either date.
  yield* sql`CREATE INDEX IF NOT EXISTS idx_kin_records_due ON kin_records (org_id, due_at)
    WHERE due_at IS NOT NULL`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_kin_records_date ON kin_records (org_id, date_at)
    WHERE date_at IS NOT NULL`;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_record_payments (
    org_id TEXT NOT NULL,
    payment_id TEXT NOT NULL,
    record_id TEXT NOT NULL,
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    currency TEXT NOT NULL,
    -- The day it was paid, in the owner's time zone: months group by its first seven characters.
    paid_on TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    origin_key TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    created_by_kind TEXT NOT NULL CHECK (created_by_kind IN ('person', 'agent', 'system')),
    created_by_id TEXT,
    voided_at INTEGER,
    PRIMARY KEY (org_id, payment_id),
    UNIQUE (org_id, origin_key),
    FOREIGN KEY (org_id, record_id) REFERENCES kin_records(org_id, record_id)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_kin_record_payments_record
    ON kin_record_payments (org_id, record_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_kin_record_payments_paid
    ON kin_record_payments (org_id, paid_on)`;
  // A list a lead proposed in a chat; it is created only from a later turn the owner's answer woke.
  yield* sql`CREATE TABLE IF NOT EXISTS kin_list_proposals (
    org_id TEXT NOT NULL,
    proposal_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    wakeup_id TEXT NOT NULL,
    register_id TEXT NOT NULL,
    extends_existing INTEGER NOT NULL CHECK (extends_existing IN (0, 1)),
    definition_json TEXT NOT NULL,
    -- The chat's last message when it was proposed: the owner's answer comes after it.
    chat_seq INTEGER NOT NULL,
    proposed_at INTEGER NOT NULL,
    defined_at INTEGER,
    PRIMARY KEY (org_id, proposal_id)
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_company_profile (
    org_id TEXT PRIMARY KEY NOT NULL REFERENCES kin_orgs(org_id),
    profile_json TEXT NOT NULL,
    rev INTEGER NOT NULL CHECK (rev >= 1),
    updated_at INTEGER NOT NULL,
    updated_by_kind TEXT NOT NULL CHECK (updated_by_kind IN ('person', 'agent')),
    updated_by_id TEXT NOT NULL
  )`;
});
