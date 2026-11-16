import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Questions an agent put to a person: asked once across agents, with the default it takes and
 * the day it takes it, until answered, taken or withdrawn (`questions/questions.ts`).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS kin_questions (
    question_id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    person_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    widget_id TEXT,
    raise_widget_id TEXT,
    question TEXT NOT NULL,
    options_json TEXT,
    default_label TEXT,
    safe INTEGER NOT NULL,
    about TEXT NOT NULL DEFAULT '',
    intent TEXT NOT NULL DEFAULT '',
    asked_at INTEGER NOT NULL,
    due_at INTEGER NOT NULL,
    act_at INTEGER NOT NULL,
    state TEXT NOT NULL,
    raised_at INTEGER,
    closed_at INTEGER,
    answer TEXT
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS kin_questions_due
    ON kin_questions (org_id, act_at) WHERE state = 'open'`;
  yield* sql`CREATE INDEX IF NOT EXISTS kin_questions_person
    ON kin_questions (org_id, person_id) WHERE state = 'open'`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS kin_questions_widget
    ON kin_questions (widget_id) WHERE widget_id IS NOT NULL`;
});
