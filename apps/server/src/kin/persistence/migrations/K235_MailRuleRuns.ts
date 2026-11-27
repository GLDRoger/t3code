import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A mail rule's run: the activation a wake was queued under, why a mail was held, the per-rule
 * mail key and the playbook route a held mail goes on to, and one ledger row per arrival a wake
 * carried, so a run's outcome is recorded for each mail. Added after K231 landed; add-only.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rules = new Set(
    (yield* sql<{ name: string }>`SELECT name FROM pragma_table_info('kin_mail_rules')`).map(
      ({ name }) => name,
    ),
  );
  if (!rules.has("activation"))
    yield* sql`ALTER TABLE kin_mail_rules ADD COLUMN activation INTEGER NOT NULL DEFAULT 1
      CHECK (activation >= 1)`;
  const arrivals = new Set(
    (yield* sql<{ name: string }>`SELECT name FROM pragma_table_info('kin_arrivals')`).map(
      ({ name }) => name,
    ),
  );
  if (!arrivals.has("rule_hold_reason"))
    yield* sql`ALTER TABLE kin_arrivals ADD COLUMN rule_hold_reason TEXT`;
  if (!arrivals.has("rule_held_at"))
    yield* sql`ALTER TABLE kin_arrivals ADD COLUMN rule_held_at INTEGER`;
  if (!arrivals.has("rule_mail_key"))
    yield* sql`ALTER TABLE kin_arrivals ADD COLUMN rule_mail_key TEXT`;
  if (!arrivals.has("rule_playbook_route"))
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
});
