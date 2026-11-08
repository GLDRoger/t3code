import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE kin_pending_actions (
      action_id TEXT NOT NULL PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
      idempotency_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      target_json TEXT NOT NULL,
      resolved_json TEXT NOT NULL,
      target_digest TEXT NOT NULL,
      nonce TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 0),
      reason TEXT NOT NULL,
      requested_by_agent_id TEXT NOT NULL,
      requested_by_thread_id TEXT NOT NULL,
      provenance_json TEXT NOT NULL,
      required_approvers_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('awaiting_approval', 'approved', 'executing',
        'succeeded', 'failed', 'interrupted', 'rejected', 'expired', 'voided', 'cancelled')),
      state_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      UNIQUE (org_id, idempotency_key)
    )
  `;
  yield* sql`CREATE INDEX idx_kin_pending_actions_org_state ON kin_pending_actions(org_id, state)`;
  yield* sql`
    CREATE INDEX idx_kin_pending_actions_expiry ON kin_pending_actions(expires_at)
    WHERE state = 'awaiting_approval'
  `;
  yield* sql`
    CREATE INDEX idx_kin_pending_actions_approved ON kin_pending_actions(state)
    WHERE state = 'approved'
  `;
  yield* sql`
    CREATE TABLE kin_grants (
      grant_id TEXT NOT NULL PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
      action_id TEXT NOT NULL REFERENCES kin_pending_actions(action_id),
      revision INTEGER NOT NULL CHECK (revision >= 0),
      jti TEXT NOT NULL UNIQUE,
      approver_human_id TEXT NOT NULL,
      key_thumbprint TEXT NOT NULL,
      compact TEXT NOT NULL,
      iat_s INTEGER NOT NULL,
      exp_s INTEGER NOT NULL,
      accepted_at INTEGER NOT NULL,
      consumed_at INTEGER,
      UNIQUE (action_id, approver_human_id)
    )
  `;
  yield* sql`
    CREATE TABLE kin_executions (
      action_id TEXT NOT NULL PRIMARY KEY REFERENCES kin_pending_actions(action_id),
      org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
      grant_id TEXT NOT NULL REFERENCES kin_grants(grant_id),
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      outcome TEXT CHECK (outcome IN ('succeeded', 'failed', 'interrupted')),
      github_request_id TEXT,
      merge_commit_sha TEXT,
      error TEXT
    )
  `;
  yield* sql`
    CREATE TABLE kin_approver_keys (
      thumbprint TEXT NOT NULL,
      org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
      public_jwk_json TEXT NOT NULL,
      human_id TEXT NOT NULL,
      device_label TEXT NOT NULL,
      platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
      hardware TEXT NOT NULL CHECK (hardware IN ('secure_enclave', 'strongbox', 'tee', 'software')),
      attested INTEGER NOT NULL CHECK (attested IN (0, 1)),
      session_id TEXT,
      proof_key_thumbprint TEXT,
      state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'revoked')),
      created_at INTEGER NOT NULL,
      confirmed_at INTEGER,
      revoked_at INTEGER,
      PRIMARY KEY (org_id, thumbprint)
    )
  `;
  yield* sql`
    CREATE TABLE kin_audit (
      id TEXT NOT NULL PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
      seq INTEGER NOT NULL CHECK (seq >= 1),
      at INTEGER NOT NULL,
      event TEXT NOT NULL,
      entry_json TEXT NOT NULL,
      prev_hash TEXT NOT NULL,
      hash TEXT NOT NULL,
      UNIQUE (org_id, seq)
    )
  `;
  // Approver keys and push devices check revocation by proof key on every read; K015's index
  // covers every renewal row, this one only the revoked ones.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_kin_auth_session_keys_revoked
    ON kin_auth_session_keys(proof_key_thumbprint) WHERE individually_revoked != 0
  `;
});
