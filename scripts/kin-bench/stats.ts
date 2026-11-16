/** Shared shapes for kin-bench: one metric is several samples, read as median and p90. */

export type Group = "web" | "wire" | "server" | "prompt";

export interface Metric {
  readonly group: Group;
  readonly key: string;
  readonly label: string;
  readonly unit: "ms" | "bytes" | "count" | "percent" | "tokens" | "MB";
  readonly samples: ReadonlyArray<number>;
  readonly median: number;
  readonly p90: number;
  /** Most metrics are better lower; none here is better higher yet. */
  readonly note?: string;
}

export interface PromptSection {
  readonly name: string;
  readonly chars: number;
  readonly tokens: number;
  /** Same text in every captured turn of this agent: part of a cacheable prefix. */
  readonly stable: boolean;
}

export interface PromptTurn {
  readonly kind: string;
  readonly agent: string;
  readonly reached: boolean;
  readonly why?: string;
  readonly sections: ReadonlyArray<PromptSection>;
  readonly turnTokens: number;
  readonly systemTokens: number;
  readonly toolTokens: number;
  readonly toolCount: number;
  readonly totalTokens: number;
  /** System prompt, tools and the unchanged start of the turn prompt, over the total. */
  readonly cacheableShare: number;
}

export interface Chatter {
  readonly change: string;
  readonly clients: ReadonlyArray<{
    readonly person: string;
    readonly framesIn: number;
    readonly bytesIn: number;
    readonly framesOut: number;
    readonly requestsOut: number;
  }>;
}

export interface WireRow {
  readonly action: string;
  readonly framesIn: number;
  readonly bytesIn: number;
  readonly framesOut: number;
  readonly bytesOut: number;
  readonly largest: number;
}

export interface BenchResult {
  readonly commit: string;
  readonly at: string;
  readonly seed: Record<string, number>;
  readonly runs: number;
  readonly durationS: number;
  readonly metrics: ReadonlyArray<Metric>;
  readonly wire: ReadonlyArray<WireRow>;
  readonly chatter: ReadonlyArray<Chatter>;
  readonly prompts: {
    readonly method: string;
    readonly systemTokens: number;
    readonly tools: ReadonlyArray<{ readonly name: string; readonly tokens: number }>;
    readonly toolListBytes: { readonly modelFacing: number; readonly withOutputSchemas: number };
    readonly turns: ReadonlyArray<PromptTurn>;
  };
  readonly notes: ReadonlyArray<string>;
}

export const percentile = (values: ReadonlyArray<number>, p: number) => {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (rank - low);
};

export const metric = (
  group: Group,
  key: string,
  label: string,
  unit: Metric["unit"],
  samples: ReadonlyArray<number>,
  note?: string,
): Metric => ({
  group,
  key,
  label,
  unit,
  samples: samples.map((value) => Math.round(value * 100) / 100),
  median: Math.round(percentile(samples, 50) * 100) / 100,
  p90: Math.round(percentile(samples, 90) * 100) / 100,
  ...(note === undefined ? {} : { note }),
});

/** The repo has no tokenizer; its own budgets (`agentContextBudget.json`) count bytes. */
export const tokensOf = (text: string) => Math.round(Buffer.byteLength(text, "utf8") / 4);
