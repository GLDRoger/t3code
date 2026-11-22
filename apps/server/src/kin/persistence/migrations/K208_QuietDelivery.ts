import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A person's switch for replies to what they asked ringing in their quiet hours (null is on), and
 * whether an Android phone's build made the quiet channel (0 for every phone registered before).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const people = yield* sql<{ name: string }>`PRAGMA table_info(kin_people)`;
  if (!people.some((column) => column.name === "answers_ring"))
    yield* sql`ALTER TABLE kin_people ADD COLUMN answers_ring INTEGER NULL
      CHECK (answers_ring IN (0, 1))`;
  const devices = yield* sql<{ name: string }>`PRAGMA table_info(kin_push_devices)`;
  if (!devices.some((column) => column.name === "quiet_channel"))
    yield* sql`ALTER TABLE kin_push_devices ADD COLUMN quiet_channel INTEGER NOT NULL DEFAULT 0
      CHECK (quiet_channel IN (0, 1))`;
});
