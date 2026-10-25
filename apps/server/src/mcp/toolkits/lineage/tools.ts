/**
 * Agent-facing names stay `lineage_*` (DESIGN 5.2). The service behind them is
 * `kin.houseLine`, so it does not collide with upstream's subagent lineage fixture.
 */

import {
  KinHouseLineHouseView,
  KinLineageLineagesResult,
  OrchestratorMcpFailure,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";

import * as HouseLineService from "../../../kin/houseLine/HouseLineService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  HouseLineService.HouseLineService,
];

const failure = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies,
};

const Note = Schema.Struct({
  id: Schema.String,
  body: Schema.String,
  at: Schema.String,
  authorLaneId: Schema.NullOr(Schema.String),
});

const Will = Schema.Struct({
  id: Schema.String,
  body: Schema.String,
  regnalLabel: Schema.String,
  at: Schema.String,
});

const LineageAddTool = Tool.make("lineage_add", {
  ...failure,
  description: "Add a note to the house board. Omit houses to tag the calling lane's house.",
  parameters: Schema.Struct({
    body: TrimmedNonEmptyString,
    houses: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  }),
  success: Schema.Struct({ noteId: Schema.String }),
}).annotate(Tool.Destructive, true);

const LineageReadTool = Tool.make("lineage_read", {
  ...failure,
  description:
    "Read the notes board. subject wills or all also returns wills, and reviewers are refused those.",
  parameters: Schema.Struct({
    subject: Schema.optional(Schema.Literals(["notes", "wills", "all"])),
    house: Schema.optional(TrimmedNonEmptyString),
    since: Schema.optional(Schema.String),
    authorLaneId: Schema.optional(Schema.String),
  }),
  success: Schema.Struct({
    notes: Schema.Array(Note),
    wills: Schema.Array(Will),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const LineageAreasTool = Tool.make("lineage_areas", {
  ...failure,
  description: "List houses and the lane-name patterns that map into them.",
  success: Schema.Struct({ houses: Schema.Array(KinHouseLineHouseView) }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const LineageCrownTool = Tool.make("lineage_crown", {
  ...failure,
  description: "Crown this lane in its house and return the next regnal number.",
  success: Schema.Struct({
    houseName: Schema.String,
    regnalNumber: Schema.Number,
    regnalLabel: Schema.String,
    crowningId: Schema.String,
  }),
}).annotate(Tool.Destructive, true);

const LineageWillTool = Tool.make("lineage_will", {
  ...failure,
  description: "Leave a will of at most 2500 characters for the next lane in this line.",
  parameters: Schema.Struct({ body: Schema.String }),
  success: Schema.Struct({ willId: Schema.String, crowningId: Schema.String }),
}).annotate(Tool.Destructive, true);

const LineageLineagesTool = Tool.make("lineage_lineages", {
  ...failure,
  description: "Show houses, reigns, and lines. Reviewers receive reigns with will text removed.",
  success: KinLineageLineagesResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const LineageToolkit = Toolkit.make(
  LineageAddTool,
  LineageReadTool,
  LineageAreasTool,
  LineageCrownTool,
  LineageWillTool,
  LineageLineagesTool,
);
