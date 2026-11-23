/**
 * What `--dry-run` checks beyond the case schema, and what `--estimate` prices from the requests a
 * dry run builds. Neither calls a model.
 */

import { casePattern } from "./pattern.ts";

export type Prices = {
  readonly input: number;
  readonly output: number;
  readonly cacheWrite: number;
  readonly cacheRead: number;
};

type Expect = {
  readonly calls?: ReadonlyArray<{ readonly tool: string }> | undefined;
  readonly distinctCalls?: ReadonlyArray<{ readonly tool: string }> | undefined;
  readonly order?: ReadonlyArray<string> | undefined;
  readonly minCalls?: Readonly<Record<string, number>> | undefined;
  readonly endsTurnAfter?: string | undefined;
  readonly textMust?: ReadonlyArray<string> | undefined;
  readonly textMustNot?: ReadonlyArray<string> | undefined;
  readonly finalTextMust?: ReadonlyArray<string> | undefined;
  readonly shellMust?: ReadonlyArray<string> | undefined;
  readonly shellMustNot?: ReadonlyArray<string> | undefined;
};

/**
 * Problems a schema can't see: a regex that doesn't compile, or a check that needs a call to a tool
 * the agent doesn't have. Either one decides a check for the wrong reason. Negative checks may name
 * absent tools on purpose.
 */
export const caseProblems = (
  testCase: { readonly expect: Expect },
  tools: ReadonlySet<string>,
): ReadonlyArray<string> => {
  const { expect } = testCase;
  const patterns = [
    ...(expect.textMust ?? []),
    ...(expect.textMustNot ?? []),
    ...(expect.finalTextMust ?? []),
    ...(expect.shellMust ?? []),
    ...(expect.shellMustNot ?? []),
  ];
  const badPatterns = patterns.flatMap((pattern) => {
    try {
      casePattern(pattern);
      return [];
    } catch {
      return [`regex does not compile: ${pattern}`];
    }
  });
  const named = new Set([
    ...[...(expect.calls ?? []), ...(expect.distinctCalls ?? [])].map((call) => call.tool),
    ...(expect.order ?? []),
    ...Object.entries(expect.minCalls ?? {})
      .filter(([, least]) => least > 0)
      .map(([tool]) => tool),
    ...(expect.endsTurnAfter === undefined ? [] : [expect.endsTurnAfter]),
  ]);
  // A check may name alternatives as `a|b`; one of them is enough.
  const unknown = [...named]
    .filter((name) => !name.split("|").some((one) => tools.has(one)))
    .map((name) => `names a tool the agent doesn't have: ${name}`);
  return [...badPatterns, ...unknown];
};

/** Claude's tokenizers average about 4 characters a token on this text, as `--context` assumes. */
export const approxTokens = (chars: number) => Math.ceil(chars / 4);

/** What a sample is assumed to do, since only a paid run knows. */
export type SampleShape = {
  /** Model calls in one sample. */
  readonly calls: number;
  /** Output tokens per call, adaptive thinking included. */
  readonly outputPerCall: number;
  /** Tokens a tool result adds before the next call. */
  readonly resultPerCall: number;
};

export const ASSUMED_SHAPE: SampleShape = { calls: 3, outputPerCall: 700, resultPerCall: 150 };

/**
 * USD for one sample. Call k resends the prefix (system and tools), the case's messages and what
 * earlier calls added. With caching (what the runner sends), the prefix is read from the cache
 * (`prefixWarm`), or written once when it isn't, and each call reads what the one before it wrote.
 */
export const sampleCost = (
  prices: Prices,
  prefix: number,
  messages: number,
  shape: SampleShape,
  cached: boolean,
  prefixWarm: boolean,
) => {
  const perMillion = (tokens: number, rate: number) => (tokens * rate) / 1_000_000;
  const step = shape.outputPerCall + shape.resultPerCall;
  let usd = perMillion(shape.calls * shape.outputPerCall, prices.output);
  for (let k = 0; k < shape.calls; k++) {
    const sent = prefix + messages + k * step;
    if (!cached) {
      usd += perMillion(sent, prices.input);
      continue;
    }
    usd +=
      k === 0
        ? perMillion(prefix, prefixWarm ? prices.cacheRead : prices.cacheWrite) +
          perMillion(messages, prices.cacheWrite)
        : perMillion(sent - step, prices.cacheRead) + perMillion(step, prices.cacheWrite);
  }
  return usd;
};

/** Seconds per model call at about 30k input tokens with adaptive thinking: an assumption. */
export const ASSUMED_CALL_SECONDS: Readonly<Record<string, number>> = {
  "claude-opus-5-5": 25,
  "claude-sonnet-5-5": 15,
  "claude-haiku-5-5": 6,
};

export type EstimateRow = {
  readonly model: string;
  readonly cases: number;
  readonly samples: number;
  readonly inputPerCall: number;
  readonly cachedUsd: number;
  readonly uncachedUsd: number;
  readonly minutes: number;
};

export const estimate = (
  model: string,
  prices: Prices,
  requests: ReadonlyArray<{ readonly prefixChars: number; readonly messageChars: number }>,
  options: { readonly samples: number; readonly concurrency: number; readonly shape: SampleShape },
): EstimateRow => {
  const { samples, concurrency, shape } = options;
  let cachedUsd = 0;
  let uncachedUsd = 0;
  let input = 0;
  requests.forEach((request, index) => {
    const prefix = approxTokens(request.prefixChars);
    const messages = approxTokens(request.messageChars);
    input += prefix + messages;
    for (let sample = 0; sample < samples; sample++) {
      uncachedUsd += sampleCost(prices, prefix, messages, shape, false, false);
      // Cases share a prefix by kind; the first sample of the run writes it, the rest read it.
      cachedUsd += sampleCost(prices, prefix, messages, shape, true, index > 0 || sample > 0);
    }
  });
  const waves = Math.ceil((requests.length * samples) / concurrency);
  const seconds = waves * shape.calls * (ASSUMED_CALL_SECONDS[model] ?? 20);
  return {
    model,
    cases: requests.length,
    samples,
    inputPerCall: requests.length === 0 ? 0 : Math.round(input / requests.length),
    cachedUsd,
    uncachedUsd,
    minutes: Math.ceil(seconds / 60),
  };
};

export const estimateTable = (rows: ReadonlyArray<EstimateRow>, shape: SampleShape) =>
  [
    `Assumed per sample: ${shape.calls} model calls, ${shape.outputPerCall} output tokens each (thinking included), ${shape.resultPerCall} tokens of tool result between calls. Input tokens are characters / 4.`,
    "",
    "| Model | Cases | Samples each | Input tokens, first call | Cache on | Cache off | Wall time |",
    "| --- | --: | --: | --: | --: | --: | --: |",
    ...rows.map(
      (row) =>
        `| ${row.model} | ${row.cases} | ${row.samples} | ~${row.inputPerCall.toLocaleString("en-US")} | $${row.cachedUsd.toFixed(2)} | $${row.uncachedUsd.toFixed(2)} | ~${row.minutes} min |`,
    ),
  ].join("\n");
