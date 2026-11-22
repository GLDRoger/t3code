import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

const addColumn = Effect.fn("K208.addColumn")(function* (
  table: string,
  column: string,
  type: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [has] = yield* sql<{ name: string }>`SELECT name FROM pragma_table_info(${table})
    WHERE name = ${column} ORDER BY name`;
  if (has === undefined)
    yield* sql`ALTER TABLE ${sql.literal(table)} ADD COLUMN ${sql.literal(column)} ${sql.literal(type)}`;
});

/**
 * A person's own mailbox (`person_id`; NULL is the company's, as every older row stays). One live
 * connection per address (`account_key`) and per person; a turn that read someone's own mailbox is
 * theirs (`kin_private_turns`), with its calls (`private_to`); `left_at` marks a handed-off send.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* addColumn("kin_connections", "person_id", "TEXT");
  yield* addColumn("kin_connections", "account_key", "TEXT");
  yield* sql`CREATE TABLE IF NOT EXISTS kin_private_turns (
    org_id TEXT NOT NULL,
    wakeup_id TEXT NOT NULL,
    person_id TEXT NOT NULL,
    marked_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, wakeup_id)
  )`;
  yield* addColumn("kin_connection_calls", "private_to", "TEXT");
  yield* addColumn("kin_connection_asks", "left_at", "INTEGER");
  yield* sql`CREATE INDEX IF NOT EXISTS kin_connections_person
    ON kin_connections (org_id, person_id) WHERE person_id IS NOT NULL`;
  // Live mail accounts keep their address once each; an older duplicate stays unkeyed.
  yield* sql`UPDATE kin_connections SET account_key = lower(trim(account_label))
    WHERE account_key IS NULL AND removed_at IS NULL AND kind = 'builtin'
      AND account_label IS NOT NULL AND trim(account_label) <> ''
      AND rowid = (SELECT MIN(o.rowid) FROM kin_connections o WHERE o.org_id = kin_connections.org_id
        AND o.removed_at IS NULL AND o.kind = 'builtin'
        AND lower(trim(o.account_label)) = lower(trim(kin_connections.account_label)))`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS kin_connections_live_account
    ON kin_connections (org_id, account_key)
    WHERE removed_at IS NULL AND account_key IS NOT NULL`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS kin_connections_live_person
    ON kin_connections (org_id, person_id)
    WHERE removed_at IS NULL AND person_id IS NOT NULL`;
});
