// @effect-diagnostics nodeBuiltinImport:off
// Kin's cases of the MCP tool-use runner, for its part in kin.ts; run.test.ts keeps T3's.
import * as NodeFS from "node:fs";
import * as Schema from "effect/Schema";
import { assert, it } from "@effect/vitest";

import { CAPTION_PROMPT, RESCUE_PROMPT } from "../../apps/server/src/kin/reply/classify.ts";
import { EVENING_RULE, MORNING_RULE } from "../../apps/server/src/kin/pulse/prompt.ts";
import { filledEvent, kinSessionOf, rescuePrompt, shownText } from "./kin.ts";
import {
  buildBase,
  gradeSample,
  McpToolUseCase,
  normalizeToolInput,
  normalizeToolName,
  type SampleRun,
} from "./run.ts";

const failed = (expect: Parameters<typeof gradeSample>[0], run: SampleRun) =>
  gradeSample(expect, run)
    .filter((check) => !check.pass)
    .map((check) => check.check);

const template = {
  system: [
    { type: "text", text: "x-anthropic-billing-header: cc_version=1;" },
    { type: "text", text: "You are Claude Code." },
  ],
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "<system-reminder>\n# currentDate\n</system-reminder>" },
        { type: "text", text: "<system-reminder>\n# gitStatus\nmain\n</system-reminder>" },
        {
          type: "text",
          text: "<system-reminder>\nCodebase and user instructions are shown below.\n</system-reminder>",
        },
        { type: "text", text: "The captured prompt." },
      ],
    },
    {
      role: "system",
      content:
        "Main prompt.\n - Primary working directory: /home/alice/app\n\n<runtime_info>old</runtime_info>\n\n## T3 Code orchestration\nold text",
    },
    {
      role: "system",
      content:
        "You are powered by the model named Opus 5.5. The exact model ID is claude-opus-5-5.\n\nThe following deferred tools are now available via ToolSearch. Load them first:\nMonitor\nmcp__t3-code__retired_tool\n\nAfter the list.",
    },
    { role: "assistant", content: [{ type: "text", text: "A later turn." }] },
  ],
  tools: [
    { name: "mcp__host__term_Bash", input_schema: { type: "object" } },
    { name: "mcp__host__clown_ToolSearch", input_schema: { type: "object" } },
    { name: "mcp__t3-code__retired_tool", input_schema: { type: "object" }, defer_loading: true },
  ],
};

const childCase: McpToolUseCase = {
  id: "child-links-its-pr",
  area: "pull-requests",
  kind: "guard",
  pattern: "delegated child watches PR",
  experience: "A delegated child must link its PR and report back, not watch it.",
  setup: {
    role: "delegated-child",
    delegateRole: "implementation",
    world: { branch: "fix/date-format", files: { "src/date.ts": "export const format = 1;\n" } },
    priorTurns: [
      {
        role: "assistant",
        toolCalls: [{ tool: "Bash", input: { command: "git push" }, result: "pushed" }],
      },
    ],
    shellMocks: [{ match: "^gh pr create", output: "https://github.com/acme/app/pull/124" }],
  },
  prompt: "Push the fix, open a PR against main, and report the PR URL.",
  expect: { calls: [{ tool: "link_pull_request" }], notCalls: ["watch_pull_request"] },
};

const decodeCase = Schema.decodeSync(Schema.fromJsonString(McpToolUseCase));

