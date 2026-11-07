import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE kin_triggers (
      trigger_id TEXT NOT NULL,
      org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
      subject_json TEXT NOT NULL,
      schedule_json TEXT NOT NULL,
      time_zone TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      next_run_at INTEGER,
      last_fire_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (org_id, trigger_id)
    )
  `;
  yield* sql`
    CREATE INDEX idx_kin_triggers_due ON kin_triggers(next_run_at, trigger_id)
    WHERE enabled = 1 AND next_run_at IS NOT NULL
  `;
  yield* sql`
    CREATE TABLE kin_trigger_fires (
      fire_id TEXT NOT NULL,
      org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
      fired_at INTEGER NOT NULL CHECK (fired_at >= 0),
      PRIMARY KEY (org_id, fire_id)
    )
  `;
  yield* sql`CREATE INDEX idx_kin_trigger_fires_retention ON kin_trigger_fires(fired_at)`;
  yield* sql`
    CREATE TABLE kin_trigger_inbox (
      fire_id TEXT NOT NULL,
      org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
      payload_json TEXT NOT NULL,
      received_at INTEGER NOT NULL CHECK (received_at >= 0),
      consumed_at INTEGER,
      PRIMARY KEY (org_id, fire_id)
    )
  `;
  yield* sql`
    CREATE INDEX idx_kin_trigger_inbox_pending
    ON kin_trigger_inbox(org_id, received_at, fire_id)
    WHERE consumed_at IS NULL
  `;
  yield* sql`CREATE INDEX idx_kin_trigger_inbox_retention ON kin_trigger_inbox(consumed_at)`;
  yield* sql`
    CREATE TABLE kin_webhook_sources (
      source_id TEXT NOT NULL PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
      repo TEXT NOT NULL,
      scheduled_task_id TEXT NOT NULL UNIQUE,
      inbox_thread_id TEXT NOT NULL,
      github_hook_id INTEGER,
      bot_login TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'paused_in_t3', 'blocked_by_policy', 'missing')),
      UNIQUE (org_id, repo)
    )
  `;
  yield* sql`
    CREATE TABLE kin_trigger_settings (
      org_id TEXT NOT NULL PRIMARY KEY REFERENCES kin_orgs(org_id),
      time_zone TEXT NOT NULL,
      morning_brief TEXT NOT NULL,
      evening_summary TEXT NOT NULL,
      dream TEXT NOT NULL,
      full_rebuild_weekday INTEGER NOT NULL CHECK (full_rebuild_weekday BETWEEN 0 AND 6),
      owner_check_weekday INTEGER NOT NULL CHECK (owner_check_weekday BETWEEN 0 AND 6),
      owner_check TEXT NOT NULL,
      quiet_hours_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE kin_ping_ledger (
      org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
      person TEXT NOT NULL,
      item_id TEXT NOT NULL,
      day TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
      pinged_at INTEGER NOT NULL,
      escalated_at INTEGER,
      PRIMARY KEY (org_id, person, item_id, day)
    )
  `;
});
