import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import { resolveLead } from "../lead/LeadMemory.ts";
import { markOutside } from "../lead/OutsideContent.ts";
import * as Work from "./leadWork.ts";
import { isBuiltIn } from "./registers.ts";
import { originKeyOf } from "./statements/bankList.ts";

const markBankText = Effect.fn("KinRecordReads.markBankText")(function* (
  scope: McpInvocationScope,
  keys: ReadonlyArray<string>,
) {
  if (keys.length === 0) return;
  const lead = yield* resolveLead(scope);
  const sql = yield* SqlClient.SqlClient;
  const [outside] = yield* sql`SELECT 1 FROM kin_records
    WHERE org_id = ${lead.orgId} AND key IN ${sql.in(keys)}
      AND (origin_key LIKE ${originKeyOf("%")} OR origin_key LIKE 'alert:%')
    LIMIT 1`;
  if (outside !== undefined) yield* markOutside(lead, "bank-transaction");
});

const customListKey = (row: { readonly list?: string | undefined; readonly key: string }) =>
  row.list === undefined || isBuiltIn(row.list) ? [] : [row.key];

// Provenance and the wake-up must come from the same reader snapshot as Work's answer.
const snapshot = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => sql.withTransaction(effect));

export const get = Effect.fn("KinRecordReads.get")(function* (
  scope: McpInvocationScope,
  input: typeof Work.GetInput.Type,
) {
  const result = yield* Work.get(scope, input);
  yield* markBankText(scope, [
    ...customListKey(result),
    ...(result.bank?.credits?.map((credit) => credit.key) ?? []),
  ]);
  return result;
}, snapshot);

export const query = Effect.fn("KinRecordReads.query")(function* (
  scope: McpInvocationScope,
  input: typeof Work.QueryInput.Type,
) {
  const result = yield* Work.query(scope, input);
  yield* markBankText(scope, result.records.flatMap(customListKey));
  return result;
}, snapshot);
