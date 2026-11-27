import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import { Tool } from "effect/ai";

import { advertisedJsonSchema } from "../../mcp/advertisedJsonSchema.ts";
import { KinConnectionsToolkit } from "../connections/mcp.ts";
import { KinDocumentToolkit } from "../gendocs/mcp.ts";
import { KinChatToolkit } from "../mcp/KinChatToolkit.ts";
import { KinPictureToolkit } from "../pictures/mcp.ts";
import contextBudget from "../mcp/agentContextBudget.json" with { type: "json" };
import { KinPulseToolkit } from "../pulse/mcp.ts";
import { KinSalesToolkit } from "../sales/mcp.ts";
import { KinSocialToolkit } from "../social/mcp.ts";
import { KinBillToolkit } from "../work/mcp/billTools.ts";
import { KinDocsToolkit } from "../work/mcp/docTools.ts";
import { KinStatementToolkit } from "../work/mcp/statementTools.ts";
import { KinWorkToolkit } from "../work/mcp/tools.ts";
import { KIN_ALWAYS_LOADED, withAlwaysLoaded } from "./deferredTools.ts";
import { KinLeadToolkit } from "./mcp/tools.ts";

const kinTools = [
  KinChatToolkit,
  KinLeadToolkit,
  KinWorkToolkit,
  KinStatementToolkit,
  KinBillToolkit,
  KinDocsToolkit,
  KinDocumentToolkit,
  KinPictureToolkit,
  KinConnectionsToolkit,
  KinPulseToolkit,
  KinSocialToolkit,
  KinSalesToolkit,
].flatMap((toolkit) => Object.values(toolkit.tools) as Array<Tool.Any>);

const alwaysLoads = (tool: Tool.Any) =>
  Context.getOrUndefined(tool.annotations, Tool.Meta)?.["anthropic/alwaysLoad"];

it("one set decides which Kin tools load up front: no tool marks itself, and every name in it is a Kin tool", () => {
  assert.deepStrictEqual(
    kinTools.filter((tool) => alwaysLoads(tool) !== undefined).map((tool) => tool.name),
    [],
  );
  assert.includeMembers(
    kinTools.map((tool) => tool.name),
    [...KIN_ALWAYS_LOADED],
  );
  const marked = Object.values(withAlwaysLoaded(KinLeadToolkit).tools)
    .filter((tool) => alwaysLoads(tool) === true)
    .map((tool) => tool.name);
  assert.sameMembers(
    marked,
    Object.keys(KinLeadToolkit.tools).filter((name) => KIN_ALWAYS_LOADED.has(name)),
  );
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
    kinTools
      .filter((tool) =>
        `${Tool.getDescription(tool)}${JSON.stringify(advertisedJsonSchema(tool))}`.includes(
          "NO_REPLY",
        ),
      )
      .map((tool) => tool.name),
    [],
    "No tool tells an agent to write a marker word: kin_skip ends a turn quietly.",
  );
  assert.deepStrictEqual(
    kinTools
      .filter((tool) => {
        const description = Tool.getDescription(tool) ?? "";
        return /\b(?:your|in) plain text\b/i.test(description) && !description.includes("kin_send");
      })
      .map((tool) => tool.name),
    [],
    "Where a trigger started the turn only kin_send reaches anyone: no tool calls plain text the reply without it.",
  );
  assert.deepStrictEqual(
    measured,
    contextBudget.kinLeadToolBytes,
    "Set agentContextBudget.json to the measured values. Before you cut text to fit, run the evals that cover it (evals/README.md).",
  );
});
