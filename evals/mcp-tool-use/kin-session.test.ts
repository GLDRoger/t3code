// @effect-diagnostics nodeBuiltinImport:off
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as NodeFS from "node:fs";
import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { CARRIED_TURN_NOTE, TURN_DIVIDER } from "../../apps/server/src/kin/lead/LeadPrompt.ts";
import { fillKinRules, kinLegacyHeaderPlace, kinSessionSplit } from "./kin.ts";
import { buildBase, buildMessages, makeSample, McpToolUseCase } from "./run.ts";
import { expectationsForLayout } from "./kin-session-wire.ts";

const decodeCase = Schema.decodeUnknownSync(Schema.fromJsonString(McpToolUseCase));
const readCases = (name: string) =>
  NodeFS.readFileSync(new URL(`./cases/${name}`, import.meta.url), "utf8")
    .trim()
    .split("\n")
    .map((line) => decodeCase(line));

const headerLines = (block: string) => {
  const lines = block.split("\n");
  return lines.every((line) => kinLegacyHeaderPlace(line) !== undefined) ? lines : [block];
};

it("places every legacy wake-up block exactly once, splitting the server's tagged header lines", () => {
  const failures: string[] = [];
  for (const name of NodeFS.readdirSync(new URL("./cases/", import.meta.url))) {
    if (!/^kin.*\.ndjson$/.test(name)) continue;
    for (const testCase of readCases(name)) {
      if (!testCase.prompt.includes(TURN_DIVIDER)) continue;
      const prompt = fillKinRules(testCase.prompt, testCase.setup.world);
      try {
        const { standing, delta, message } = kinSessionSplit(prompt);
        const blocks = [standing, delta, message]
          .filter(Boolean)
          .flatMap((text) => text.split("\n\n").flatMap(headerLines))
          .toSorted();
        const expected = prompt
          .split("\n\n")
          .filter((block) => block !== TURN_DIVIDER)
          .flatMap(headerLines)
          .toSorted();
        assert.deepEqual(blocks, expected);
      } catch (error) {
        failures.push(`${testCase.id}: ${String(error)}`);
      }
    }
  }
  assert.deepEqual(failures, []);
});

// Captured from mine/kin at 41f8a4f4705 before adding the layout flag.
const legacyRequestPin = "2fc2cb5b182755fd7a3896a5a2dbfb4460815d16381e7aeee81d9d0be4d7a93a";
const sessionRequestPin = "0fcf900fd03fb151570f3052253b68a12538eca95e8201d00c95b5ad0c154afc";
const pinnedIds = [
  "kin-lead-rereads-github-hint",
  "kin-lead-uses-display-name",
  "kin-lead-no-second-answer-after-end",
  "kin-lead-hi-gets-one-line",
  "kin-lead-capabilities-in-plain-words",
  "kin-lead-refused-work-is-not-a-setup-request",
  "kin-lead-notice-own-activity-is-silent",
  "kin-lead-notice-failing-check-reaches-owner",
  "kin-lead-reminder-is-only-its-subject",
  "kin-lead-get-back-does-the-check",
];

it.each([
  ["legacy", legacyRequestPin],
  ["session", sessionRequestPin],
] as const)("pins ten Kin dry-run requests in the %s layout", (layout, pin) => {
  const requests = execFileSync(
    process.execPath,
    [
      "mcp-tool-use/run.ts",
      "--dry-run",
      "--no-step-limit",
      "--kin-layout",
      layout,
      "--cases",
      "mcp-tool-use/cases/kin.ndjson",
      "--case",
      pinnedIds.join(","),
    ],
    { cwd: new URL("..", import.meta.url), maxBuffer: 8 * 1024 * 1024 },
  );
  assert.lengthOf(requests.toString().trimEnd().split("\n"), 10);
  assert.equal(createHash("sha256").update(requests).digest("hex"), pin);
});

const header = 'Your reply goes to chat "direct-1", your direct chat with the owner.';
const standing = "# Standing rules\n\nInvented rule: the dispatch log stays inside Tidewater.";
const wake = (event: string) =>
  `${standing}\n\n${TURN_DIVIDER}\n\nAgent name: "Finance"\n${header}\n\n# Events\n\n${event}`;
