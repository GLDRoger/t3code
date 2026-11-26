import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(kin_wakeups)`;
  for (const [name, definition] of [
    ["kind", "TEXT NOT NULL DEFAULT 'turn' CHECK (kind IN ('turn', 'upkeep'))"],
    ["carry_json", "TEXT"],
    ["standing_key", "TEXT"],
    ["delta_json", "TEXT"],
    ["prompt_index", "TEXT"],
    ["context_tokens", "INTEGER"],
    ["last_request_at", "INTEGER"],
  ] as const) {
    if (!columns.some((column) => column.name === name))
      yield* sql`ALTER TABLE kin_wakeups ADD COLUMN ${sql(name)} ${sql.literal(definition)}`;
  }
});
