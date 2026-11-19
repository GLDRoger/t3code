import { type KinDealStage, KinDealStage as Stage, type KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

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

/** A stage's name by id, for history lines; an id no longer a stage reads as itself. */
export const stageName = (stages: ReadonlyArray<KinDealStage>, id: string | null) =>
  id === null ? null : (stages.find((stage) => stage.id === id)?.name ?? id);
