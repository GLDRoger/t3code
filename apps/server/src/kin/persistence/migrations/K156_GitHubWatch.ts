import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Kin watching GitHub with the owner's own login: where its last look got to, every trigger it
 * handled (one row per trigger, so none is handled twice), the repos the owner switched, and the
 * PRs agents opened, whose checks it follows.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_github_watch (
    org_id TEXT PRIMARY KEY,
    login TEXT,
    started_at INTEGER NOT NULL,
    notifications_modified TEXT,
    events_etag TEXT,
    next_at INTEGER NOT NULL DEFAULT 0,
    checked_at INTEGER,
    since_at INTEGER NOT NULL,
    problem TEXT,
    repos_json TEXT,
    repos_at INTEGER
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_github_handled (
    org_id TEXT NOT NULL,
    trigger_key TEXT NOT NULL,
    repo TEXT NOT NULL,
    number INTEGER NOT NULL,
    agent_id TEXT,
    outcome TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (org_id, trigger_key)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS kin_github_handled_thread
    ON kin_github_handled (org_id, repo, number, at)`;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_github_repo_prefs (
    org_id TEXT NOT NULL,
    repo TEXT NOT NULL,
    watched INTEGER,
    mentions INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, repo)
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_github_agent_pulls (
    org_id TEXT NOT NULL,
    repo TEXT NOT NULL,
    number INTEGER NOT NULL,
    head_sha TEXT NOT NULL,
    checks_etag TEXT,
    open INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (org_id, repo, number)
  )`;
});