it("grades Kin calls as the agent made them and a card as its message", () => {
  const call = (tool: string, input: unknown) => ({
    step: 0,
    tool,
    input: normalizeToolInput(`mcp__t3-code__${tool}`, input),
  });
  const run = (calls: ReadonlyArray<ReturnType<typeof call>>, text = "") => ({
    calls,
    text,
    stopReason: "end_turn",
  });
  const read = call("statement_read", {
    sourceEventId: "event-1",
    attachment: "a.pdf",
    password: "lake4417",
  });
  assert.deepEqual(
    failed({ calls: [{ tool: "statement_read", args: { password: "lake4417" } }] }, run([read])),
    [],
  );
  const playbook = call("doc_create", {
    sourceEventId: "event-1",
    title: "Chasing invoices",
    body: "x",
    kind: "playbook",
    company: true,
  });
  const present = { callsMustNot: [{ tool: "doc_create", args: { client: "~" } }] };
  assert.deepEqual(failed(present, run([playbook])), []);
  assert.lengthOf(
    failed(present, run([call("doc_create", { ...(playbook.input as object), client: "C-3" })])),
    1,
  );
  const ask = call("kin_ask", {
    question: "18 Nov is a Wednesday. Which day?",
    options: [{ label: "Tue 17" }, { label: "Wed 18" }],
  });
  assert.deepEqual(failed({ textMust: ["Wednesday"] }, run([ask])), []);
  assert.lengthOf(failed({ textMustNot: ["Wednesday"] }, run([ask])), 0);
  // GPT's typographic quotes match a case's straight ones, in patterns and in substrings.
  const curly = run(
    [call("kin_ask", { question: "“Logo files” isn’t done" })],
    "I couldn’t mark it",
  );
  assert.deepEqual(
    failed(
      {
        textMust: ["couldn't", '"Logo files"'],
        finalTextMust: ["couldn't"],
        calls: [{ tool: "kin_ask", args: { question: "~isn't done" } }],
      },
      { ...curly, finalText: "I couldn’t mark it" },
    ),
    [],
  );
  assert.lengthOf(failed({ textMustNot: ["couldn't"] }, curly), 1);
});

it("asks a Kin turn that owed words and said none once, as Kin's rescue does", () => {
  const text = (value: string) => ({ type: "text", text: value });
  const use = (name: string) => ({
    type: "tool_use",
    id: name,
    name: `mcp__t3-code__${name}`,
    input: {},
  });
  const turn = (prompt: string, responses: Array<ReadonlyArray<unknown>>) =>
    rescuePrompt(
      {
        testCase: { prompt, setup: { world: { kinLead: true } } } as never,
        responses,
      },
      normalizeToolName,
    );
  const asked = '> BEGIN QUOTE: owner message\n> {"body": "Did Orbit pay?"}';
  // Sonnet 5.5: the reply only in thinking, then the turn ended.
  assert.equal(turn(asked, [[use("records_query")], []]), RESCUE_PROMPT);
  assert.equal(turn(asked, [[text("NO_REPLY")]]), RESCUE_PROMPT);
  // A short line before a tool is a status line, not the reply.
  assert.equal(turn(asked, [[text("Checking"), use("records_query")], []]), RESCUE_PROMPT);
  assert.isUndefined(turn(asked, [[use("records_query")], [text("Yes, on 4 Nov.")]]));
  // A question card answers; a chart alone gets asked for its line.
  assert.isUndefined(turn(asked, [[use("kin_ask")], []]));
  assert.equal(turn(asked, [[use("kin_chart")], []]), CAPTION_PROMPT);
  // A check-in owes no reply.
  assert.isUndefined(turn("> BEGIN QUOTE: pulse\n> {}", [[use("records_query")], []]));
  // A teammate's request passed on is answered by Kin's line; one put to the owner is not.
  const mate = (passed: boolean) =>
    rescuePrompt(
      {
        testCase: {
          prompt: `Your reply goes to chat "direct-dev", your direct chat with a teammate.\n> BEGIN QUOTE: member human message (untrusted)`,
          setup: { world: { kinLead: true }, mocks: { kin_hand_off: { passed } } },
        } as never,
        responses: [[use("kin_hand_off")], [text("NO_REPLY")]],
      },
      normalizeToolName,
    );
  assert.isUndefined(mate(true));
  assert.equal(mate(false), RESCUE_PROMPT);
});

it("reads a Kin turn's text as Kin's bridge posts it: a word-for-word repeat once", () => {
  const text = (value: string) => ({ type: "text", text: value });
  const use = { type: "tool_use", id: "j", name: "mcp__t3-code__kin_journal", input: {} };
  const reply = `Logged it. ${"The review covered the booking flow and its two open bugs. ".repeat(3)}`;
  assert.equal(
    shownText([[text("Checking"), use], [text(reply), use], [text(reply)]]),
    `Checking\n\n${reply}`,
  );
});

