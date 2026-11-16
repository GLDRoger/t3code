import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Social accounts by group ("Our own" is a NULL party, else one client), and the posts Social
 * drafts: what each says, where and when, and how far it got at the service.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_social_groups (
    org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    group_id TEXT NOT NULL,
    party_id TEXT,
    service TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    profile_name TEXT,
    accounts_json TEXT NOT NULL,
    problem TEXT,
    checked_at INTEGER,
    created_at INTEGER NOT NULL,
    removed_at INTEGER,
    PRIMARY KEY (org_id, group_id)
  )`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_kin_social_groups_party
    ON kin_social_groups(org_id, COALESCE(party_id, '')) WHERE removed_at IS NULL`;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_social_posts (
    org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    post_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('post', 'pack')),
    group_id TEXT,
    account_id TEXT,
    where_text TEXT,
    caption TEXT NOT NULL,
    media_json TEXT,
    at_ms INTEGER NOT NULL,
    state TEXT NOT NULL,
    card_id TEXT,
    digest TEXT,
    confirmed_at INTEGER,
    confirmed_by TEXT,
    service_post_id TEXT,
    attempt_at INTEGER,
    url TEXT,
    reason TEXT,
    polled_at INTEGER,
    agent_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, post_id)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_kin_social_posts_state
    ON kin_social_posts(state, at_ms)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_kin_social_posts_card
    ON kin_social_posts(org_id, card_id)`;
});
