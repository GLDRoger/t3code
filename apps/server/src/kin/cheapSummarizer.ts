import {
  deterministicDigest,
  renderSummarizerPrompt,
  type KeeperEntry,
  type KeeperModelConfig,
} from "@t3tools/keeper/chronicle";
import { KeeperSummarizer, type SummarizeInput } from "@t3tools/keeper/archivist";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const CHEAP_MODEL = "google/gemini-2.5-flash-lite";

function modelId(model: KeeperModelConfig): string {
  return model.model === "cheap" || model.model.length === 0 ? CHEAP_MODEL : model.model;
}

/**
 * Calls a cheap model when a key is configured. Any miss, including a missing
 * key, falls back to the deterministic digest of the primary sources.
 */
export async function completeCheapSummary(input: {
  readonly entries: readonly KeeperEntry[];
  readonly model: KeeperModelConfig;
  readonly rebuilt: boolean;
  readonly fetchImpl?: typeof fetch;
}): Promise<string | null> {
  const key = process.env.KIN_KEEPER_API_KEY ?? process.env.OPENROUTER_API_KEY;
  if (key === undefined || key.length === 0) return null;
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    signal: AbortSignal.timeout(20_000),
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: modelId(input.model),
      messages: [
        {
          role: "user",
          content: renderSummarizerPrompt({
            rebuilt: input.rebuilt,
            entries: input.entries,
            model: input.model,
          }),
        },
      ],
    }),
  });
  if (!response.ok) return null;
  const body = (await response.json()) as {
    choices?: ReadonlyArray<{ message?: { content?: string } }>;
  };
  const text = body.choices?.[0]?.message?.content;
  return text === undefined || text.trim().length === 0 ? null : text;
}

export function summarizeOrDigest(
  input: SummarizeInput,
  complete: (input: SummarizeInput) => Promise<string | null> = (value) =>
    completeCheapSummary(value),
): Effect.Effect<string> {
  return Effect.tryPromise({
    try: () => complete(input),
    catch: () => null,
  }).pipe(
    Effect.map((text) => text ?? deterministicDigest(input.entries)),
    Effect.catch(() => Effect.succeed(deterministicDigest(input.entries))),
  );
}

export const layer = Layer.succeed(
  KeeperSummarizer,
  KeeperSummarizer.of({
    summarize: (input) => summarizeOrDigest(input),
  }),
);
