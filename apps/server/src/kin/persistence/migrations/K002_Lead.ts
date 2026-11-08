import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`CREATE UNIQUE INDEX idx_kin_agents_org_agent ON kin_agents(org_id, agent_id)`;
  yield* sql`CREATE UNIQUE INDEX idx_kin_chats_org_chat ON kin_chats(org_id, chat_id)`;
  yield* sql`CREATE UNIQUE INDEX idx_kin_people_org_person ON kin_people(org_id, person_id)`;

  yield* sql`
    CREATE TABLE kin_leads (
      agent_id TEXT NOT NULL PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
      name TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'L0' CHECK (level IN ('L0', 'L1', 'L2', 'L3')),
      level_since INTEGER NOT NULL,
      thread_id TEXT,
      models_json TEXT NOT NULL,
      worker_projects_json TEXT NOT NULL,
      owner_chat_id TEXT NOT NULL,
      UNIQUE (org_id, agent_id),
      FOREIGN KEY (org_id, agent_id) REFERENCES kin_agents(org_id, agent_id),
      FOREIGN KEY (org_id, owner_chat_id) REFERENCES kin_chats(org_id, chat_id)
    )
  `;
  yield* sql`
    CREATE TABLE kin_wakeups (
      wakeup_id TEXT NOT NULL PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
      agent_id TEXT NOT NULL,
      thread_id TEXT,
      run_id TEXT,
      model TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'interrupted', 'timed_out', 'released')),
      event_ids TEXT NOT NULL,
      tokens_json TEXT,
      tools_json TEXT,
      memory_commit TEXT,
      UNIQUE (org_id, wakeup_id),
      FOREIGN KEY (org_id, agent_id) REFERENCES kin_leads(org_id, agent_id)
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX idx_kin_wakeups_running_org ON kin_wakeups(org_id) WHERE status = 'running'
  `;
  yield* sql`
    CREATE TABLE kin_events (
      event_id TEXT NOT NULL PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
      agent_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      priority TEXT NOT NULL CHECK (priority IN ('P0', 'P1', 'P2', 'P3')),
      json TEXT NOT NULL,
      dedupe_key TEXT,
      received_at INTEGER NOT NULL,
      queued_at INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'claimed', 'done', 'expired', 'failed')),
      wakeup_id TEXT,
      not_before INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      FOREIGN KEY (org_id, agent_id) REFERENCES kin_leads(org_id, agent_id),
      FOREIGN KEY (org_id, wakeup_id) REFERENCES kin_wakeups(org_id, wakeup_id)
    )
  `;
  yield* sql`CREATE INDEX idx_kin_events_wakeup ON kin_events(wakeup_id)`;
  yield* sql`CREATE UNIQUE INDEX idx_kin_events_dedupe ON kin_events(org_id, dedupe_key)`;
  yield* sql`CREATE INDEX idx_kin_events_queue ON kin_events(org_id, agent_id, state, priority, received_at, not_before)`;
  yield* sql`
    CREATE TABLE kin_workers (
      worker_id TEXT NOT NULL PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
      agent_id TEXT NOT NULL,
      wakeup_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('build', 'review', 'research')),
      thread_id TEXT NOT NULL,
      review_of TEXT,
      model_json TEXT NOT NULL,
      provenance_json TEXT NOT NULL,
      status TEXT NOT NULL,
      report_json TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      UNIQUE (org_id, worker_id),
      UNIQUE (thread_id),
      FOREIGN KEY (org_id, agent_id) REFERENCES kin_leads(org_id, agent_id),
      FOREIGN KEY (org_id, wakeup_id) REFERENCES kin_wakeups(org_id, wakeup_id),
      FOREIGN KEY (org_id, review_of) REFERENCES kin_workers(org_id, worker_id)
    )
  `;
  yield* sql`CREATE INDEX idx_kin_workers_status ON kin_workers(org_id, status)`;
  yield* sql`
    CREATE TABLE kin_cursor (
      org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
      consumer TEXT NOT NULL,
      after_sequence INTEGER NOT NULL CHECK (after_sequence >= 0),
      PRIMARY KEY (org_id, consumer)
    )
  `;
  yield* sql`
    CREATE TABLE kin_shadow_entries (
      entry_id TEXT NOT NULL PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
      agent_id TEXT NOT NULL,
      wakeup_id TEXT NOT NULL,
      level TEXT NOT NULL CHECK (level IN ('L0', 'L1', 'L2', 'L3')),
      unlocks_level TEXT NOT NULL CHECK (unlocks_level IN ('L1', 'L2', 'L3')),
      tool TEXT NOT NULL,
      input_json TEXT NOT NULL,
      would_target TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      verdict TEXT CHECK (verdict IN ('fine', 'change', 'wrong', 'harmful')),
      verdict_note TEXT,
      reviewed_at INTEGER,
      FOREIGN KEY (org_id, agent_id) REFERENCES kin_leads(org_id, agent_id),
      FOREIGN KEY (org_id, wakeup_id) REFERENCES kin_wakeups(org_id, wakeup_id)
    )
  `;
  yield* sql`CREATE INDEX idx_kin_shadow_entries_promotion ON kin_shadow_entries(org_id, agent_id, unlocks_level, verdict)`;
  yield* sql`CREATE INDEX idx_kin_shadow_entries_review ON kin_shadow_entries(org_id, agent_id, created_at)`;
  yield* sql`
    CREATE TABLE kin_budget_limits (
      org_id TEXT NOT NULL PRIMARY KEY REFERENCES kin_orgs(org_id),
      limits_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE kin_budget (
      org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
      day TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
      lead_units REAL NOT NULL DEFAULT 0 CHECK (lead_units >= 0),
      worker_units REAL NOT NULL DEFAULT 0 CHECK (worker_units >= 0),
      exhausted_notified_at INTEGER,
      PRIMARY KEY (org_id, day)
    )
  `;
  yield* sql`
    CREATE TABLE kin_org_state (
      org_id TEXT NOT NULL PRIMARY KEY REFERENCES kin_orgs(org_id),
      paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
      paused_at INTEGER,
      paused_by TEXT,
      reason TEXT,
      CHECK ((paused = 0 AND paused_at IS NULL AND paused_by IS NULL AND reason IS NULL)
        OR (paused = 1 AND paused_at IS NOT NULL AND paused_by IS NOT NULL)),
      FOREIGN KEY (org_id, paused_by) REFERENCES kin_people(org_id, person_id)
    )
  `;
});
