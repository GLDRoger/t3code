import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Open pull requests in connected repos as webhooks describe them, so the pulse reads PR facts
 * by SQL; the review a lead proposed for the owner's Confirm; and the PR a worker works on.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_pull_requests (
    org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    repo TEXT NOT NULL,
    number INTEGER NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    author TEXT,
    url TEXT NOT NULL,
    draft INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL CHECK (state IN ('open', 'closed', 'merged')),
    head_sha TEXT,
    head_ref TEXT,
    head_repo TEXT,
    opened_at INTEGER NOT NULL,
    review_requested_at INTEGER,
    review TEXT CHECK (review IN ('approved', 'changes_requested')),
    checks TEXT CHECK (checks IN ('success', 'failure', 'pending')),
    checks_sha TEXT,
    ready_at INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, repo, number)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_kin_pull_requests_state
    ON kin_pull_requests (org_id, state, opened_at)`;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_pr_review_posts (
    org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    post_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    repo TEXT NOT NULL,
    number INTEGER NOT NULL,
    review_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('open', 'confirmed', 'posted', 'declined')),
    widget_id TEXT,
    url TEXT,
    proposed_at INTEGER NOT NULL,
    decided_at INTEGER,
    PRIMARY KEY (org_id, post_id)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_kin_pr_review_posts_widget
    ON kin_pr_review_posts (org_id, widget_id)`;
  yield* sql`ALTER TABLE kin_workers ADD COLUMN target_pr INTEGER`;
  yield* sql`ALTER TABLE kin_workers ADD COLUMN target_branch TEXT`;
});
