import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(kin_wakeups)`;
  // When someone besides the lead's owner joined a chat this private-context turn answers in:
  // from then on it may do nothing, and its events go to a fresh wake-up (lead/Audience.ts).
  if (!columns.some((column) => column.name === "aborted_at"))
    yield* sql`ALTER TABLE kin_wakeups ADD COLUMN aborted_at INTEGER`;
  // When its reply settled; a join after that has nothing left to abort.
  if (!columns.some((column) => column.name === "settled_at"))
    yield* sql`ALTER TABLE kin_wakeups ADD COLUMN settled_at INTEGER`;
});
