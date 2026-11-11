import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Work: lists (registers), their entries (records), links, the change log and each lead's cursor
 * per chat. Only `KinRecords` writes them. Amount, repeat and list fields are here so later slices
 * add behaviour, not columns; nothing reads them yet.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_registers (
    org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    register_id TEXT NOT NULL,
    name TEXT NOT NULL,
    key_prefix TEXT NOT NULL,
    built_in INTEGER NOT NULL DEFAULT 0 CHECK (built_in IN (0, 1)),
    next_number INTEGER NOT NULL DEFAULT 1 CHECK (next_number >= 1),
    definition_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    archived_at INTEGER,
    PRIMARY KEY (org_id, register_id),
    UNIQUE (org_id, key_prefix)
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_records (
    org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
    record_id TEXT NOT NULL,
    register_id TEXT NOT NULL,
    key TEXT NOT NULL,
    title TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'open'
      CHECK (state IN ('open', 'doing', 'waiting', 'done', 'dropped')),
    waiting_on_kind TEXT CHECK (waiting_on_kind IN ('person', 'agent')),
    waiting_on_id TEXT,
    owner_kind TEXT NOT NULL CHECK (owner_kind IN ('person', 'agent')),
    owner_id TEXT NOT NULL,
    party_id TEXT,
    project_id TEXT,
    side TEXT NOT NULL DEFAULT 'ours' CHECK (side IN ('ours', 'theirs')),
    category TEXT,
    due_at INTEGER,
    due_all_day INTEGER NOT NULL DEFAULT 0 CHECK (due_all_day IN (0, 1)),
    date_at INTEGER,
    end_at INTEGER,
    amount_minor INTEGER,
    currency TEXT,
    repeat_json TEXT,
    sensitive INTEGER NOT NULL DEFAULT 0 CHECK (sensitive IN (0, 1)),
    confirmed INTEGER NOT NULL DEFAULT 1 CHECK (confirmed IN (0, 1)),
    notes TEXT NOT NULL DEFAULT '',
    fields_json TEXT NOT NULL DEFAULT '{}',
    rev INTEGER NOT NULL DEFAULT 1 CHECK (rev >= 1),
    source_chat_id TEXT,
    source_message_id TEXT,
    created_by_kind TEXT NOT NULL CHECK (created_by_kind IN ('person', 'agent', 'system')),
    created_by_id TEXT,
    -- The human who gave it to its current owner: the only authority a lead's work on it has.
    assigned_by_person_id TEXT REFERENCES kin_people(person_id),
    assigned_at INTEGER,
    -- What makes a create idempotent: a lead's turn and row, a worker, an imported memory item.
    origin_key TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    closed_at INTEGER,
    PRIMARY KEY (org_id, record_id),
    UNIQUE (org_id, key),
    UNIQUE (org_id, origin_key),
    FOREIGN KEY (org_id, register_id) REFERENCES kin_registers(org_id, register_id)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_kin_records_state_due
    ON kin_records (org_id, state, due_at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_kin_records_owner
    ON kin_records (org_id, owner_kind, owner_id, state)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_kin_records_party ON kin_records (org_id, party_id)
    WHERE party_id IS NOT NULL`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_kin_records_project ON kin_records (org_id, project_id)
    WHERE project_id IS NOT NULL`;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_record_links (
    org_id TEXT NOT NULL,
    record_id TEXT NOT NULL,
    kind TEXT NOT NULL
      CHECK (kind IN ('message', 'worker', 'pull_request', 'record', 'memory', 'url')),
    target TEXT NOT NULL,
    relation TEXT NOT NULL
      CHECK (relation IN ('source', 'attempt', 'evidence', 'relates', 'blocks', 'parent')),
    chat_id TEXT,
    label TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, record_id, kind, target),
    FOREIGN KEY (org_id, record_id) REFERENCES kin_records(org_id, record_id)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_kin_record_links_target
    ON kin_record_links (org_id, kind, target)`;
  // The sequence number is the cursor: "what changed since" is every row above a lead's.
  yield* sql`CREATE TABLE IF NOT EXISTS kin_record_changes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id TEXT NOT NULL,
    record_id TEXT NOT NULL,
    rev INTEGER NOT NULL,
    at INTEGER NOT NULL,
    actor_kind TEXT NOT NULL CHECK (actor_kind IN ('person', 'agent', 'system')),
    actor_id TEXT,
    via TEXT NOT NULL CHECK (via IN ('lead', 'owner', 'worker', 'github', 'import')),
    kind TEXT NOT NULL CHECK (kind IN ('created', 'updated', 'linked')),
    fields_json TEXT NOT NULL,
    wakeup_id TEXT,
    chat_id TEXT,
    FOREIGN KEY (org_id, record_id) REFERENCES kin_records(org_id, record_id)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_kin_record_changes_record
    ON kin_record_changes (org_id, record_id, seq)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_kin_record_changes_org ON kin_record_changes (org_id, seq)`;
  // What a lead last told a chat: `seq` once a reply of its posted there after `pending_msg_seq`.
  yield* sql`CREATE TABLE IF NOT EXISTS kin_record_cursors (
    org_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    seq INTEGER NOT NULL DEFAULT 0,
    pending_seq INTEGER,
    pending_msg_seq INTEGER,
    PRIMARY KEY (org_id, agent_id, chat_id),
    FOREIGN KEY (org_id, agent_id) REFERENCES kin_leads(org_id, agent_id)
  )`;
});
