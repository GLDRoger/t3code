/**
 * Kin house lines: crowns, wills, and notes for a codebase area. Namespaced
 * `kin.houseLine` because upstream already uses "lineage" for thread chains;
 * the agent-facing MCP tools keep the design's `lineage_*` names.
 */

import * as Schema from "effect/Schema";

import {
  CommandId,
  IsoDateTime,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const KIN_WILL_CHAR_LIMIT = 2500;

export const EEVEE_LANE_LABEL = "EEVEE_LANE_LABEL";

/** Exported so a provider spawn can still see the old lane label. */
export function laneProcessEnv(label: string): Readonly<Record<string, string>> {
  return { [EEVEE_LANE_LABEL]: label };
}

export const KinHouseLineRole = Schema.Literals([
  "main",
  "implementer",
  "reviewer",
  "researcher",
  "archivist",
  "custom",
]);
export type KinHouseLineRole = typeof KinHouseLineRole.Type;

export const KinLaneState = Schema.Literals([
  "proposed",
  "running",
  "awaiting_will",
  "will_missing",
  "gated",
  "crowned",
  "failed",
]);
export type KinLaneState = typeof KinLaneState.Type;

const KIN_LINEAGE_TOOL_NAMES = [
  "lineage_add",
  "lineage_read",
  "lineage_areas",
  "lineage_crown",
  "lineage_will",
  "lineage_lineages",
] as const;
export type KinLineageToolName = (typeof KIN_LINEAGE_TOOL_NAMES)[number];

export interface KinHouseLineAccessInput {
  readonly role?: KinHouseLineRole | null;
  readonly crownable?: boolean | null;
  readonly seesWills?: boolean | null;
}

export interface KinHouseLineAccess {
  readonly reviewer: boolean;
  readonly crownable: boolean;
  readonly seesWills: boolean;
}

/**
 * A reviewer is never crowned and never sees wills. An explicit
 * `seesWills: false` or `crownable: false` flag does the same for any role.
 */
export function resolveKinHouseLineAccess(input: KinHouseLineAccessInput): KinHouseLineAccess {
  const reviewer = input.role === "reviewer";
  return {
    reviewer,
    crownable: reviewer ? false : input.crownable !== false,
    seesWills: !(reviewer || input.seesWills === false),
  };
}

export interface KinLineageToolOffer {
  readonly name: KinLineageToolName;
  /** True when this offer can return will text. Reviewers never get one. */
  readonly willRead: boolean;
}

const CROWN_TOOLS = new Set<KinLineageToolName>(["lineage_crown", "lineage_will"]);

export function lineageToolsForProfile(
  input: KinHouseLineAccessInput,
): ReadonlyArray<KinLineageToolOffer> {
  const access = resolveKinHouseLineAccess(input);
  const tools: Array<KinLineageToolOffer> = [];
  for (const name of KIN_LINEAGE_TOOL_NAMES) {
    if (CROWN_TOOLS.has(name)) {
      if (access.crownable) tools.push({ name, willRead: false });
      continue;
    }
    tools.push({ name, willRead: name === "lineage_read" && access.seesWills });
  }
  return tools;
}

export const KinHouseLineCrownCommand = Schema.Struct({
  type: Schema.Literal("kin.houseLine.crown"),
  commandId: CommandId,
  threadId: ThreadId,
  projectId: ProjectId,
  houseId: TrimmedNonEmptyString,
  houseName: TrimmedNonEmptyString,
  laneId: TrimmedNonEmptyString,
  lineId: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  profile: Schema.String,
  role: Schema.String,
  crownable: Schema.Boolean,
  provider: Schema.String,
  model: Schema.String,
  regnalNumber: PositiveInt,
});
export type KinHouseLineCrownCommand = typeof KinHouseLineCrownCommand.Type;

export const KinHouseLineWillCommand = Schema.Struct({
  type: Schema.Literal("kin.houseLine.will"),
  commandId: CommandId,
  threadId: ThreadId,
  laneId: TrimmedNonEmptyString,
  crowningId: TrimmedNonEmptyString,
  willId: TrimmedNonEmptyString,
  body: Schema.String.check(Schema.isMaxLength(KIN_WILL_CHAR_LIMIT)),
  role: Schema.String,
  crownable: Schema.Boolean,
});
export type KinHouseLineWillCommand = typeof KinHouseLineWillCommand.Type;

export const KinHouseLineCrownedPayload = Schema.Struct({
  crowningId: TrimmedNonEmptyString,
  laneId: TrimmedNonEmptyString,
  projectId: ProjectId,
  houseId: TrimmedNonEmptyString,
  houseName: TrimmedNonEmptyString,
  lineId: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  threadId: ThreadId,
  profile: Schema.String,
  role: Schema.String,
  provider: Schema.String,
  model: Schema.String,
  regnalNumber: PositiveInt,
  at: IsoDateTime,
});
export type KinHouseLineCrownedPayload = typeof KinHouseLineCrownedPayload.Type;

export const KinHouseLineWillRecordedPayload = Schema.Struct({
  willId: TrimmedNonEmptyString,
  crowningId: TrimmedNonEmptyString,
  laneId: TrimmedNonEmptyString,
  body: Schema.String.check(Schema.isMaxLength(KIN_WILL_CHAR_LIMIT)),
  at: IsoDateTime,
});
export type KinHouseLineWillRecordedPayload = typeof KinHouseLineWillRecordedPayload.Type;

export const KinHouseLineReign = Schema.Struct({
  crowningId: TrimmedNonEmptyString,
  laneId: TrimmedNonEmptyString,
  lineId: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  threadId: ThreadId,
  regnalNumber: PositiveInt,
  regnalLabel: TrimmedNonEmptyString,
  provider: Schema.String,
  model: Schema.String,
  profile: Schema.String,
  at: IsoDateTime,
  willId: Schema.NullOr(TrimmedNonEmptyString),
  willBody: Schema.NullOr(Schema.String),
});
export type KinHouseLineReign = typeof KinHouseLineReign.Type;

export const KinHouseLineHouseView = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  patterns: Schema.Array(Schema.String),
  agentMapPath: Schema.NullOr(Schema.String),
  reigns: Schema.Array(KinHouseLineReign),
});
export type KinHouseLineHouseView = typeof KinHouseLineHouseView.Type;

