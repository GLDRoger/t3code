import {
  KinListId,
  KinNumberCadence,
  KinNumberDecimal,
  KinNumberDirection,
  KinNumberSource,
  KinRecordState,
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
