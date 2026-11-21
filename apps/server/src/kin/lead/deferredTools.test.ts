import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import { Tool } from "effect/ai";

import { advertisedJsonSchema } from "../../mcp/advertisedJsonSchema.ts";
import { KinConnectionsToolkit } from "../connections/mcp.ts";
import { KinDocumentToolkit } from "../gendocs/mcp.ts";
import { KinChatToolkit } from "../mcp/KinChatToolkit.ts";
import contextBudget from "../mcp/agentContextBudget.json" with { type: "json" };
import { KinPulseToolkit } from "../pulse/mcp.ts";
import { KinSalesToolkit } from "../sales/mcp.ts";
import { KinSocialToolkit } from "../social/mcp.ts";
import { KinDocsToolkit } from "../work/mcp/docTools.ts";
import { KinStatementToolkit } from "../work/mcp/statementTools.ts";
import { KinWorkToolkit } from "../work/mcp/tools.ts";
import { KIN_DEFERRED_TOOLS } from "./deferredTools.ts";
import { KinLeadToolkit } from "./mcp/tools.ts";

const kinTools = [
  KinChatToolkit,
  KinLeadToolkit,
  KinWorkToolkit,
  KinStatementToolkit,
  KinDocsToolkit,
  KinDocumentToolkit,
  KinConnectionsToolkit,
  KinPulseToolkit,
  KinSocialToolkit,
  KinSalesToolkit,
].flatMap((toolkit) => Object.values(toolkit.tools) as Array<Tool.Any>);

it("a Kin tool waits for ToolSearch exactly when it is named deferred", () => {
  const marked = kinTools
    .filter(
      (tool) =>
        Context.getOrUndefined(tool.annotations, Tool.Meta)?.["anthropic/alwaysLoad"] === false,
    )
    .map((tool) => tool.name);
  assert.sameMembers(
    marked,
    kinTools.map((tool) => tool.name).filter((name) => KIN_DEFERRED_TOOLS.has(name)),
  );
  // The reply path never waits on a search.
  for (const name of ["kin_chat_post", "kin_ask", "kin_react", "kin_relay", "records_query"])
    assert.notInclude(marked, name);
});

const utf8 = (text: string) => Buffer.byteLength(text, "utf8");

it("each Kin tool's description and input schema weigh what the budget pins", () => {
  const measured = Object.fromEntries(
    kinTools.map((tool) => [
      tool.name,
      {
        desc: utf8(Tool.getDescription(tool) ?? ""),
        schema: utf8(JSON.stringify(advertisedJsonSchema(tool))),
      },
    ]),
  );
  assert.deepStrictEqual(
    measured,
    contextBudget.kinLeadToolBytes,
    "Set agentContextBudget.json to the measured values. Before you cut text to fit, run the evals that cover it (evals/README.md).",
  );
});
