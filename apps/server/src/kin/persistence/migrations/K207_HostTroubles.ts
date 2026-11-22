import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * What stops agents' turns on Kin's computer (`host/KinHostCare.ts`), kept apart from any chat:
 * one row per trouble, open until its cause is proved gone, with the agents it stopped and whether
 * each has worked since. A held turn names its trouble on its own event row (`held_by`).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_troubles (
    trouble_id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    cause TEXT NOT NULL,
    opened_at INTEGER NOT NULL,
    closed_at INTEGER,
    -- The one clean Kin runs by itself for this trouble; only a person's tap runs another.
    auto_clean_at INTEGER,
    -- A notice reached a chat only the owner reads.
    told_at INTEGER,
    reset_at TEXT,
    detail TEXT CHECK (length(detail) <= 600),
    backup_configured INTEGER CHECK (backup_configured IN (0, 1)),
    last_good_at TEXT
  )`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_kin_troubles_open
    ON kin_troubles (org_id, cause) WHERE closed_at IS NULL`;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_trouble_agents (
    trouble_id TEXT NOT NULL,
    org_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    name TEXT NOT NULL,
    instance_id TEXT,
    -- It ran a turn since: its part of the trouble is over.
    worked_at INTEGER,
    PRIMARY KEY (trouble_id, agent_id)
  )`;
  const columns = yield* sql<{ name: string }>`SELECT name FROM pragma_table_info('kin_events')`;
  if (!columns.some((column) => column.name === "held_by"))
    yield* sql`ALTER TABLE kin_events ADD COLUMN held_by TEXT`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_kin_events_held_by
    ON kin_events (org_id, held_by) WHERE held_by IS NOT NULL`;
});
