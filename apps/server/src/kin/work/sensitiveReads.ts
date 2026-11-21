import { KinChatError, type KinOrgId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { sensitiveNow } from "./recordRows.ts";

export type SensitiveMark = { readonly orgId: KinOrgId; readonly wakeupId: string };
/** Set while a read tool runs on a reader (`mcp/readTools.ts`), which writes these after it. */
export const heldSensitiveMarks = Context.Reference<Array<SensitiveMark> | undefined>(
  "t3/kin/work/sensitiveReads/heldSensitiveMarks",
  { defaultValue: () => undefined },
);

/**
 * The agent's wake-up was shown a sensitive Work entry: what it writes from now on may carry it.
 */
export const sensitiveShown = Effect.fn("KinSensitiveReads.sensitiveShown")(function* (
  input: SensitiveMark,
) {
  const held = yield* heldSensitiveMarks;
  if (held !== undefined) {
    held.push({ orgId: input.orgId, wakeupId: input.wakeupId });
    return;
  }
  const sql = yield* SqlClient.SqlClient;
  const at = yield* Clock.currentTimeMillis;
  yield* sql`INSERT INTO kin_wakeup_sensitive_reads (org_id, wakeup_id, read_at)
    VALUES (${input.orgId}, ${input.wakeupId}, ${at}) ON CONFLICT (org_id, wakeup_id) DO NOTHING`;
});

/** Whether the turn has shown the agent anything sensitive: what it writes now may carry it. */
export const turnSensitive = Effect.fn("KinSensitiveReads.turnSensitive")(function* (
  orgId: KinOrgId,
  wakeupId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`SELECT 1 FROM kin_wakeup_sensitive_reads
    WHERE org_id = ${orgId} AND wakeup_id = ${wakeupId} LIMIT 1`;
  return rows.length > 0;
});

/** A refusal that quotes something sensitive, so the tool marks the turn as a result would. */
export class SensitiveRefusal extends KinChatError {}
// @effect-diagnostics-next-line instanceOfSchema:off -- the subclass, not the schema, marks it.
export const isSensitiveRefusal = (error: unknown) => error instanceof SensitiveRefusal;

/** The same for a prompt that shows these entries, when any of them is sensitive now. */
export const entriesShown = Effect.fn("KinSensitiveReads.entriesShown")(function* (input: {
  readonly orgId: KinOrgId;
  readonly wakeupId: string;
  readonly recordIds: ReadonlyArray<string>;
  readonly keys: ReadonlyArray<string>;
}) {
  if (input.recordIds.length === 0 && input.keys.length === 0) return;
  const sql = yield* SqlClient.SqlClient;
  const named = [
    ...(input.recordIds.length === 0 ? [] : [sql`r.record_id IN ${sql.in(input.recordIds)}`]),
    ...(input.keys.length === 0 ? [] : [sql`r.key IN ${sql.in(input.keys)}`]),
  ];
  const found = yield* sql`SELECT 1 FROM kin_records r
    WHERE r.org_id = ${input.orgId} AND ${sql.or(named)} AND ${sensitiveNow(sql)} LIMIT 1`;
  if (found.length > 0) yield* sensitiveShown(input);
});

/**
 * The same for a prompt that shows what an earlier turn wrote, such as a reminder or a scheduled
 * task, when that turn had been shown something sensitive: the words may carry it.
 */
export const sourcesShown = Effect.fn("KinSensitiveReads.sourcesShown")(function* (input: {
  readonly orgId: KinOrgId;
  readonly wakeupId: string;
  readonly eventIds: ReadonlyArray<string>;
}) {
  if (input.eventIds.length === 0) return;
  const sql = yield* SqlClient.SqlClient;
  const found = yield* sql`SELECT 1 FROM kin_events e
    JOIN kin_wakeup_sensitive_reads w ON w.org_id = e.org_id AND w.wakeup_id = e.wakeup_id
    WHERE e.org_id = ${input.orgId} AND e.event_id IN ${sql.in(input.eventIds)} LIMIT 1`;
  if (found.length > 0) yield* sensitiveShown(input);
});

/** Whether a tool result carries an entry marked sensitive anywhere in it. */
export const showsSensitive = (value: unknown): boolean =>
  Array.isArray(value)
    ? value.some(showsSensitive)
    : typeof value === "object" && value !== null
      ? Reflect.get(value, "sensitive") === true || Object.values(value).some(showsSensitive)
      : false;
