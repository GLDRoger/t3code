import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import { resolveLead } from "../lead/LeadMemory.ts";
import { markOutside } from "../lead/OutsideContent.ts";
import * as Work from "./leadWork.ts";
import { originKeyOf } from "./statements/bankList.ts";

/**
 * The turn is shown entries whose words a bank or a payer wrote: statement and alert rows, and the
 * expenses a statement's Confirm made from them (`statementApply.ts` keys those `statement:…:expense`).
 */
export const bankTextShown = Effect.fn("KinRecordReads.bankTextShown")(function* (
  lead: Work.Lead,
  keys: ReadonlyArray<string>,
) {
  if (keys.length === 0) return;
  const sql = yield* SqlClient.SqlClient;
  const [outside] = yield* sql`SELECT 1 FROM kin_records
    WHERE org_id = ${lead.orgId} AND key IN ${sql.in(keys)}
      AND (origin_key LIKE ${originKeyOf("%")} OR origin_key LIKE 'alert:%'
        OR origin_key LIKE 'statement:%:expense')
    LIMIT 1`;
  if (outside !== undefined) yield* markOutside(lead, "bank-transaction");
});

// Provenance and the wake-up must come from the same reader snapshot as Work's answer.
const snapshot = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => sql.withTransaction(effect));

export const get = Effect.fn("KinRecordReads.get")(function* (
  scope: McpInvocationScope,
  input: typeof Work.GetInput.Type,
) {
  const result = yield* Work.get(scope, input);
  yield* bankTextShown(yield* resolveLead(scope), [
    result.key,
    ...(result.bank?.credits?.map((credit) => credit.key) ?? []),
  ]);
  return result;
}, snapshot);

export const query = Effect.fn("KinRecordReads.query")(function* (
  scope: McpInvocationScope,
  input: typeof Work.QueryInput.Type,
) {
  const result = yield* Work.query(scope, input);
  yield* bankTextShown(
    yield* resolveLead(scope),
    result.records.map((row) => row.key),
  );
  return result;
}, snapshot);
