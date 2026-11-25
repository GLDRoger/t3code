import { type KinDealStage, KinDealStage as Stage, type KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { FieldChange } from "./recordRows.ts";

/**
 * The company's deal stages, kept in the built-in `deals` register's `definition_json` (whose
 * readers in `registers.ts` read only `built_in = 0` rows). Absent, they are these.
 */
export const DEFAULT_STAGES: ReadonlyArray<KinDealStage> = [
  { id: "new", name: "New" },
  { id: "in-talks", name: "In talks" },
  { id: "proposal", name: "Proposal" },
  { id: "deciding", name: "Deciding" },
];

const Stored = Schema.Struct({
  stages: Schema.optional(Schema.Array(Stage)),
  stagesRev: Schema.optional(Schema.Int),
});
const decodeStored = Schema.decodeUnknownOption(Schema.fromJsonString(Stored));

const parseStages = (json: string | null | undefined) => {
  const stored = json === null || json === undefined ? Option.none() : decodeStored(json);
  const value = Option.getOrUndefined(stored);
  return {
    stages: value?.stages !== undefined && value.stages.length > 0 ? value.stages : DEFAULT_STAGES,
    rev: value?.stagesRev ?? 0,
  };
};

/** Through the caller's transaction. */
export const stagesOf = Effect.fn("KinDeals.stagesOf")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ json: string }>`SELECT definition_json AS json FROM kin_registers
    WHERE org_id = ${orgId} AND register_id = 'deals' AND built_in = 1`;
  return parseStages(row?.json);
});

/**
 * A stage's name by id. One no longer a stage reads as its default's name, else as itself: a move
 * keeps its own names (`FieldChange.names`), so only one written before that can need this.
 */
const stageName = (stages: ReadonlyArray<KinDealStage>, id: string | null) =>
  id === null
    ? null
    : ((stages.find((stage) => stage.id === id) ?? DEFAULT_STAGES.find((stage) => stage.id === id))
        ?.name ?? id);

/** A stage change's line in words: the names its stages had at the move, else their names now. */
export const stageLine = (
  stages: ReadonlyArray<KinDealStage>,
  { names, ...change }: FieldChange,
) => ({
  ...change,
  from: names?.from ?? stageName(stages, change.from),
  to: names?.to ?? stageName(stages, change.to),
});

/** A move's patch, with the names its stages have now kept on its history line. */
export const stageMove = (
  stages: ReadonlyArray<KinDealStage>,
  from: string | null,
  to: string,
) => ({
  fields: { stage: to },
  names: { stage: { from: stageName(stages, from), to: stageName(stages, to) } },
});

/**
 * Whether the weekly brief's page carries the pipeline's three lines (Settings → Check-ins). Kept
 * beside the stages: a check-in row has no column for it. Off until the owner level turns it on.
 */
export const weeklyPipelineOf = Effect.fn("KinDeals.weeklyPipelineOf")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ on: number | null }>`SELECT
      json_extract(definition_json, '$.weeklyPipeline') AS "on" FROM kin_registers
    WHERE org_id = ${orgId} AND register_id = 'deals' AND built_in = 1`;
  return row?.on === 1;
});

export const setWeeklyPipeline = Effect.fn("KinDeals.setWeeklyPipeline")(function* (
  orgId: KinOrgId,
  on: boolean,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in, created_at)
    VALUES (${orgId}, 'deals', 'Deals', 'DL', 1, ${now})
    ON CONFLICT DO NOTHING`;
  yield* sql`UPDATE kin_registers SET definition_json = json_set(
      COALESCE(NULLIF(definition_json, ''), '{}'), '$.weeklyPipeline', ${on ? 1 : 0})
    WHERE org_id = ${orgId} AND register_id = 'deals' AND built_in = 1`;
});
