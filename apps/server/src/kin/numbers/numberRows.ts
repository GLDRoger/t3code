import {
  KinListId,
  KinNumberCadence,
  KinNumberDecimal,
  KinNumberDirection,
  KinNumberSource,
  KinRecordKey,
  KinRecordState,
  MemoryItemEvery,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { KinOrgId } from "@t3tools/contracts";
import { fieldText, type FieldValues } from "../work/lists.ts";

export const NumberSpec = Schema.Union([
  Schema.Struct({
    builtin: Schema.Literals([
      "revenue_received",
      "clients_won",
      "tasks_done",
      "overdue_over_30",
      "pipeline_open",
      "invoiced_this_month",
    ]),
  }),
  Schema.Struct({
    count: KinListId,
    states: Schema.Array(KinRecordState).check(Schema.isMinLength(1), Schema.isMaxLength(10)),
  }),
]);
export const NumberSpecJson = Schema.fromJsonString(NumberSpec);
const readSpec = Schema.decodeOption(NumberSpecJson);

const textAs = <A>(schema: Schema.ConstraintCodec<A, string, never, never>, text: string | null) =>
  text === null ? undefined : Option.getOrUndefined(Schema.decodeOption(schema)(text));

export const numberFields = (fields: FieldValues) => {
  const rawSpec = fields.spec;
  const spec = typeof rawSpec === "string" ? Option.getOrUndefined(readSpec(rawSpec)) : undefined;
  if (rawSpec !== undefined && spec === undefined) return undefined;
  return {
    spec,
    unit: fieldText(fields, "unit") ?? undefined,
    source: textAs(KinNumberSource, fieldText(fields, "source")),
    direction: textAs(KinNumberDirection, fieldText(fields, "direction")),
    every: textAs(KinNumberCadence, fieldText(fields, "every")),
    above: textAs(KinNumberDecimal, fieldText(fields, "above")),
    below: textAs(KinNumberDecimal, fieldText(fields, "below")),
    kind:
      spec !== undefined
        ? ("computed" as const)
        : fields.source === undefined
          ? ("typed" as const)
          : ("recorded" as const),
  };
};

export const targetless = (sql: SqlClient.SqlClient) =>
  sql`json_extract(r.fields_json, '$.target') IS NULL`;

export const latestValue = Effect.fn("KinNumbers.latestValue")(function* (
  orgId: KinOrgId,
  recordId: string,
  through: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ value: string; asOf: string; source: string | null }>`SELECT
      value, as_of AS "asOf", source FROM kin_number_values
    WHERE org_id = ${orgId} AND record_id = ${recordId} AND as_of <= ${through}
    ORDER BY as_of DESC, seq DESC LIMIT 1`;
  return row;
});

/**
 * An agent's proposal of numbers to watch, waiting on the owner's card (`numbers_watch`). Its rows
 * live in `kin_profile_changes` under `nw_` ids, as the sections card's do under `sc_`.
 */
export const NUMBERS_CHANGE = "nw_";
/** A feed's schedule: its id, and its source event naming the card that made it. */
export const FEED_SCHEDULE = "feed-";
export const FEED_EVENT = "kin-numbers:";
export const isFeedSchedule = (scheduleId: string) => scheduleId.startsWith(FEED_SCHEDULE);

export const WatchedNumber = Schema.Struct({
  name: Schema.String,
  /** An existing number of that name, which Confirm changes instead of making a new one. */
  key: Schema.optional(KinRecordKey),
  unit: Schema.optional(Schema.String),
  direction: Schema.optional(KinNumberDirection),
  above: Schema.optional(KinNumberDecimal),
  below: Schema.optional(KinNumberDecimal),
  compute: Schema.optional(NumberSpec),
});
export const NumberFeed = Schema.Struct({
  source: KinNumberSource,
  every: KinNumberCadence,
  at: MemoryItemEvery.fields.at,
  how: Schema.optional(Schema.String),
});
export const NumbersChange = Schema.Struct({
  numbers: Schema.Array(WatchedNumber),
  feed: Schema.optional(NumberFeed),
  /** What the card was drawn against; Confirm applies only while it is still so. */
  base: Schema.String,
  /** Set on Confirm: who confirmed it, and once its feed's schedule is made, when. */
  by: Schema.optional(Schema.String),
  feedMadeAt: Schema.optional(Schema.Number),
});
export type NumbersChange = typeof NumbersChange.Type;
export const NumbersChangeJson = Schema.fromJsonString(NumbersChange);
export const decodeNumbersChange = Schema.decodeUnknownEffect(NumbersChangeJson);

/** Each feed whose schedule runs: who keeps it, its source and when it runs in the owner's time. */
export const liveFeeds = Effect.fn("KinNumbers.liveFeeds")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    scheduleId: string;
    agentId: string;
    chatId: string;
    patch: string;
  }>`SELECT s.schedule_id AS "scheduleId", s.agent_id AS "agentId", s.chat_id AS "chatId",
      c.patch_json AS patch
    FROM kin_schedules s
    JOIN kin_profile_changes c ON c.org_id = s.org_id
      AND c.change_id = substr(s.source_event, ${FEED_EVENT.length + 1})
    LEFT JOIN scheduled_tasks t ON t.task_id = s.task_id
    WHERE s.org_id = ${orgId} AND s.deleted_at IS NULL
      AND substr(s.schedule_id, 1, ${FEED_SCHEDULE.length}) = ${FEED_SCHEDULE}
      AND substr(s.source_event, 1, ${FEED_EVENT.length}) = ${FEED_EVENT}
      AND COALESCE(s.pending_enabled, t.enabled, 1) = 1
    ORDER BY s.schedule_id`;
  const feeds = [];
  for (const row of rows) {
    const { feed } = yield* decodeNumbersChange(row.patch).pipe(Effect.orDie);
    if (feed !== undefined) feeds.push({ ...row, feed });
  }
  return feeds;
});
