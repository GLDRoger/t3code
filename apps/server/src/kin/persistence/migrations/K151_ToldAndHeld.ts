import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * What a check-in told a person, so a fact is told once and again only when it changed; the
 * posts held through a person's quiet hours until they end; and when an unprompted post last
 * rang each person, so the next within half an hour lands silently.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A row counts while its check-in is queued or ran: a failed one told nothing.
  yield* sql`CREATE TABLE IF NOT EXISTS kin_pulse_told (
    org_id TEXT NOT NULL,
    person_id TEXT NOT NULL,
    fact_key TEXT NOT NULL,
    event_id TEXT NOT NULL,
    sig TEXT NOT NULL,
    told_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, person_id, fact_key, event_id)
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_held_posts (
    hold_id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    person_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    body TEXT NOT NULL,
    audience TEXT NOT NULL,
    held_at INTEGER NOT NULL,
    deliver_at INTEGER NOT NULL,
    delivered_at INTEGER
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_push_rings (
    org_id TEXT NOT NULL,
    person_id TEXT NOT NULL,
    rang_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, person_id)
  )`;
  // 21:00 to 08:00 was a default no one could change; 22:00 to 07:00 is the new default.
  yield* sql`UPDATE kin_trigger_settings SET quiet_hours_json = '{"from":"22:00","to":"07:00"}'
    WHERE quiet_hours_json = '{"from":"21:00","to":"08:00"}'`;
  yield* sql`CREATE INDEX IF NOT EXISTS kin_held_posts_due
    ON kin_held_posts (org_id, deliver_at) WHERE delivered_at IS NULL`;
});
