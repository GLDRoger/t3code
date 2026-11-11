import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(kin_messages)`;
  // A silent row is shown but never pushes and never counts as unread or on the badge.
  if (!columns.some((column) => column.name === "silent"))
    yield* sql`ALTER TABLE kin_messages ADD COLUMN silent INTEGER NOT NULL DEFAULT 0 CHECK (silent IN (0, 1))`;
  // Older hosts told every lead's chat about each failed nightly pass. Dismissed, as K035 does,
  // so synced clients drop them through `change_seq` and they stop counting as unread.
  yield* sql`UPDATE kin_messages SET status = 'dismissed'
    WHERE author_kind = 'system' AND status = 'posted'
      AND body LIKE 'Last night''s dream failed and merged nothing%'`;
});
