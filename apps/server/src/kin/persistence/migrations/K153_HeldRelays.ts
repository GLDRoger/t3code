import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A relay, nudge or notice to a person in their quiet hours is held like any other unprompted
 * post: one written by an agent posts as that agent, and a teammate's request still waits on
 * the person it went to.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(kin_held_posts)`;
  if (!columns.some((column) => column.name === "agent_id"))
    yield* sql`ALTER TABLE kin_held_posts ADD COLUMN agent_id TEXT`;
  if (!columns.some((column) => column.name === "waits"))
    yield* sql`ALTER TABLE kin_held_posts ADD COLUMN waits INTEGER NOT NULL DEFAULT 0
      CHECK (waits IN (0, 1))`;
});