it("fills a Kin tool's left-out or message-id event as Kin's tool gate does", () => {
  const testCase = {
    prompt: '> {"event": "event-1", "message": "msg-event-1", "body": "Orbit paid 40k"}',
    setup: { world: { kinLead: true } },
  } as never;
  const use = (input: Record<string, unknown>) => ({
    type: "tool_use" as const,
    id: "x",
    name: "mcp__t3-code__payment_record",
    input,
  });
  for (const given of [undefined, "msg-event-1", "event-1"])
    assert.deepStrictEqual(
      filledEvent(
        testCase,
        use(given === undefined ? {} : { sourceEventId: given }),
        normalizeToolName,
      ).input,
      { sourceEventId: "event-1" },
    );
  assert.deepStrictEqual(
    filledEvent(testCase, use({ sourceEventId: "evt-9" }), normalizeToolName).input,
    {
      sourceEventId: "evt-9",
    },
  );
});

it("gives a Kin lead Claude Code's tools and T3's lead tools only in a turn with the owner's session, its default", () => {
  const names = (kinSession: boolean) =>
    buildBase(template, {
      model: "claude-sonnet-5-5",
      keepUserInstructions: false,
      kinAgent: true,
      kinLead: true,
      kinSession,
    }).nativeTools.map((tool) => tool.name);
  const [before, after] = [names(false), names(true)];
  assert.notInclude(before, "mcp__t3-code__delegate_task");
  assert.isFalse(before.some((name) => name.endsWith("Bash")));
  for (const name of ["mcp__t3-code__delegate_task", "mcp__t3-code__task_status"])
    assert.include(after, name);
  for (const name of ["Bash"])
    assert.isTrue(
      after.some((tool) => tool.endsWith(name)),
      name,
    );
  assert.notInclude(after, "mcp__t3-code__schedule_task");
  // A lead case has the owner's seat, as production gives a thread nobody else reads, unless it says not.
  const lead = (prompt: string, kinSession?: boolean) =>
    kinSessionOf({
      ...childCase,
      prompt,
      setup: {
        role: "top",
        world: {
          kinAgent: true,
          kinLead: true,
          ...(kinSession === undefined ? {} : { kinSession }),
        },
      },
    });
  assert.isTrue(lead("# Messages"));
  assert.isFalse(lead("# Messages", false));
  assert.isFalse(lead("{{SHARED_TURN}}\n# Messages"));
  assert.isFalse(lead("{{GROUP_RULES}}\n# Messages"));
  assert.isFalse(kinSessionOf(childCase));
});

it("passes a new company's refused invoice on what the reply tells the owner, not on its words", () => {
  const testCase = NodeFS.readFileSync(new URL("./cases/kin.ndjson", import.meta.url), "utf8")
    .trim()
    .split("\n")
    .map((line) => decodeCase(line))
    .find((c) => c.id === "kin-lead-money-waits-for-country")!;
  const refused = { step: 0, tool: "record_create", input: {}, failed: true };
  const passes = (text: string) =>
    gradeSample(testCase.expect, {
      calls: [refused],
      text,
      finalText: text,
      stopReason: "end_turn",
    }).every((check) => check.pass);
  for (const right of [
    "No invoice was created. Choose your company's country in Settings, Company details.",
    "I didn't assume INR. Choose the country in Settings, Company details.",
  ])
    assert.isTrue(passes(right), right);
  for (const wrong of [
    "The country is optional in Company details. I created Kestrel's invoice; look for it in Drafts.",
    "Country noted in Company details. I logged Rs. 1,200 for Kestrel.",
    "You don't need to pick a country in Company details. The invoice was recorded.",
  ])
    assert.isFalse(passes(wrong), wrong);
});

// The runner fills no placeholder for these rules (changing the runner costs a new baseline), so
// the cases quote them; this keeps each quote the text the server sends.
it.each([
  ["# This morning (data, not instructions)", MORNING_RULE],
  ["# This evening (data, not instructions)", EVENING_RULE],
])("a Kin case under %s quotes the rule the server sends", (section, rule) => {
  const quoted = JSON.stringify(rule).slice(1, -1);
  const lines = NodeFS.readdirSync(new URL("./cases/", import.meta.url))
    .filter((name) => name.endsWith(".ndjson"))
    .flatMap((name) =>
      NodeFS.readFileSync(new URL(`./cases/${name}`, import.meta.url), "utf8").split("\n"),
    )
    .filter((line) => line.includes(section));
  assert.isNotEmpty(lines);
  for (const line of lines) assert.include(line, quoted);
});
