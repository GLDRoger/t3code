import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * What Kin keeps watch on (`watches/KinWatches.ts`): one row per open loop with its next look, one
 * row per look (and one per round, `watch_id` NULL) as the log, and the company's model for
 * background checks (NULL: the provider's smallest).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_watches (
    org_id TEXT NOT NULL,
    watch_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN
      ('person', 'agent', 'promise', 'sense', 'task', 'turn', 'host', 'arrival')),
    source_key TEXT NOT NULL,
    record_id TEXT,
    subject_ref TEXT,
    about TEXT NOT NULL CHECK (length(about) <= 200),
    closes_when TEXT NOT NULL CHECK (length(closes_when) <= 200),
    condition_json TEXT,
    agent_id TEXT,
    for_person_id TEXT,
    audience TEXT NOT NULL CHECK (audience IN ('owner', 'person')),
    why TEXT NOT NULL CHECK (length(why) <= 200),
    set_by_kind TEXT NOT NULL CHECK (set_by_kind IN ('person', 'agent', 'code')),
    set_by_id TEXT,
    set_after_outside INTEGER NOT NULL DEFAULT 0 CHECK (set_after_outside IN (0, 1)),
    urgent_asked INTEGER NOT NULL DEFAULT 0 CHECK (urgent_asked IN (0, 1)),
    latest_by INTEGER,
    next_look_at INTEGER NOT NULL,
    interval_ms INTEGER NOT NULL CHECK (interval_ms > 0),
    -- Look now (or Watch again) was asked at this time; the next look clears it.
    asked_look_at INTEGER,
    looked_at INTEGER,
    last_outcome TEXT CHECK (last_outcome IN
      ('nothing_new', 'closed', 'changed', 'problem', 'cant_tell', 'skipped_limit')),
    last_line TEXT CHECK (length(last_line) <= 300),
    -- Its record is set aside: no look until the hold ends (aside_until NULL: until lifted).
    aside INTEGER NOT NULL DEFAULT 0 CHECK (aside IN (0, 1)),
    aside_until INTEGER,
    state TEXT NOT NULL CHECK (state IN ('open', 'closed', 'stopped')),
    closed_at INTEGER,
    closed_how TEXT CHECK (length(closed_how) <= 200),
    closed_by_kind TEXT CHECK (closed_by_kind IN ('person', 'agent', 'code')),
    closed_by_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, watch_id),
    UNIQUE (org_id, kind, source_key)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_kin_watches_due
    ON kin_watches (org_id, state, next_look_at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_kin_watches_record
    ON kin_watches (org_id, record_id) WHERE record_id IS NOT NULL`;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_watch_looks (
    org_id TEXT NOT NULL,
    look_id TEXT NOT NULL,
    round_id TEXT NOT NULL,
    watch_id TEXT,
    at INTEGER NOT NULL,
    why TEXT CHECK (why IN ('asked', 'again', 'routine')),
    by TEXT CHECK (by IN ('code', 'scout')),
    outcome TEXT CHECK (outcome IN
      ('nothing_new', 'closed', 'changed', 'problem', 'cant_tell', 'skipped_limit')),
    did TEXT CHECK (did IN ('problem', 'closed', 'checked_work', 'prepared', 'nothing_new')),
    line TEXT CHECK (length(line) <= 300),
    -- Ids only (record keys, thread and message ids, PR links), never words.
    evidence_json TEXT,
    outside INTEGER NOT NULL DEFAULT 0 CHECK (outside IN (0, 1)),
    arrival_id TEXT,
    wakeup_id TEXT,
    scout_thread_id TEXT,
    units REAL CHECK (units >= 0),
    tokens_json TEXT,
    counts_json TEXT,
    PRIMARY KEY (org_id, look_id),
    CHECK ((watch_id IS NULL) = (counts_json IS NOT NULL))
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_kin_watch_looks_at ON kin_watch_looks (org_id, at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_kin_watch_looks_watch
    ON kin_watch_looks (org_id, watch_id, at) WHERE watch_id IS NOT NULL`;
  const columns = yield* sql<{ name: string }>`SELECT name
    FROM pragma_table_info('kin_agent_defaults') WHERE name = 'scout_model_json' ORDER BY name`;
  if (columns.length === 0)
    yield* sql`ALTER TABLE kin_agent_defaults ADD COLUMN scout_model_json TEXT`;
});
