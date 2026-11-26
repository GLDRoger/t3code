// @effect-diagnostics nodeBuiltinImport:off
import { ProviderInstanceId } from "@t3tools/contracts";
import { compileClaudeModelSelection } from "../../apps/server/src/claudeModelOptions.ts";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  CARRIED_TURN_NOTE,
  PROMPT_HEADINGS,
  renderSessionChanges,
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

const legacyRequestPin = "373f1f31760b9185984584e190b2d5c803b953912ff9670858c1c5f1e0ec3ccd";
const sessionRequestPin = "d3cc7aef867a0eb6aba1b4b53a43c3b11a33a7fd362c96c0f5c78e560849d926";
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

it.each(["legacy", "session"] as const)(
  "pins the same ten uncarried requests in %s layout",
  (layout) => {
    const requests = dryRequests(layout, "kin.ndjson", pinnedIds);
    assert.lengthOf(requests.toString().trimEnd().split("\n"), 10);
    assert.equal(digest(requests), legacyRequestPin);
  },
);

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
    toolCalls: [
      { tool: "record_comment", input: { key: "INV-7", text: "Checked" }, result: { ok: true } },
    ],
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
  sessionCallsMustNot: [{ tool: "record_comment" }],
};
const txt = (text: string) => ({ type: "text", text });
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
  deferredAnnouncement: "The deferred tools list.",
  environment: { cwd: "/home/user/app", platform: "linux", date: "2026-11-26" },
  reminders: [],
});
const harness = (withDate: boolean) => ({
  role: "system" as const,
  content: [
    txt(
      [
        "# Environment\nYou have been invoked in the following environment: \n - Primary working directory: /home/user/app\n - Platform: linux",
        "The deferred tools list.",
        "<total_tokens>15000000 tokens left</total_tokens>",
        ...(withDate ? [date.text] : []),
      ].join("\n\n"),
    ),
  ],
});
const context = (value: string) => txt(`UserPromptSubmit hook additional context: ${value}`);
const rendered = (layout: "legacy" | "session", testCase = carryCase) =>
  buildMessages(makeSample(testCase, caseBase()), layout);

it("replays only the last wake in legacy and the real earlier tool blocks in session", () => {
  assert.deepEqual(rendered("legacy"), [
    { role: "user", content: [txt(carryCase.prompt)] },
    harness(true),
  ]);
  const unchanged = context(`${CARRIED_TURN_NOTE}\n\n${header}`);
  assert.deepEqual(rendered("session"), [
    { role: "user", content: [txt(earlier[0]!.prompt)] },
    harness(true),
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_prior_1",
          name: "ToolSearch",
          input: { query: "select:mcp__t3-code__record_comment", max_results: 1 },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_prior_1",
          content: [{ type: "tool_reference", tool_name: "mcp__t3-code__record_comment" }],
        },
        txt("Tool loaded."),
      ],
    },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_prior_0",
          name: "mcp__t3-code__record_comment",
          input: { key: "INV-7", text: "Checked" },
        },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_prior_0", content: '{"ok":true}' }],
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
    callsMustNot: [{ tool: "record_comment" }],
  });
});

it("puts each carried change list after its header and never sends it in legacy", () => {
  const earlierChanges = renderSessionChanges(
    ['W-14 "Pickup" (Work): due → "Friday" by Arjun, 11:00'],
    [],
  );
  const changes = renderSessionChanges(
    ["INV-9 (Invoices): changed by Meera (co-owner), 12:30; a sensitive entry, not shown here"],
    [],
  );
  const testCase = {
    ...carryCase,
    setup: {
      ...carryCase.setup,
      carry: {
        earlier: [earlier[0]!, { ...earlier[1]!, changes: earlierChanges! }],
        changes: changes!,
      },
    },
  };
  const legacy = rendered("legacy", testCase);
  assert.deepEqual(legacy, rendered("legacy"));
  const session = rendered("session", testCase);
  assert.deepEqual(
    session.filter(({ role }) => role === "system"),
    [
      harness(true),
      {
        role: "system" as const,
        content: [context(`${CARRIED_TURN_NOTE}\n\n${header}\n\n${earlierChanges}`)],
      },
      { role: "system", content: [context(`${CARRIED_TURN_NOTE}\n\n${header}\n\n${changes}`)] },
    ],
  );
});

