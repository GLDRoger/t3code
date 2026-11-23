import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Generated pictures (`pictures/KinPictures.ts`): an org's picture setting, and one count row per
 * generation. The key itself is in the server's secret store, never here.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS kin_picture_settings (
      org_id TEXT NOT NULL PRIMARY KEY,
      -- NULL is No limit: nothing is refused for count, and the count is still kept
      monthly_limit INTEGER CHECK (monthly_limit IS NULL OR monthly_limit >= 1),
      -- NULL is the vendor's default model
      model TEXT,
      -- when the key in use was saved; NULL once disconnected
      key_saved_at INTEGER,
      -- the month ('2026-11', the company's zone) owner-level people were told 80% was used
      warned_month TEXT,
      updated_at INTEGER NOT NULL,
      updated_by TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS kin_picture_counts (
      org_id TEXT NOT NULL,
      count_id TEXT NOT NULL,
      -- the company's month when it was asked for, such as '2026-11'
      month TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      -- who asked; NULL when no person did, such as a scheduled task
      person_id TEXT,
      count INTEGER NOT NULL CHECK (count BETWEEN 1 AND 4),
      -- 'reserved' before the vendor call, 'made' after; a failed call's row is deleted
      state TEXT NOT NULL CHECK (state IN ('reserved', 'made', 'unclear')),
      at INTEGER NOT NULL,
      -- what a made generation returned (its stored files), so a retried call returns it again
      made_json TEXT,
      PRIMARY KEY (org_id, count_id)
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS kin_picture_counts_month
    ON kin_picture_counts (org_id, month, state)`;
  // The chat image each picture version was posted as: who reads that reply reads the version.
  // A drawn version keeps the page it was drawn from, a generated one its whole prompt, so a
  // change starts from it.
  yield* sql`
    CREATE TABLE IF NOT EXISTS kin_picture_images (
      org_id TEXT NOT NULL,
      record_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      attachment_id TEXT NOT NULL,
      page TEXT,
      prompt TEXT,
      PRIMARY KEY (org_id, record_id, version)
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS kin_picture_images_attachment
    ON kin_picture_images (org_id, attachment_id)`;
});
