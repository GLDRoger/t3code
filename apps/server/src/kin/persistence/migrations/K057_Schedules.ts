import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A recurring schedule on T3's native scheduler. This row, not the task's prompt, is a firing's
 * authority: whose request, which lead and chat, and the prompt hash the owner approved.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_schedules (
    task_id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    schedule_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    source_event TEXT NOT NULL,
    said_by TEXT NOT NULL,
    audience TEXT NOT NULL CHECK (audience IN ('owner_only', 'shared')),
    content_sha256 TEXT NOT NULL,
    inbox_thread_id TEXT NOT NULL,
    asked_sha256 TEXT,
    pending_enabled INTEGER CHECK (pending_enabled IS NULL OR pending_enabled IN (0, 1)),
    run_now_at INTEGER CHECK (run_now_at IS NULL OR typeof(run_now_at) = 'integer'),
    deleted_at INTEGER CHECK (deleted_at IS NULL OR typeof(deleted_at) = 'integer'),
    created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer'),
    updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer'),
    UNIQUE (org_id, schedule_id)
  )`;
});
