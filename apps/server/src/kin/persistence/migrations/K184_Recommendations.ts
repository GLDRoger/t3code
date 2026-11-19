import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A change Kin suggested to the owner on a card (`recommend/KinRecommend.ts`). Counts, whether it
 * still holds, whether the card ran out and whether a change is still in effect are read live;
 * this keeps only what can't be: that Kin asked and in which words, what the owner answered, and until
 * when that rule stays quiet. What Undo reverses is the card's sealed plan (`kin_card_plans`).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS kin_recommendations (
      org_id TEXT NOT NULL,
      -- hash of rule, subject and the owner's day: a retried pass posts nothing new
      rec_id TEXT NOT NULL,
      -- the rule's name and its own key ('person:<id>|agent:<id>'): the quiet ledger's subject
      rule TEXT NOT NULL,
      subject TEXT NOT NULL,
      -- its card, whose sealed plans say what Do it changes and Undo puts back
      widget_id TEXT NOT NULL,
      -- the sentence as shown, numbers included: the window moves, so it can't be recomputed
      noticed TEXT NOT NULL,
      -- the owner's answer; 'open' until tapped, ran out is read from the card
      state TEXT NOT NULL CHECK (state IN ('open', 'done', 'declined', 'stale')),
      posted_at INTEGER NOT NULL,
      -- when and whose tap it was: the owner, checked in the tap's transaction
      decided_at INTEGER,
      decided_by TEXT,
      -- no new card for this rule and subject before then; NULL on 'declined' is for good
      quiet_until INTEGER,
      PRIMARY KEY (org_id, rec_id)
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS kin_recommendations_subject
    ON kin_recommendations (org_id, rule, subject, posted_at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS kin_recommendations_posted
    ON kin_recommendations (org_id, posted_at)`;
});
