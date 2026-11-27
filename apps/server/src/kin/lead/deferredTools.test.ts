import { assert, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import { Tool, Toolkit } from "effect/ai";

import { advertisedJsonSchema } from "../../mcp/advertisedJsonSchema.ts";
import { KinConnectionsToolkit } from "../connections/mcp.ts";
import { KinDocumentToolkit } from "../gendocs/mcp.ts";
import { inputPropertyPaths } from "../mcp/inputPropertyPaths.testHelper.ts";
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
import { KIN_ALWAYS_LOADED, KIN_CLAUDE_ALWAYS_LOADED, withAlwaysLoaded } from "./deferredTools.ts";
import { KIN_SEARCH_HINTS } from "./searchHints.ts";
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
  assert.sameMembers(
    [...KIN_ALWAYS_LOADED],
    ["record_update", "record_assign", "kin_ask_person", "kin_relay", "kin_defer", "records_query"],
  );
  assert.includeMembers(
    kinTools.map((tool) => tool.name),
    [...KIN_CLAUDE_ALWAYS_LOADED],
  );
  const marked = Object.values(withAlwaysLoaded(KinLeadToolkit).tools)
    .filter((tool) => alwaysLoads(tool) === true)
    .map((tool) => tool.name);
  assert.sameMembers(
    marked,
    Object.keys(KinLeadToolkit.tools).filter((name) => KIN_CLAUDE_ALWAYS_LOADED.has(name)),
  );
});

const utf8 = (text: string) => Buffer.byteLength(text, "utf8");

it("each Kin tool's description and input schema weigh what the budget pins", () => {
  const measured = Object.fromEntries(
    kinTools.map((tool) => [
      tool.name,
      {
        desc: utf8(Tool.getDescription(tool) ?? ""),
        schema: utf8(JSON.stringify(advertisedJsonSchema(tool, { kin: true }))),
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

it("advertises every accepted chart key at every level", () => {
  const tool = KinLeadToolkit.tools.kin_chart;
  const advertised = advertisedJsonSchema(tool, { kin: true });
  assert.deepStrictEqual(
    inputPropertyPaths(advertised),
    inputPropertyPaths(Tool.getJsonSchema(tool)),
  );
});

it("advertises every memory write key except the filled-in source event, with a single operation enum", () => {
  const tool = KinLeadToolkit.tools.memory_write;
  const advertised = advertisedJsonSchema(tool, { kin: true });
  assert.deepStrictEqual(
    inputPropertyPaths(advertised),
    inputPropertyPaths(Tool.getJsonSchema(tool)).difference(new Set(["sourceEventId"])),
  );
  expect(advertised.properties).toHaveProperty("item.properties.sender_mail_voice.description");
  expect(advertised.properties).toHaveProperty("op", {
    type: "string",
    enum: ["create", "update", "supersede", "invalidate"],
  });
});

it("adds eight everyday tools to Claude's owner core without moving the Codex partition", () => {
  const actual = Object.values(withAlwaysLoaded(Toolkit.make(...kinTools)).tools)
    .filter((tool) => alwaysLoads(tool) === true)
    .map((tool) => tool.name);
  assert.sameMembers(actual, [
    ...KIN_ALWAYS_LOADED,
    "record_get",
    "docs_search",
    "client_read",
    "doc_create",
    "record_create",
    "kin_ask",
    "kin_send",
    "kin_skip",
  ]);
});

it("puts search hints in MCP metadata only for deferred tools that have one", () => {
  const { kin_picture } = KinPictureToolkit.tools;
  const { kin_defer, kin_schedule } = KinLeadToolkit.tools;
  const { tools } = withAlwaysLoaded(Toolkit.make(kin_picture, kin_defer, kin_schedule), {
    kin_picture: "picture hint",
    kin_defer: "always loaded",
  });
  const metadata = (tool: Tool.Any) => Context.getOrUndefined(tool.annotations, Tool.Meta);
  assert.deepInclude(metadata(tools.kin_picture), { "anthropic/searchHint": "picture hint" });
  assert.notProperty(metadata(tools.kin_schedule) ?? {}, "anthropic/searchHint");
  assert.deepEqual(metadata(tools.kin_defer), { "anthropic/alwaysLoad": true });
});

it("every deferred Kin tool has a hint, no always-loaded tool has one, no hint repeats a part of its tool's name", () => {
  const names = kinTools.map((tool) => tool.name);
  assert.sameMembers(
    Object.keys(KIN_SEARCH_HINTS),
    names.filter((name) => !KIN_CLAUDE_ALWAYS_LOADED.has(name)),
  );
  // Tool search already scores a tool's name parts; a hint word that shares one adds nothing.
  const sharesName = (word: string, part: string) =>
    word === part ||
    (word.length >= 4 && part.length >= 4 && (word.startsWith(part) || part.startsWith(word)));
  const misses = Object.entries(KIN_SEARCH_HINTS).flatMap(([name, hint]) => {
    const words = hint.split(" ");
    const repeats = words.filter((word) => name.split("_").some((part) => sharesName(word, part)));
    return words.length < 3 || words.length > 8 || repeats.length > 0 ? [`${name}: ${hint}`] : [];
  });
  assert.deepStrictEqual(misses, []);
});
