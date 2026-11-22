// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import { assert, it } from "@effect/vitest";

import { kinMockProblems } from "./kin-checks.ts";
import { buildBase, normalizeToolName } from "./run.ts";

const known = new Set(["delegate_task"]);
const lead = { name: "Finance", domain: "finance", charter: "Keeps the books.", you: true };
const refusal = { _tag: "KinChatError", reason: "not_allowed", message: "Nothing was sent." };

it.each([
  ["a real answer", { kin_leads: { leads: [lead] } }, []],
  [
    "a missing required field",
    { kin_leads: { leads: [{ name: "Finance" }] } },
    ['kin_leads is not an answer kin_leads gives: Missing key at ["leads"][0]["you"]'],
  ],
  [
    "a key the tool never writes",
    { kin_relay: { relayed: true } },
    ['kin_relay is not an answer kin_relay gives: Expected no excess property at ["relayed"]'],
  ],
  ["a declared failure", { kin_relay: { $error: refusal } }, []],
  [
    "a failure as plain text",
    { kin_relay: { $error: "Nothing was sent." } },
    [
      'kin_relay.$error is not an answer kin_relay gives: Expected { readonly "_tag": "KinChatError", ... } | { readonly "_tag": "OrchestratorMcpFailure", ... }',
    ],
  ],
  [
    "a sequence with one bad answer",
    { kin_leads: { $sequence: [{ leads: [lead] }, { leads: [] }, { staged: true }] } },
    [
      'kin_leads.$sequence[2] is not an answer kin_leads gives: Expected no excess property at ["staged"]',
    ],
  ],
  [
    "a rule's answer and its else",
    { kin_leads: { $when: [{ args: {}, result: { leads: [lead] } }], $else: { leads: 1 } } },
    ['kin_leads.$else is not an answer kin_leads gives: Expected array at ["leads"]'],
  ],
  ["a field echoed from the call", { memory_write: { itemId: "{{ARG:id}}" } }, []],
  [
    "a placeholder nothing fills",
    { memory_write: { itemId: "{{ITEM_ID}}" } },
    ["memory_write has a placeholder Kin's code doesn't fill: {{ITEM_ID}}"],
  ],
  [
    "the default answer",
    { kin_journal: "default" },
    ['kin_journal is "default", answered {"ok":true}, which kin_journal never returns'],
  ],
  ["a tool of the turn's catalog", { delegate_task: { taskId: "task-1" } }, []],
  [
    "a tool nothing has",
    { kin_github_prs: { prs: [] } },
    ["mocks kin_github_prs, which no Kin toolkit or catalog has"],
  ],
] as const)("%s", (_, mocks, expected) => {
  assert.deepStrictEqual(kinMockProblems(mocks, known), [...expected]);
});

// Every Kin case, so a changed case or a changed Kin tool fails here as `kin:dry` would.
const capture = JSON.parse(
  NodeZlib.gunzipSync(
    NodeFS.readFileSync(new URL("./templates/claude.json.gz", import.meta.url)),
  ).toString(),
).request.provider_native;
const base = buildBase(capture, {
  model: "claude-opus-5-5",
  keepUserInstructions: false,
  kinAgent: true,
  kinLead: true,
});
const catalog = new Set(
  [...base.nativeTools, ...base.deferred].map((tool) => normalizeToolName(tool.name)),
);
const CASES = NodePath.join(import.meta.dirname, "cases");
const kinCases = NodeFS.readdirSync(CASES)
  .filter((name) => name.startsWith("kin") && name.endsWith(".ndjson"))
  .flatMap((name) =>
    NodeFS.readFileSync(NodePath.join(CASES, name), "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map(
        (line) =>
          JSON.parse(line) as {
            id: string;
            setup: { mocks?: Record<string, unknown>; world?: never };
          },
      ),
  );

it("finds every Kin case's mocks answering as Kin's tools do", () => {
  assert.isAbove(kinCases.length, 400);
  const problems = kinCases.flatMap(({ id, setup }) =>
    kinMockProblems(setup.mocks, catalog, setup.world).map((problem) => `${id}: ${problem}`),
  );
  assert.deepStrictEqual(problems, []);
});
