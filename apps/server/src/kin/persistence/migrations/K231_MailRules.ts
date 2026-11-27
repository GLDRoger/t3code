import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_mail_rules (
    org_id TEXT NOT NULL,
    rule_id TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    match_json TEXT NOT NULL,
    what TEXT NOT NULL CHECK (length(what) BETWEEN 1 AND 2000),
    agent_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    said_by TEXT NOT NULL,
    source_event TEXT NOT NULL,
    activation INTEGER NOT NULL DEFAULT 1 CHECK (activation >= 1),
    content_sha256 TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('proposed', 'on', 'paused', 'removed')),
    paused_why TEXT CHECK (paused_why IN ('person', 'left', 'mailbox', 'agent')),
    monthly_cap INTEGER NOT NULL CHECK (monthly_cap BETWEEN 1 AND 1000),
    month TEXT,
    fired INTEGER NOT NULL DEFAULT 0 CHECK (fired >= 0),
    cap_told TEXT,
    last_wake_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, rule_id),
    FOREIGN KEY (org_id, connection_id) REFERENCES kin_connections(org_id, connection_id)
  )`;
  const ruleColumns =
    yield* sql`SELECT 1 FROM pragma_table_info('kin_mail_rules') WHERE name = 'activation'`;
  if (ruleColumns.length === 0)
    yield* sql`ALTER TABLE kin_mail_rules ADD COLUMN activation INTEGER NOT NULL DEFAULT 1 CHECK (activation >= 1)`;
  const columns = new Set(
    (yield* sql<{ name: string }>`SELECT name FROM pragma_table_info('kin_arrivals')`).map(
      ({ name }) => name,
    ),
  );
  if (!columns.has("rule_id")) yield* sql`ALTER TABLE kin_arrivals ADD COLUMN rule_id TEXT`;
  if (!columns.has("rule_state"))
    yield* sql`ALTER TABLE kin_arrivals ADD COLUMN rule_state TEXT CHECK (rule_state IN
      ('woke', 'batched', 'held_cap', 'held_unverified', 'held_paused'))`;
  if (!columns.has("has_file"))
    yield* sql`ALTER TABLE kin_arrivals ADD COLUMN has_file INTEGER CHECK (has_file IN (0, 1))`;
  if (!columns.has("sender_check"))
    yield* sql`ALTER TABLE kin_arrivals ADD COLUMN sender_check TEXT CHECK (sender_check IN
      ('passed', 'failed', 'not checked'))`;
  if (!columns.has("rule_hold_reason"))
    yield* sql`ALTER TABLE kin_arrivals ADD COLUMN rule_hold_reason TEXT`;
  if (!columns.has("rule_held_at"))
    yield* sql`ALTER TABLE kin_arrivals ADD COLUMN rule_held_at INTEGER`;
  if (!columns.has("rule_mail_key"))
    yield* sql`ALTER TABLE kin_arrivals ADD COLUMN rule_mail_key TEXT`;
  if (!columns.has("rule_playbook_route"))
    yield* sql`ALTER TABLE kin_arrivals ADD COLUMN rule_playbook_route TEXT`;
  yield* sql`CREATE INDEX IF NOT EXISTS kin_arrivals_rule_mail
    ON kin_arrivals (org_id, rule_id, rule_mail_key) WHERE rule_mail_key IS NOT NULL`;
  yield* sql`CREATE INDEX IF NOT EXISTS kin_arrivals_rule_playbook
    ON kin_arrivals (org_id, connection_id) WHERE rule_playbook_route IS NOT NULL`;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_mail_rule_runs (
    org_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    arrival_id TEXT NOT NULL,
    rule_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('woke', 'batched')),
    manual INTEGER NOT NULL CHECK (manual IN (0, 1)),
    wakeup_id TEXT,
    settled_at INTEGER,
    outcome TEXT CHECK (outcome IN ('posted_message', 'raised_card', 'nothing', 'held')),
    hold_reason TEXT,
    PRIMARY KEY (org_id, event_id, arrival_id),
    FOREIGN KEY (org_id, arrival_id) REFERENCES kin_arrivals(org_id, arrival_id) ON DELETE CASCADE
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS kin_mail_rule_runs_history
    ON kin_mail_rule_runs (org_id, rule_id, arrival_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS kin_mail_rule_runs_arrival
    ON kin_mail_rule_runs (org_id, arrival_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS kin_arrivals_rule_history
    ON kin_arrivals (org_id, rule_id, noticed_at) WHERE rule_id IS NOT NULL`;
});
