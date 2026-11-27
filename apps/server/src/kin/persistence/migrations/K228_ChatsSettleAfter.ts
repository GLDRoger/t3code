import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A person's chosen hours after a chat's last message before a read chat moves under Settled
 * (null is the 12-hour default; 0 settles right away).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const people = yield* sql<{ name: string }>`PRAGMA table_info(kin_people)`;
  if (!people.some((column) => column.name === "chats_settle_after_hours"))
    yield* sql`ALTER TABLE kin_people ADD COLUMN chats_settle_after_hours INTEGER NULL
      CHECK (chats_settle_after_hours IN (0, 6, 12, 24))`;
});