it("resends only genuinely new recent chat, not earlier events, replies or restamped lines", () => {
  const previous = '> agent "Dispatch" (untrusted) 09:55: "The yard opens at six."';
  const next = '> owner "Rhea" Thu 26 Nov 10:20: "The gate code changed."';
  const chat = (lines: string[]) =>
    [PROMPT_HEADINGS.recentChat, "", "> BEGIN QUOTE: recent chat", ...lines, "> END QUOTE"].join(
      "\n",
    );
  const withChat = (prompt: string, lines: string[]) =>
    prompt.replace("# Events", `${chat(lines)}\n\n# Events`);
  const testCase = {
    ...carryCase,
    setup: {
      ...carryCase.setup,
      carry: {
        earlier: [
          {
            ...earlier[0]!,
            prompt: wake(
              '> BEGIN QUOTE: owner message\n> {"body":"Which invoices are open?"}\n> END QUOTE',
            ),
          },
          { ...earlier[1]!, prompt: withChat(earlier[1]!.prompt, [previous]) },
        ],
      },
    },
    prompt: withChat(carryCase.prompt, [
      previous.replace("09:55", "Thu 26 Nov 09:55"),
      '> owner "Rhea" Thu 26 Nov 10:00: "Which invoices are open?"',
      '> you Thu 26 Nov 10:01: "Two are open."',
      '> you Thu 26 Nov 10:16: "Yes, it includes INV-7."',
      next,
    ]),
  };
  assert.deepEqual(rendered("session", testCase).at(-1), {
    role: "system" as const,
    content: [context(`${CARRIED_TURN_NOTE}\n\n${header}\n\n${chat([next])}`)],
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
    { role: "user", content: [txt(earlier[1]!.prompt)] },
    harness(true),
    { role: "assistant", content: [txt("Yes, it includes INV-7.")] },
    { role: "user", content: [txt("# Events\n\nAnd INV-9?")] },
    { role: "system", content: [context(`${CARRIED_TURN_NOTE}\n\n${header}`)] },
  ]);
  assert.deepEqual(rendered("session", compactAt(2)), [
    { role: "user", content: [summaryBlock] },
    { role: "user", content: [txt(carryCase.prompt)] },
    harness(true),
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

it("puts the changes on the full wake when compaction cuts at the final turn", () => {
  const fresh = compactAt(2);
  const changes = renderSessionChanges(
    ['INV-12 "Transfers" (Invoices): payment $1,000.00 by Meera, 14:05'],
    [],
  );
  const testCase = {
    ...fresh,
    setup: { ...fresh.setup, carry: { ...fresh.setup.carry, changes: changes! } },
  };
  assert.deepEqual(rendered("session", testCase), [
    { role: "user", content: [summaryBlock] },
    {
      role: "user",
      content: [txt(carryCase.prompt.replace("# Events", `${changes}\n\n# Events`))],
    },
    harness(true),
  ]);
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

const ownerFirstRequest = (effort?: string) =>
  JSON.parse(
    NodeChildProcess.execFileSync(
      process.execPath,
      [
        "mcp-tool-use/run.ts",
        "--dry-run",
        "--no-step-limit",
        "--model",
        "claude-haiku-5-5",
        "--cases",
        "mcp-tool-use/cases/kin.ndjson",
        "--case",
        "kin-lead-hi-gets-one-line",
        ...(effort === undefined ? [] : ["--effort", effort]),
      ],
      { cwd: new URL("..", import.meta.url) },
    ).toString(),
  );

it("puts the Kin deferred names in the Environment system message after the wake", () => {
  const { messages } = ownerFirstRequest();
  assert.equal(messages.at(-2).role, "user");
  assert.notInclude(JSON.stringify(messages.at(-2)), "The following deferred tools");
  assert.equal(messages.at(-1).role, "system");
  const content = JSON.stringify(messages.at(-1).content);
  assert.match(
    content,
    /# Environment.*The following deferred tools.*<total_tokens>.*Today's date/s,
  );
});

it("advertises ToolSearch and owner native tools by their real names", () => {
  const { tools } = ownerFirstRequest();
  assert.includeMembers(
    tools.map(({ name }: { name: string }) => name),
    ["Bash", "Edit", "Read", "Write", "ToolSearch"],
  );
  assert.notMatch(
    JSON.stringify(tools.map(({ name }: { name: string }) => name)),
    /mcp__select_sight__/,
  );
});

it("describes ToolSearch as finding names in a system message", () => {
  const { tools } = ownerFirstRequest();
  const tool = tools.find(({ name }: { name: string }) => name.endsWith("ToolSearch"));
  assert.include(tool.description, "Deferred tools appear by name in a message from the system.");
});

it("sorts the actual owner inventory and omits tools of unconnected or engineering seats", () => {
  const { messages } = ownerFirstRequest();
  const deferred = messages
    .flatMap(({ content }: { content: Array<{ text: string }> }) =>
      content.flatMap(
        ({ text }) => text.match(/(?:^|\n)(?:Web\w+|mcp__t3-code__\w+)(?=\n)/g) ?? [],
      ),
    )
    .map((line: string) => line.trim());
  assert.includeMembers(deferred, ["WebSearch", "mcp__t3-code__delegate_task"]);
  assert.deepEqual(deferred, [...deferred].sort());
  assert.notMatch(
    deferred.join("\n"),
    /mcp__t3-code__(?:kin_github_|device_|preview_|watch_pull_request|t3_worktree_|t3_project_create)/,
  );
});

it("uses the product's default effort for Kin", () => {
  const { output_config, model } = ownerFirstRequest();
  assert.equal(
    output_config.effort,
    compileClaudeModelSelection({ model, instanceId: ProviderInstanceId.make("claudeAgent") })
      .effort,
  );
});

it("lets the run override Kin's default effort", () => {
  assert.equal(ownerFirstRequest("low").output_config.effort, "low");
});

it("uses the twelve-tool Claude owner core, keeps WebSearch deferred, and drops WebFetch", () => {
  const { tools, messages } = ownerFirstRequest();
  assert.sameMembers(
    tools
      .map(({ name }: { name: string }) => name)
      .filter((name: string) => name.startsWith("mcp__t3-code__")),
    [
      "record_update",
      "record_assign",
      "kin_ask_person",
      "kin_relay",
      "kin_defer",
      "records_query",
      "record_get",
      "docs_search",
      "client_read",
      "doc_create",
      "record_create",
      "kin_ask",
    ].map((name) => `mcp__t3-code__${name}`),
  );
  const announcement = String(messages.at(-1).content[0]?.text).split("\n");
  assert.include(announcement, "WebSearch");
  assert.notInclude(announcement, "WebFetch");
});
