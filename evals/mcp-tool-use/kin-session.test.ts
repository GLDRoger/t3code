// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  CARRIED_TURN_NOTE,
  PROMPT_HEADINGS,
  TURN_DIVIDER,
} from "../../apps/server/src/kin/lead/LeadPrompt.ts";
import { fillKinRules, kinLegacyHeaderPlace, kinSessionSplit } from "./kin.ts";
import { buildBase, buildMessages, makeSample, McpToolUseCase } from "./run.ts";
import { expectationsForLayout, kinSessionWireMessages } from "./kin-session-wire.ts";

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

const legacyRequestPin = "a2a3a14a41190e4fbd2aa28462edab171c3cb34e03d8a72525fce21a23605ebc";
const sessionRequestPin = "bcefa2ae1f16e2282ead53f8fe906430cc0c8a348a885b06f9460cff255ba4b1";
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

const dryRequests = (layout: "legacy" | "session", file: string, ids?: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync(
    process.execPath,
    [
      "mcp-tool-use/run.ts",
      "--dry-run",
      "--no-step-limit",
      "--kin-layout",
      layout,
      "--cases",
      `mcp-tool-use/cases/${file}`,
      ...(ids === undefined ? [] : ["--case", ids.join(",")]),
    ],
    { cwd: new URL("..", import.meta.url), maxBuffer: 8 * 1024 * 1024 },
  );

const digest = (requests: Uint8Array) =>
  NodeCrypto.createHash("sha256").update(requests).digest("hex");

it("pins ten uncarried requests and keeps both layouts byte-identical", () => {
  const legacy = dryRequests("legacy", "kin.ndjson", pinnedIds);
  const session = dryRequests("session", "kin.ndjson", pinnedIds);
  assert.lengthOf(legacy.toString().trimEnd().split("\n"), 10);
  assert.equal(digest(legacy), legacyRequestPin);
  assert.isTrue(session.equals(legacy), "Session layout changed an uncarried request.");
});

it("pins the session requests of both carry seeds", () => {
  const requests = dryRequests("session", "kin-carry.ndjson", [
    "kin-carry-follow-up-question",
    "kin-carry-nothing-changed-no-reread",
  ]);
  assert.lengthOf(requests.toString().trimEnd().split("\n"), 2);
  assert.equal(digest(requests), sessionRequestPin);
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
const txt = (text: string) => ({ type: "text", text });
const deferred = txt("The deferred tools list.");
const date = txt("Today's date is 2026-11-26.");
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
  reminders: [deferred, date],
});
const context = (value: string) => txt(`UserPromptSubmit hook additional context: ${value}`);
const rendered = (layout: "legacy" | "session", testCase = carryCase) =>
  buildMessages(makeSample(testCase, caseBase()), layout);

it("replays only the last wake in legacy and the real earlier tool blocks in session", () => {
  assert.deepEqual(rendered("legacy"), [
    { role: "user", content: [deferred, date, txt(carryCase.prompt)] },
  ]);
  const unchanged = context(`${CARRIED_TURN_NOTE}\n\n${header}`);
  assert.deepEqual(rendered("session"), [
    { role: "user", content: [deferred, txt(earlier[0]!.prompt)] },
    { role: "system", content: [date] },
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

const summary = "Rhea asked about invoices before compaction.";
const summaryBlock = txt(
  `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n${summary}`,
);
const compactAt = (compactedBefore: number) => ({
  ...carryCase,
  setup: {
    ...carryCase.setup,
    carry: { earlier, compactedBefore, summary },
  },
});

it("starts again with a full wake after compaction and carries from that wake", () => {
  assert.deepEqual(rendered("session", compactAt(1)), [
    { role: "user", content: [summaryBlock] },
    { role: "user", content: [deferred, txt(earlier[1]!.prompt)] },
    { role: "system", content: [date] },
    { role: "assistant", content: [txt("Yes, it includes INV-7.")] },
    { role: "user", content: [txt("# Events\n\nAnd INV-9?")] },
    { role: "system", content: [context(`${CARRIED_TURN_NOTE}\n\n${header}`)] },
  ]);
  assert.deepEqual(rendered("session", compactAt(2)), [
    { role: "user", content: [summaryBlock] },
    { role: "user", content: [deferred, txt(carryCase.prompt)] },
    { role: "system", content: [date] },
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

it("keeps a 9,000-character change list in the hook and appends a longer list after events", () => {
  const prefix = `${CARRIED_TURN_NOTE}\n\n${header}\n\n${PROMPT_HEADINGS.work}\n\n`;
  const event = "And INV-9?";
  const view = (size: number) => {
    const work = "A".repeat(size - prefix.length);
    const prompt = wake(event).replace(
      "# Events",
      `${PROMPT_HEADINGS.work}\n\n${work}\n\n# Events`,
    );
    const messages = rendered("session", { ...carryCase, prompt });
    return {
      changes: prefix + work,
      tail: messages.slice(
        messages.findIndex((message) =>
          message.content.some((block) => block.text === "Yes, it includes INV-7."),
        ) + 1,
      ),
    };
  };

  const ceiling = view(9_000);
  assert.deepEqual(ceiling.tail, [
    { role: "user", content: [txt(`# Events\n\n${event}`)] },
    { role: "system", content: [context(ceiling.changes)] },
  ]);
  const overflow = view(9_001);
  const appended = txt(`# Events\n\n${event}\n\n${overflow.changes}`);
  assert.deepEqual(overflow.tail, [{ role: "user", content: [appended] }]);
  assert.deepEqual(kinSessionWireMessages(overflow.tail), [
    {
      role: "user",
      content: [{ ...appended, cache_control: { type: "ephemeral", ttl: "1h" } }],
    },
  ]);
});
