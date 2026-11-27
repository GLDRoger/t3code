import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  QUOTE_LABELS,
  renderSessionDelta,
  TURN_DIVIDER,
  withSessionChanges,
} from "../../apps/server/src/kin/lead/LeadPrompt.ts";
import { fillKinRules, hasKinSessionLayout, kinOwnerDay, kinSessionSplit } from "./kin.ts";
import type { ApiMessage, McpToolUseCase } from "./run.ts";

export const KIN_SESSION_BETAS =
  "advanced-tool-use-2025-11-20,per-turn-control-2026-07-01,extended-cache-ttl-2025-04-11";

export const KIN_SESSION_CACHE = { type: "ephemeral", ttl: "1h" } as const;

const MAX_HOOK_CHANGE_CHARS = 9_000;
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
          changes: Schema.optional(Schema.String),
        }),
      ),
      changes: Schema.optional(Schema.String),
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

export const sessionLayout = (testCase: McpToolUseCase, layout: KinLayout, codex: boolean) => {
  const carry = testCase.setup.carry;
  return (
    layout === "session" &&
    !codex &&
    carry !== undefined &&
    (carry.earlier.length > 0 || carry.compactedBefore !== undefined) &&
    hasKinSessionLayout(testCase)
  );
};

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

const recentLines = (section: string | undefined) => section?.split("\n").slice(3, -1) ?? [];
const recentLine = (line: string) => {
  const match = /^> (.+?) (?:[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2,3} )?\d{1,2}:\d{2}: (.*)$/.exec(
    line,
  );
  return match === null ? undefined : { from: match[1]!, text: match[2]! };
};
const withoutClock = (line: string) => {
  const parsed = recentLine(line);
  return parsed === undefined ? line : `${parsed.from}: ${parsed.text}`;
};
const eventBody = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ body: Schema.String })),
);
const quotedBody = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.String));

const rememberExchange = (
  message: string,
  reply: string | undefined,
  seen: Map<string, Set<string>>,
) => {
  const remember = (from: string, body: string) => {
    const bodies = seen.get(from) ?? new Set<string>();
    bodies.add(body);
    seen.set(from, bodies);
  };
  const lines = message.split("\n");
  for (const [index, line] of lines.entries()) {
    const from =
      line === `> BEGIN QUOTE: ${QUOTE_LABELS.ownerMessage}`
        ? "owner"
        : line === `> BEGIN QUOTE: ${QUOTE_LABELS.coOwnerMessage}`
          ? "co-owner"
          : undefined;
    if (from === undefined) continue;
    const body = eventBody(lines[index + 1]?.slice(2));
    if (Option.isSome(body)) remember(from, body.value.body);
  }
  if (reply !== undefined) remember("you", reply);
};

const replayRecentSeqs = (
  section: string | undefined,
  previous: string | undefined,
  seen: ReadonlyMap<string, ReadonlySet<string>>,
) => {
  const before = new Set(recentLines(previous).map(withoutClock));
  // Authored wakes have no message IDs. Give known lines a synthetic seq at the prior cursor.
  return recentLines(section).map((line) => {
    if (before.has(withoutClock(line))) return 1;
    const parsed = recentLine(line);
    if (parsed === undefined) return 2;
    const body = quotedBody(/^"(?:[^"\\]|\\.)*"/.exec(parsed.text)?.[0]);
    return Option.isSome(body) && seen.get(parsed.from.split(" ", 1)[0]!)?.has(body.value) ? 1 : 2;
  });
};

const fullWakeWithChanges = (full: string, changes: string | undefined) => {
  if (!changes) return full;
  const blocks = full.split("\n\n");
  const start = blocks.indexOf(TURN_DIVIDER) + 1;
  return [
    ...blocks.slice(0, start),
    withSessionChanges(blocks.slice(start).join("\n\n"), changes),
  ].join("\n\n");
};

export const kinSessionReplay = (
  testCase: McpToolUseCase,
  layout: KinLayout,
  codex: boolean,
  reminders: ApiMessage["content"],
) => {
  checkCarry(testCase);
  if (!sessionLayout(testCase, layout, codex)) return undefined;
  const { carry, world } = testCase.setup;
  const first = carry?.compactedBefore ?? 0;
  const earlier = carry?.earlier.slice(first) ?? [];
  const date = reminders.find(
    (block) => typeof block.text === "string" && /^Today's date is /.test(block.text),
  );
  let previous: ReturnType<typeof kinSessionSplit> | undefined;
  const seen = new Map<string, Set<string>>();
  for (const turn of carry?.earlier.slice(0, first) ?? []) {
    rememberExchange(turn.prompt, turn.reply, seen);
  }
  const turns = [
    ...earlier,
    { prompt: testCase.prompt, changes: carry?.changes, reply: undefined },
  ].map(({ prompt, changes, reply }) => {
    const full = fillKinRules(prompt, world);
    const split = kinSessionSplit(full);
    const prior = previous;
    previous = split;
    const recentChatSeqs = replayRecentSeqs(
      split.sections.recentChat,
      prior?.sections.recentChat,
      seen,
    );
    rememberExchange(split.message, reply, seen);
    if (prior === undefined) {
      const day = kinOwnerDay({ ...testCase, prompt });
      return {
        message: fullWakeWithChanges(full, changes),
        context: day
          ? `Today's date is ${day}.`
          : typeof date?.text === "string"
            ? date.text
            : undefined,
      };
    }
    const rendered = renderSessionDelta({ ...split, recentChatSeqs }, { ...prior, chatSeq: 1 });
    const delta = withSessionChanges(rendered.delta, changes || undefined);
    return delta.length > MAX_HOOK_CHANGE_CHARS
      ? { message: `${split.message}\n\n${delta}`, context: undefined }
      : { message: split.message, context: delta ? kinPromptSubmitText(delta) : undefined };
  });
  const last = turns.at(-1);
  if (last === undefined) throw new Error(`${testCase.id}: missing last carry turn.`);
  return {
    reminders: reminders.filter((block) => block !== date),
    earlier: turns.slice(0, -1).map((turn, i) => ({ ...earlier[i], ...turn })),
    last,
    summary:
      carry?.compactedBefore !== undefined && carry.summary !== undefined
        ? kinCompactionSummary(carry.summary)
        : undefined,
  };
};