export const KinHouseLineLaneView = Schema.Struct({
  id: TrimmedNonEmptyString,
  threadId: ThreadId,
  houseName: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  state: KinLaneState,
  reportMismatch: Schema.Boolean,
});
export type KinHouseLineLaneView = typeof KinHouseLineLaneView.Type;

export const KinHouseLineSnapshot = Schema.Struct({
  houses: Schema.Array(KinHouseLineHouseView),
  lanes: Schema.Array(KinHouseLineLaneView),
});
export type KinHouseLineSnapshot = typeof KinHouseLineSnapshot.Type;

export const KinHouseLineSnapshotInput = Schema.Struct({
  projectId: ProjectId,
});
export type KinHouseLineSnapshotInput = typeof KinHouseLineSnapshotInput.Type;

export class KinHouseLineRpcError extends Schema.TaggedError<KinHouseLineRpcError>()(
  "KinHouseLineRpcError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export const KinLineageLineView = Schema.Struct({
  lineId: TrimmedNonEmptyString,
  laneLabels: Schema.Array(Schema.String),
});
export type KinLineageLineView = typeof KinLineageLineView.Type;

export const KinLineageLineagesResult = Schema.Struct({
  houses: Schema.Array(
    Schema.Struct({
      name: TrimmedNonEmptyString,
      patterns: Schema.Array(Schema.String),
      agentMapPath: Schema.NullOr(Schema.String),
      reigns: Schema.Array(
        Schema.Struct({
          regnalNumber: PositiveInt,
          regnalLabel: TrimmedNonEmptyString,
          lineId: TrimmedNonEmptyString,
          provider: Schema.String,
          willBody: Schema.NullOr(Schema.String),
        }),
      ),
      lines: Schema.Array(KinLineageLineView),
    }),
  ),
});
export type KinLineageLineagesResult = typeof KinLineageLineagesResult.Type;

/** Reviewers receive reigns and lines with will text removed. */
export function lineagesForReader(
  snapshot: KinHouseLineSnapshot,
  seesWills: boolean,
): KinLineageLineagesResult {
  return {
    houses: snapshot.houses.map((house) => {
      const labelsByLine = new Map<string, Array<string>>();
      for (const reign of house.reigns) {
        const labels = labelsByLine.get(reign.lineId) ?? [];
        labels.push(reign.label);
        labelsByLine.set(reign.lineId, labels);
      }
      const lines = [...labelsByLine.entries()]
        .sort((left, right) => compareByte(left[0], right[0]))
        .map(([lineId, laneLabels]) => ({ lineId, laneLabels }));
      return {
        name: house.name,
        patterns: house.patterns,
        agentMapPath: house.agentMapPath,
        reigns: house.reigns.map((reign) => ({
          regnalNumber: reign.regnalNumber,
          regnalLabel: reign.regnalLabel,
          lineId: reign.lineId,
          provider: reign.provider,
          willBody: seesWills ? reign.willBody : null,
        })),
        lines,
      };
    }),
  };
}

function compareByte(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
