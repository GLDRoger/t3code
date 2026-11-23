/**
 * What the Kin dry run checks beyond the case schema: that each mocked answer is one Kin's tool could
 * really give, and that the prompt's headings and quote labels are ones Kin's prompt can carry.
 * Checks only, so not part of the grader hash.
 */
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  humanMessageLabel,
  PROMPT_HEADINGS,
  QUOTE_LABELS,
  TEAMMATE_WORDS,
} from "../../apps/server/src/kin/lead/LeadPrompt.ts";
import {
  OPEN_QUESTION_HEADINGS,
  openQuestionsHeading,
} from "../../apps/server/src/kin/questions/openQuestions.ts";
import { fillKinMock, isKinCase, isKinTool, KIN_TOOLKITS } from "./kin.ts";
import type { McpToolUseCase } from "./run.ts";

type KinTool = {
  readonly successSchema: Schema.Top;
  readonly failureSchema: Schema.Top;
};
const KIN_TOOLS: ReadonlyMap<string, KinTool> = new Map(
  KIN_TOOLKITS.flatMap((toolkit) => Object.entries(toolkit.tools as Record<string, KinTool>)),
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Sets "arg" at a call-input path, making the arrays and objects on the way. */
const echo = (
  into: Record<string, unknown>,
  [step, ...rest]: ReadonlyArray<string>,
  value: string,
): void => {
  if (step === undefined) return;
  if (rest.length === 0) {
    into[step] = value;
    return;
  }
  const next = (into[step] ??= /^\d+$/.test(rest[0]!) ? [] : {}) as Record<string, unknown>;
  echo(next, rest, value);
};

/**
 * A Kin mock's answer as Kin's code fills it in, with each field it echoes from the call standing
 * for any string the agent could send: `sent`, a time by default, so time builders run too.
 */
export const filledKinMock = (
  raw: unknown,
  world?: Parameters<typeof fillKinMock>[2],
  sent = "2026-11-18T19:00:00+05:30",
) => {
  const echoed: Record<string, unknown> = {};
  for (const [, path] of JSON.stringify(raw ?? null).matchAll(/\{\{ARG:([\w.]+)\}\}/g))
    echo(echoed, path!.split("."), sent);
  return fillKinMock(raw, echoed, world);
};

/** Each answer a mock can give, with where it sits in the mock. */
const answers = (mock: unknown, at: string): ReadonlyArray<{ at: string; answer: unknown }> => {
  if (isRecord(mock) && Array.isArray(mock.$sequence))
    return mock.$sequence.flatMap((one, n) => answers(one, `${at}.$sequence[${n}]`));
  if (isRecord(mock) && Array.isArray(mock.$when))
    return [
      ...mock.$when.flatMap((rule, n) =>
        answers(isRecord(rule) ? rule.result : undefined, `${at}.$when[${n}].result`),
      ),
      ...(mock.$else === undefined ? [] : answers(mock.$else, `${at}.$else`)),
    ];
  return [{ at, answer: mock }];
};

// Strict on extra keys: the tool's encoder never writes a key its schema lacks.
const STRICT = { onExcessProperty: "error", errors: "first" } as const;
const decoders = new Map<Schema.Top, (value: unknown) => string | undefined>();
const problemWith = (schema: Schema.Top, value: unknown) => {
  let decode = decoders.get(schema);
  if (decode === undefined) {
    const decodeExit = Schema.decodeUnknownExit(Schema.toCodecJson(schema as never), STRICT);
    decode = (one) => {
      const exit = decodeExit(one);
      if (Exit.isSuccess(exit)) return undefined;
      const error: unknown = Cause.squash(exit.cause);
      return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
    };
    decoders.set(schema, decode);
  }
  return decode(value);
};

/**
 * Mocked answers no Kin tool could give: each Kin tool's answer must decode with its own success
 * schema, and a `$error` with its failure schema, which reaches the agent as that JSON. A mocked
 * tool that is neither Kin's nor one the turn's catalog knows is a problem too.
 */
export const kinMockProblems = (
  mocks: Readonly<Record<string, unknown>> | undefined,
  known: ReadonlySet<string>,
  world?: Parameters<typeof fillKinMock>[2],
): ReadonlyArray<string> =>
  Object.entries(mocks ?? {}).flatMap(([name, mock]) => {
    const tool = KIN_TOOLS.get(name);
    if (tool === undefined)
      return known.has(name) ? [] : [`mocks ${name}, which no Kin toolkit or catalog has`];
    return answers(mock, name).flatMap(({ at, answer: raw }) => {
      if (raw === "default")
        return [`${at} is "default", answered {"ok":true}, which ${name} never returns`];
      const answer = filledKinMock(raw, world, "arg");
      const unfilled = JSON.stringify(answer ?? null).match(/\{\{[^}]*\}\}/);
      if (unfilled !== null)
        return [`${at} has a placeholder Kin's code doesn't fill: ${unfilled[0]}`];
      const failed = isRecord(answer) && "$error" in answer;
      const problem = failed
        ? problemWith(tool.failureSchema, answer.$error)
        : problemWith(tool.successSchema, answer);
      return problem === undefined
        ? []
        : [`${at}${failed ? ".$error" : ""} is not an answer ${name} gives: ${problem}`];
    });
  });

