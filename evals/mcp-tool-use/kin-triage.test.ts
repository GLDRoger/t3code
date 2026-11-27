import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";

import type { KinGithubTrigger } from "@t3tools/contracts";
import {
  TRIAGE_REFUSAL,
  TRIAGE_SEAT_INSTRUCTIONS,
  TRIAGE_TOOLS,
} from "../../apps/server/src/kin/lead/outsideTriage.ts";
import { CONFINED_CONFIG } from "../../apps/server/src/kin/lead/turn/providers/codex.ts";
import type { AppServer } from "./appServer.ts";
import { isText } from "./kin.ts";
import {
  buildBase,
  buildMessages,
  makeSample,
  McpToolUseCase,
  normalizeToolName,
  requestBody,
  runSample,
} from "./run.ts";

const testCase: McpToolUseCase = {
  id: "outside-triage-tidewater",
  area: "kin",
  kind: "guard",
  pattern: "the outside issue triage seat",
  experience: "An outside GitHub issue reaches Tidewater Freight.",
  setup: { role: "top", world: { kinSeat: "outside-triage", repo: "tidewater/app" } },
  prompt: "Triage this issue.",
  expect: {},
};

const config = {
  apiKey: "fixture",
  model: "claude-sonnet-5-5",
  effort: "high",
  maxSteps: 0,
  shellModel: "claude-haiku-5-5",
} as const;
const spent = () => {
  const usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  return { usage: { ...usage }, shellUsage: { ...usage } };
};
const base = (outside = true) =>
  buildBase(
    {
      system: [
        {
          type: "text",
          text: "<runtime_info>Fixture</runtime_info>\nThe following deferred tools are now available via ToolSearch. Load them first:\nMonitor\n",
        },
      ],
      messages: [],
      tools: [
        { name: "Bash", input_schema: { type: "object" } },
        { name: "ToolSearch", input_schema: { type: "object" } },
      ],
    },
    {
      model: config.model,
      keepUserInstructions: false,
      ...(outside ? { kinSeat: "outside-triage" as const } : { kinLead: true, kinSession: true }),
    },
  );

const request = (fixture = testCase, outside = true) => {
  const sample = makeSample(fixture, base(outside));
  return requestBody(sample, config.effort, buildMessages(sample));
};

it("offers exactly the product's triage tools in the Claude request", () => {
  assert.deepEqual(
    new Set(request().tools.map(({ name }) => normalizeToolName(name))),
    TRIAGE_TOOLS,
  );
});

it("uses the product's complete outside-triage system prompt", () => {
  assert.deepEqual(
    request().system.map(({ text }) => text),
    [TRIAGE_SEAT_INSTRUCTIONS],
  );
});

it.each(["kinShared", "kinBills"])(
  "names the case when the loader finds kinSeat with %s",
  (flag) => {
    const decode = Schema.decodeUnknownSync(Schema.fromJsonString(McpToolUseCase));
    assert.throws(
      () =>
        decode(
          JSON.stringify({
            ...testCase,
            setup: { ...testCase.setup, world: { ...testCase.setup.world, [flag]: true } },
          }),
        ),
      new RegExp(`${testCase.id}.*${flag}`),
    );
  },
);

it("keeps the regular owner request when there is no seat flag", () => {
  const ownerCase: McpToolUseCase = {
    ...testCase,
    setup: { role: "top", world: { kinLead: true, kinSession: true } },
  };
  assert.include(
    request(ownerCase, false).tools.map(({ name }) => name),
    "Bash",
  );
  assert.notInclude(
    request().tools.map(({ name }) => name),
    "Bash",
  );
});

it.each(["triage", "triage_reply"] as const)(
  "builds an outside %s request with its related issue and final comment",
  (kind) => {
    const trigger: KinGithubTrigger = {
      key: `issue:${kind}:51`,
      kind,
      item: "issue",
      number: 51,
      url: "https://github.com/tidewater/app/issues/51",
      title: "Dispatch list shows a stale status",
      author: "Zoya",
      association: "NONE",
      inside: false,
      text: "The status stays stale after refresh.",
      related: [{ number: 73, title: "Old dispatch status", kind: "issue", state: "closed" }],
      conversation: [
        { author: "Rhea", kin: true, text: "Does this happen after refresh?" },
        { author: "Zoya", kin: false, text: "Yes, every time after refresh." },
      ],
    };
    const body = request({
      ...testCase,
      setup: {
        ...testCase.setup,
        world: {
          ...testCase.setup.world,
          githubTrigger: { event: kind, repo: "tidewater/app", trigger },
        },
      },
      prompt: "{{GITHUB_TRIGGER}}",
    });
    const content = body.messages[0]?.content;
    const wake = (typeof content === "string" ? content : content?.find(isText)?.text) ?? "";
    assert.match(wake, /"number"\s*:\s*73\b/);
    assert.match(wake, /"inside"\s*:\s*false\b/);
    assert.include(wake, "Yes, every time after refresh.");
    assert.deepEqual(
      body.system.map(({ text }) => text),
      [TRIAGE_SEAT_INSTRUCTIONS],
    );
  },
);

const final = "The dispatch status is stale.";
const forbidden = "mcp__t3-code__memory_read";

it.effect("returns the triage refusal to Claude and lets the sample finish", () =>
  Effect.gen(function* () {
    const replies = [
      {
        content: [{ type: "tool_use", id: "blocked", name: forbidden, input: {} }],
        stop_reason: "tool_use",
      },
      { content: [{ type: "text", text: final }], stop_reason: "end_turn" },
    ];
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            ...replies.shift(),
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        ),
      ),
    );
    const run = yield* runSample(
      { ...testCase, expect: { notCalls: ["memory_read"] } },
      config,
      base(),
      spent(),
    ).pipe(Effect.provideService(HttpClient.HttpClient, client));
    assert.equal(run.stopReason, "end_turn");
    assert.isEmpty(replies);
    assert.equal(run.calls[0]?.output, TRIAGE_REFUSAL);
    assert.equal(run.finalText, final);
    assert.include(JSON.stringify(run.transcript), TRIAGE_REFUSAL);
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("uses Codex's confined configuration and keeps going after refusing a tool", () =>
  Effect.gen(function* () {
    const server: AppServer = {
      knowsModel: async () => true,
      close: () => true,
      runTurn: async (turn) => {
        assert.equal(turn.baseInstructions, TRIAGE_SEAT_INSTRUCTIONS);
        assert.deepEqual(turn.config, CONFINED_CONFIG);
        assert.isTrue(turn.disableConfiguredMcpServers);
        assert.deepEqual(new Set(turn.tools.map(({ name }) => name)), TRIAGE_TOOLS);
        assert.isTrue(turn.tools.every(({ deferLoading }) => !deferLoading));
        assert.deepEqual(await turn.onToolCall("memory_read", {}), {
          text: TRIAGE_REFUSAL,
          failed: true,
        });
        const reply = { type: "text", text: final, phase: "final_answer" } as const;
        turn.onEvent?.(reply);
        return {
          events: [reply],
          items: [],
          usage: { input: 1, output: 1, cached: 0, reasoning: 0 },
          ms: 1,
          stopReason: "end_turn",
        };
      },
    };
    const run = yield* runSample(
      testCase,
      { ...config, model: "gpt-6.1-sol", appServer: server },
      base(),
      spent(),
    ).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("unexpected request")),
      ),
    );
    assert.equal(run.finalText, final);
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
