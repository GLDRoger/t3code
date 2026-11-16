import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import { Tool } from "effect/ai";

import { KinApprovalsToolkit } from "../approvals/mcp.ts";
import { KinConnectionsToolkit } from "../connections/mcp.ts";
import { KinDocumentToolkit } from "../gendocs/mcp.ts";
import { KinChatToolkit } from "../mcp/KinChatToolkit.ts";
import { KinPulseToolkit } from "../pulse/mcp.ts";
import { KinDocsToolkit } from "../work/mcp/docTools.ts";
import { KinStatementToolkit } from "../work/mcp/statementTools.ts";
import { KinWorkToolkit } from "../work/mcp/tools.ts";
import { KIN_DEFERRED_TOOLS } from "./deferredTools.ts";
import { KinLeadToolkit } from "./mcp/tools.ts";

const kinTools = [
  KinChatToolkit,
  KinApprovalsToolkit,
  KinLeadToolkit,
  KinWorkToolkit,
  KinStatementToolkit,
  KinDocsToolkit,
  KinDocumentToolkit,
  KinConnectionsToolkit,
  KinPulseToolkit,
].flatMap((toolkit) => Object.values(toolkit.tools) as Array<Tool.Any>);

it("a Kin tool waits for ToolSearch exactly when it is named deferred", () => {
  const marked = kinTools
    .filter((tool) => Context.getOrUndefined(tool.annotations, Tool.Meta)?.["anthropic/alwaysLoad"] === false)
    .map((tool) => tool.name);
  assert.sameMembers(
    marked,
    kinTools.map((tool) => tool.name).filter((name) => KIN_DEFERRED_TOOLS.has(name)),
  );
  // The reply path never waits on a search.
  for (const name of ["kin_chat_post", "kin_ask", "kin_react", "kin_relay", "records_query"])
    assert.notInclude(marked, name);
});