const earlier = [
  {
    prompt: wake("Which invoices are open?"),
    toolCalls: [{ tool: "records_query", input: { list: "invoices" }, result: { total: 2 } }],
    reply: "Two are open.",
  },
  { prompt: wake("Does that include INV-7?"), reply: "Yes, it includes INV-7." },
];
const carryCase: McpToolUseCase = {
  id: "carry-render",
  area: "kin",
  kind: "control",
  pattern: "render a carried turn",
  experience: "Reply to a follow-up with the prior facts.",
  setup: { role: "top", world: { kinLead: true }, carry: { earlier } },
  prompt: wake("And INV-9?"),
  expect: {},
  sessionCallsMustNot: [{ tool: "records_query" }],
};
const caseBase = () => ({
  ...buildBase(
    {
      system: [
        {
          type: "text",
          text: "<runtime_info>Fixture</runtime_info>\nThe following deferred tools are now available via ToolSearch. Load them first:\nMonitor\n",
        },
      ],
      messages: [],
      tools: [],
    },
    {
      model: "claude-sonnet-5-5",
      kinAgent: true,
      kinLead: true,
      kinSession: true,
      keepUserInstructions: false,
    },
  ),
  reminders: [],
});
const txt = (text: string) => ({ type: "text", text });
const context = (value: string) => txt(`UserPromptSubmit hook additional context: ${value}`);
const rendered = (layout: "legacy" | "session", testCase = carryCase) =>
  buildMessages(makeSample(testCase, caseBase()), layout);

it("replays only the last wake in legacy and the real earlier tool blocks in session", () => {
  assert.deepEqual(rendered("legacy"), [{ role: "user", content: [txt(carryCase.prompt)] }]);
  const unchanged = context(`${CARRIED_TURN_NOTE}\n\n${header}`);
  assert.deepEqual(rendered("session"), [
    {
      role: "user",
      content: [
        txt(
          `<system-reminder>\nSessionStart hook additional context: ${standing}\n\nAgent name: "Finance"\n</system-reminder>`,
        ),
        txt("# Events\n\nWhich invoices are open?"),
      ],
    },
    { role: "system", content: [context(header)] },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_prior_0",
          name: "mcp__t3-code__records_query",
          input: { list: "invoices" },
        },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_prior_0", content: '{"total":2}' }],
    },
    { role: "assistant", content: [txt("Two are open.")] },
    { role: "user", content: [txt("# Events\n\nDoes that include INV-7?")] },
    { role: "system", content: [unchanged] },
    { role: "assistant", content: [txt("Yes, it includes INV-7.")] },
    { role: "user", content: [txt("# Events\n\nAnd INV-9?")] },
    { role: "system", content: [unchanged] },
  ]);
  assert.deepEqual(expectationsForLayout(carryCase, "tools", "legacy"), {});
  assert.deepEqual(expectationsForLayout(carryCase, "tools", "session"), {
    callsMustNot: [{ tool: "records_query" }],
  });
});

it("replaces the compacted prefix with the provider summary and compact-time standing", () => {
  const compacted = {
    ...carryCase,
    setup: {
      ...carryCase.setup,
      carry: {
        earlier,
        compactedBefore: 2,
        summary: "Rhea asked about invoices before compaction.",
      },
    },
  };
  assert.deepEqual(rendered("session", compacted), [
    {
      role: "user",
      content: [
        txt(
          "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nRhea asked about invoices before compaction.",
        ),
      ],
    },
    { role: "user", content: [txt("# Events\n\nAnd INV-9?")] },
    {
      role: "system",
      content: [
        txt(
          `SessionStart hook additional context: ${standing}\n\nAgent name: "Finance"\n\nUserPromptSubmit hook additional context: ${CARRIED_TURN_NOTE}\n\n${header}`,
        ),
      ],
    },
  ]);
  assert.throws(
    () =>
      rendered("session", {
        ...carryCase,
        setup: { ...carryCase.setup, priorTurns: [] },
      }),
    "setup.carry and setup.priorTurns are mutually exclusive",
  );
});
