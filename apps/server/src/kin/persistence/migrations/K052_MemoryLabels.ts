import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Who may know a memory item, where its file can't say so yet. `held_at`: marked sensitive
  // since, ahead of the turn's commit or the owner's review of that folder. `classified`: the
  // nightly pass's label for an item written before labels existed, used until its file has one.
  yield* sql`
    CREATE TABLE IF NOT EXISTS kin_memory_labels (
      org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
      item_id TEXT NOT NULL,
      held_at INTEGER CHECK (held_at IS NULL OR typeof(held_at) = 'integer'),
      classified INTEGER CHECK (classified IS NULL OR classified IN (0, 1)),
      PRIMARY KEY (org_id, item_id)
    )
  `;
});
