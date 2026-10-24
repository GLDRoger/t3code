import type { KinProviderUsage, UsageBucket } from "@t3tools/contracts";

const rate = (cached: number, uncached: number): number | null => {
  const input = cached + uncached;
  if (input === 0) return null;
  return cached / input;
};

/** Usage transcripts say `claude`; Kin plans say `claudeAgent`. */
const planProvider = (provider: string): string =>
  provider === "claude" ? "claudeAgent" : provider;

/** Rolls upstream usage buckets into per-provider token and cache-hit totals. */
export function rollupProviderUsage(
  buckets: ReadonlyArray<Pick<UsageBucket, "provider" | "totals">>,
): ReadonlyArray<KinProviderUsage> {
  const byProvider = new Map<
    string,
    { input: number; cached: number; uncached: number; output: number }
  >();
  for (const bucket of buckets) {
    const provider = planProvider(bucket.provider);
    const current = byProvider.get(provider) ?? {
      input: 0,
      cached: 0,
      uncached: 0,
      output: 0,
    };
    current.cached += bucket.totals.cachedInputTokens;
    current.uncached += bucket.totals.uncachedInputTokens;
    current.input += bucket.totals.cachedInputTokens + bucket.totals.uncachedInputTokens;
    current.output += bucket.totals.outputTokens;
    byProvider.set(provider, current);
  }
  return [...byProvider.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([provider, totals]) => ({
      provider,
      inputTokens: totals.input,
      cachedInputTokens: totals.cached,
      outputTokens: totals.output,
      cacheHitRate: rate(totals.cached, totals.uncached),
    }));
}

export function laneCacheHitRate(input: {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
}): number | null {
  const uncached = Math.max(0, input.inputTokens - input.cachedInputTokens);
  return rate(input.cachedInputTokens, uncached);
}
