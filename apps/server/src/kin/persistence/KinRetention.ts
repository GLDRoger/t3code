import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/sql/SqlClient";

import { prunePushSent } from "../push/KinPushTopics.ts";
import { pruneLooks } from "../watches/KinWatches.ts";

/** How long history stays after its wake-up ended, and how much one pass deletes. */
const KEEP = Duration.days(90);
const BATCH = 5_000;
const BATCHES = 20;

/**
 * A wake-up's tool-call receipts are only read while it runs (`resolveLead` and recovery gate on
 * `status = 'running'`), and no wake-up returns to running, so an ended one's receipts can go.
 */
export const prune = Effect.fn("KinRetention.prune")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const before = (yield* Clock.currentTimeMillis) - Duration.toMillis(KEEP);
  for (let batch = 0; batch < BATCHES; batch++) {
    // A scheduler scan over every org, bounded by the batch size.
    const gone = yield* sql`DELETE FROM kin_lead_tool_calls WHERE rowid IN (
        SELECT c.rowid FROM kin_lead_tool_calls c JOIN kin_wakeups w
          ON w.org_id = c.org_id AND w.wakeup_id = c.wakeup_id
        WHERE w.status <> 'running' AND w.ended_at < ${before}
        ORDER BY c.rowid LIMIT ${BATCH})
      RETURNING 1`;
    if (gone.length < BATCH) break;
  }
  // What Kin checked keeps 30 days (`watches/KinWatches.ts`).
  yield* pruneLooks(yield* Clock.currentTimeMillis);
  // What pushes told each person of keeps 7 days (`push/KinPushTopics.ts`).
  yield* prunePushSent(yield* Clock.currentTimeMillis);
});

/** Pruned at start and daily. */
export const schedule = prune().pipe(
  Effect.catchCause((cause) => Effect.logWarning("Kin retention prune failed", { cause })),
  Effect.repeat(Schedule.spaced(Duration.days(1))),
  Effect.forkScoped,
);
