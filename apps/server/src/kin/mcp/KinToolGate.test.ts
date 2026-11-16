import { assert, it } from "@effect/vitest";
import * as Predicate from "effect/Predicate";

import * as Kin from "../layer.ts";
import { KinApprovalsToolkit } from "../approvals/mcp.ts";
import { KinDocumentToolkit } from "../gendocs/mcp.ts";
import { TURN_EVENT_TOOLS } from "../lead/eventIds.ts";
import { KinLeadToolkit } from "../lead/mcp/tools.ts";
import { KinPulseToolkit } from "../pulse/mcp.ts";
import { KinDocsToolkit } from "../work/mcp/docTools.ts";
import { KinStatementToolkit } from "../work/mcp/statementTools.ts";
import { KinWorkToolkit } from "../work/mcp/tools.ts";

it("fills the event of every Kin tool that takes one, and of no other", () => {
  const takes = [
    KinLeadToolkit,
    KinWorkToolkit,
    KinDocsToolkit,
    KinStatementToolkit,
    KinDocumentToolkit,
    KinApprovalsToolkit,
    KinPulseToolkit,
  ].flatMap((toolkit) =>
    Object.values(toolkit.tools).flatMap((tool) =>
      Predicate.hasProperty(tool.parametersSchema, "fields") &&
      Predicate.hasProperty(tool.parametersSchema.fields, "sourceEventId")
        ? [tool.name]
        : [],
    ),
  );
  assert.isDefined(Kin.layer);
  assert.deepStrictEqual([...TURN_EVENT_TOOLS].toSorted(), takes.toSorted());
});
