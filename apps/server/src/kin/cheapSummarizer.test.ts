import { describe, expect, it } from "@effect/vitest";
import { deterministicDigest, DEFAULT_KEEPER_MODEL } from "@t3tools/keeper/chronicle";
import * as Effect from "effect/Effect";

import { summarizeOrDigest } from "./cheapSummarizer.ts";

const input = {
  scopeId: "repo:project",
  sessionId: "session",
  sessionReused: false,
  rebuilt: true,
  model: DEFAULT_KEEPER_MODEL,
  entries: [
    {
      id: "will-1",
      kind: "will" as const,
      at: "2026-10-01T00:00:00Z",
      body: "left a map",
    },
  ],
};

describe("cheap summarizer", () => {
  it.effect("uses the model text when the call returns one", () =>
    Effect.gen(function* () {
      const text = yield* summarizeOrDigest(input, async () => "A fresh chronicle.");
      expect(text).toBe("A fresh chronicle.");
    }),
  );

  it.effect("falls back to the deterministic digest when the model misses", () =>
    Effect.gen(function* () {
      const text = yield* summarizeOrDigest(input, async () => {
        throw new Error("offline");
      });
      expect(text).toBe(deterministicDigest(input.entries));
    }),
  );
});
