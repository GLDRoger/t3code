import type { KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Bills read in the background (`work/bills.ts`): a bill is text from outside the company, so a
 * wake-up of nothing but `bills.read` is confined as an outsider's review is (`outsideReview.ts`):
 * its own thread with no shell, files or web search, listing and admitting only `BILLS_TOOLS`.
 */
export const BILLS_THREAD_PREFIX = "kin-shared:bills:";

export const BILLS_TOOLS: ReadonlySet<string> = new Set(["bill_read"]);

/** What every other tool answers in that turn. */
export const BILLS_REFUSAL = "This turn only answers bills: bill_read.";

type Turn = { readonly orgId: KinOrgId; readonly wakeupId: string };

/** Whether every event of this wake-up is bills to read, from its stored events. */
export const billsOnly = Effect.fn("KinBillsOnly.of")(function* (turn: Turn) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ others: number }>`SELECT COUNT(event_id) FILTER (
      WHERE tag != 'bills.read') AS others FROM kin_events
    WHERE org_id = ${turn.orgId} AND wakeup_id = ${turn.wakeupId}
    HAVING COUNT(event_id) FILTER (WHERE tag = 'bills.read') > 0`;
  return row !== undefined && row.others === 0;
});

/** Whether `name` may run in a bills turn; undefined when the turn isn't one. */
export const billToolAllowed = Effect.fn("KinBillsOnly.allowed")(
  function* (turn: Turn, name: string, _args: unknown) {
    if (!(yield* billsOnly(turn))) return undefined;
    return BILLS_TOOLS.has(name);
  },
  Effect.catchCause((cause) =>
    Effect.logWarning("Kin bills turn check failed; refusing", { cause }).pipe(
      Effect.as<boolean | undefined>(false),
    ),
  ),
);
