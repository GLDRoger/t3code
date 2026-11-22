/**
 * What the Kin dry run checks beyond the case schema: that each mocked answer is one Kin's tool could
 * really give, and that the prompt's headings and quote labels are ones Kin's prompt can carry.
 * Checks only, so not part of the grader hash.
 */
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { fillKinMock, KIN_TOOLKITS } from "./kin.ts";

type KinTool = {
  readonly successSchema: Schema.Top;
  readonly failureSchema: Schema.Top;
};
const KIN_TOOLS: ReadonlyMap<string, KinTool> = new Map(
  KIN_TOOLKITS.flatMap((toolkit) => Object.entries(toolkit.tools as Record<string, KinTool>)),
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
      // A field it echoes from the call stands for any string the agent could send.
      const echoed = Object.fromEntries(
        [...JSON.stringify(raw ?? null).matchAll(/\{\{ARG:(\w+)\}\}/g)].map(([, key]) => [
          key,
          "arg",
        ]),
      );
      const answer = fillKinMock(raw, echoed, world);
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