/** Whether `text` is `shape` of some non-empty value, as Kin fills a heading or label in. */
const fits = (text: string, shape: (value: string) => string) => {
  const [head = "", tail = ""] = shape("\u0000").split("\u0000");
  return text.length > head.length + tail.length && text.startsWith(head) && text.endsWith(tail);
};
const HEADINGS: ReadonlySet<string> = new Set([
  ...Object.values(PROMPT_HEADINGS),
  ...Object.values(OPEN_QUESTION_HEADINGS),
]);
const LABELS: ReadonlySet<string> = new Set([...Object.values(QUOTE_LABELS), TEAMMATE_WORDS]);
const isHeading = (line: string) => HEADINGS.has(line) || fits(line, openQuestionsHeading);

/**
 * Headings and quote labels in a Kin case's own text that Kin's prompt never writes. The owner's
 * rules file is theirs, so headings under Standing rules, up to Kin's next heading, are not checked;
 * text a `{{…}}` placeholder fills in is Kin's own by construction.
 */
export const kinPromptProblems = (text: string): ReadonlyArray<string> => {
  const problems: Array<string> = [];
  let inRules = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("# ")) {
      if (isHeading(line)) inRules = line === PROMPT_HEADINGS.standingRules;
      else if (!inRules) problems.push(`heading Kin's prompt never writes: ${line}`);
    }
    const label = /^> BEGIN QUOTE: (.*)$/.exec(line)?.[1];
    if (label !== undefined && !LABELS.has(label) && !fits(label, humanMessageLabel))
      problems.push(`quote label Kin's prompt never writes: ${label}`);
  }
  return problems;
};

/** The text of a Kin case Kin's prompt writes: its prompt and the user turns before it. */
export const kinCaseText = (testCase: {
  readonly prompt: string;
  readonly setup: {
    readonly priorTurns?:
      | ReadonlyArray<{ readonly role: string; readonly text?: string | undefined }>
      | undefined;
  };
}) =>
  [
    testCase.prompt,
    ...(testCase.setup.priorTurns ?? [])
      .filter((turn) => turn.role === "user")
      .map((turn) => turn.text ?? ""),
  ].join("\n\n");

/** What `kin:dry` refuses in a Kin case beyond the case schema: its mocks, headings and labels. */
export const kinCaseProblems = (testCase: McpToolUseCase, tools: ReadonlySet<string>) =>
  isKinCase(testCase)
    ? [
        ...kinMockProblems(testCase.setup.mocks, tools, testCase.setup.world),
        ...kinPromptProblems(kinCaseText(testCase)),
      ]
    : [];

/** Every answer of each Kin mock a case has, filled in by Kin's own builders, by tool name. */
export const filledKinMocks = (setup: McpToolUseCase["setup"]) =>
  Object.keys(setup.mocks ?? {})
    .filter(isKinTool)
    .toSorted()
    .map((name) => [
      name,
      answers(setup.mocks?.[name], name).map(({ answer }) => filledKinMock(answer, setup.world)),
    ]);
