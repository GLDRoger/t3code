import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { renderSessionDelta } from "../../apps/server/src/kin/lead/LeadPrompt.ts";
import { fillKinRules, hasKinSessionLayout, kinOwnerDay, kinSessionSplit } from "./kin.ts";
import type { ApiMessage, McpToolUseCase } from "./run.ts";

export const KIN_SESSION_BETAS =
  "advanced-tool-use-2025-11-20,per-turn-control-2026-07-01,extended-cache-ttl-2025-04-11";

export const KIN_SESSION_CACHE = { type: "ephemeral", ttl: "1h" } as const;

const kinSessionStartText = (standing: string) =>
  `SessionStart hook additional context: ${standing}`;

const kinPromptSubmitText = (delta: string) => `UserPromptSubmit hook additional context: ${delta}`;

const kinCompactionSummary = (summary: string) =>
  `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n${summary}`;

export const kinCarrySchema = <Call extends Schema.Top>(call: Call) =>
  Schema.optional(
    Schema.Struct({
      earlier: Schema.Array(
        Schema.Struct({
          prompt: Schema.String,
          toolCalls: Schema.optional(Schema.Array(call)),
          reply: Schema.optional(Schema.String),
        }),
      ),
      compactedBefore: Schema.optional(
        Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
      ),
      summary: Schema.optional(Schema.String),
    }),
  );

export const earlierCalls = (testCase: McpToolUseCase) =>
  (testCase.setup.carry?.earlier ?? []).flatMap((turn) => turn.toolCalls ?? []);

const checkCarry = ({ id, setup }: McpToolUseCase) => {
  const carry = setup.carry;
  if (carry === undefined) return;
  if (setup.priorTurns !== undefined)
    throw new Error(`${id}: setup.carry and setup.priorTurns are mutually exclusive.`);
  const n = carry.compactedBefore;
  if (n !== undefined && (n > carry.earlier.length || !carry.summary?.trim()))
    throw new Error(`${id}: compactedBefore must name a turn and have a nonempty summary.`);
};

export const carryMockState = (
  testCase: McpToolUseCase,
  normalizeToolName: (name: string) => string,
) => {
  const mockCalls = new Map<string, number>();
  const mockHistory = new Map<string, ReadonlyArray<{ input: unknown; output: unknown }>>();
  for (const { tool, input, result } of earlierCalls(testCase)) {
    const name = normalizeToolName(tool);
    mockCalls.set(name, (mockCalls.get(name) ?? 0) + 1);
    mockHistory.set(name, [...(mockHistory.get(name) ?? []), { input, output: result }]);
  }
  return { mockCalls, mockHistory };
};

export const KIN_LAYOUTS = ["legacy", "session"] as const;
export type KinLayout = (typeof KIN_LAYOUTS)[number];

export const sessionLayout = (testCase: McpToolUseCase, layout: KinLayout, codex: boolean) =>
  layout === "session" && !codex && hasKinSessionLayout(testCase);

export const expectationsForLayout = (testCase: McpToolUseCase, arm?: string, layout?: string) => {
  const expect = arm === "raw" ? (testCase.expectRaw ?? testCase.expect) : testCase.expect;
  return layout === "session" && testCase.sessionCallsMustNot !== undefined
    ? { ...expect, callsMustNot: [...(expect.callsMustNot ?? []), ...testCase.sessionCallsMustNot] }
    : expect;
};

export const kinSessionWireMessages = (messages: ReadonlyArray<ApiMessage>) =>
  messages.map((message, i) => {
    if (i === messages.length - 1)
      return {
        ...message,
        content: message.content.map((block, j) =>
          j === message.content.length - 1 ? { ...block, cache_control: KIN_SESSION_CACHE } : block,
        ),
      };
    const only = message.content.length === 1 ? message.content[0] : undefined;
    return only?.type === "text" && typeof only.text === "string"
      ? { ...message, content: only.text }
      : message;
  });

type Carry = NonNullable<McpToolUseCase["setup"]["carry"]>;
type Call = NonNullable<Carry["earlier"][number]["toolCalls"]>[number];

export const loadKinCarry = Effect.fn("evaluateMcpToolUse.loadKinCarry")(function* <E, R>(
  testCase: McpToolUseCase,
  loadCalls: (calls?: ReadonlyArray<Call>) => Effect.Effect<ReadonlyArray<Call>, E, R>,
) {
  checkCarry(testCase);
  const { carry } = testCase.setup;
  if (carry === undefined) return undefined;
  const earlier = yield* Effect.forEach(carry.earlier, (turn) =>
    loadCalls(turn.toolCalls).pipe(Effect.map((toolCalls) => ({ ...turn, toolCalls }))),
  );
  return { ...carry, earlier };
});

export const kinSessionReplay = (
  testCase: McpToolUseCase,
  layout: KinLayout,
  codex: boolean,
  reminders: ApiMessage["content"],
) => {
  checkCarry(testCase);
  if (!sessionLayout(testCase, layout, codex)) return undefined;
  const { carry, world } = testCase.setup;
  const split = (prompt: string) => kinSessionSplit(fillKinRules(prompt, world));
  const earlier = carry?.earlier ?? [];
  const wakes = [...earlier, { prompt: testCase.prompt }].map((turn) => ({
    ...turn,
    ...split(turn.prompt),
  }));
  const first = carry?.compactedBefore ?? 0;
  const compacted = carry?.compactedBefore !== undefined;
  const date = reminders.find(
    (block) => typeof block.text === "string" && /^Today's date is /.test(block.text),
  );
  const turns = wakes.slice(first).map((current, offset) => {
    const previous = wakes[first + offset - 1];
    const { delta } = previous === undefined ? current : renderSessionDelta(current, previous);
    const day = offset === 0 ? kinOwnerDay({ ...testCase, prompt: current.prompt }) : undefined;
    const context = [
      compacted && offset === 0 && current.standing
        ? kinSessionStartText(current.standing)
        : undefined,
      delta ? kinPromptSubmitText(delta) : undefined,
      offset !== 0 ? undefined : day ? `Today's date is ${day}.` : date?.text,
    ]
      .filter((part): part is string => typeof part === "string")
      .join("\n\n");
    return { message: current.message, context };
  });
  const last = turns.at(-1);
  if (last === undefined) throw new Error(`${testCase.id}: missing last carry turn.`);
  const standing = wakes[first]?.standing;
  return {
    reminders: reminders.filter((block) => block !== date),
    // Startup was not observed in the SDK probe; use the documented start reminder.
    startup: !compacted && standing ? kinSessionStartText(standing) : undefined,
    earlier: turns.slice(0, -1).map((turn, offset) => ({ ...earlier[first + offset], ...turn })),
    last,
    summary:
      compacted && carry?.summary !== undefined ? kinCompactionSummary(carry.summary) : undefined,
  };
};
