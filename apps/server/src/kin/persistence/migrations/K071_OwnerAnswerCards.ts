import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The card Kin puts a list proposal to the owner with, so a tap answers only that proposal; and
 * an agent's company profile change, applied only when the owner confirms its card.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(kin_list_proposals)`;
  if (!columns.some((column) => column.name === "widget_id"))
    yield* sql`ALTER TABLE kin_list_proposals ADD COLUMN widget_id TEXT`;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_profile_changes (
    org_id TEXT NOT NULL,
    change_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    wakeup_id TEXT NOT NULL,
    patch_json TEXT NOT NULL,
    -- The profile revision the card shows; a confirm against any other is refused.
    base_rev INTEGER NOT NULL,
    widget_id TEXT,
    proposed_at INTEGER NOT NULL,
    applied_at INTEGER,
    declined_at INTEGER,
    PRIMARY KEY (org_id, change_id)
  )`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS kin_profile_changes_widget
    ON kin_profile_changes (org_id, widget_id) WHERE widget_id IS NOT NULL`;
});
