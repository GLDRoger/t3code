import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** The canvas: where each card sits for the company, its widgets, and each person's last look. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_canvas_places (
    org_id TEXT NOT NULL,
    item_key TEXT NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    by_kind TEXT NOT NULL CHECK (by_kind IN ('person', 'agent', 'system')),
    by_id TEXT,
    at INTEGER NOT NULL,
    PRIMARY KEY (org_id, item_key)
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_canvas_widgets (
    widget_id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('progress', 'countdown', 'facts')),
    source_record_id TEXT NOT NULL,
    source_key TEXT NOT NULL,
    source_title TEXT NOT NULL,
    added_by_kind TEXT NOT NULL CHECK (added_by_kind IN ('person', 'agent', 'system')),
    added_by_id TEXT,
    added_at INTEGER NOT NULL
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_kin_canvas_widgets_org
    ON kin_canvas_widgets (org_id, added_at)`;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_canvas_seen (
    org_id TEXT NOT NULL,
    person_id TEXT NOT NULL,
    seen_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, person_id)
  )`;
  // The since list reads changes by time; K177 already indexes them by wake-up.
  yield* sql`CREATE INDEX IF NOT EXISTS idx_kin_record_changes_at
    ON kin_record_changes (org_id, at)`;
});
