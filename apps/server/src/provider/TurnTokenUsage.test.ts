import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";
import {
  claudeLedgerDelta,
  claudeModelLedger,
  normalizeClaudeTurnTokenUsage,
  recordClaudeRequestUsage,
  runningClaudeTurnTokenUsage,
  type ClaudeTurnRequests,
} from "./ClaudeTurnTokenUsage.ts";
import {
  accumulateCodexTurnTokenUsage,
  completeCodexTurnTokenUsage,
  getCodexTurnAccumulator,
  makeCodexTurnTokenUsageState,
} from "./CodexTurnTokenUsage.ts";

const breakdown = (input: number, cached: number, output: number) => ({
  totalTokens: input + output,
  inputTokens: input,
  cachedInputTokens: cached,
  outputTokens: output,
  reasoningOutputTokens: 0,
});
const update = (total: ReturnType<typeof breakdown>, last = total) => ({
  total,
  last,
  modelContextWindow: 200_000,
});

describe("billable native turn usage", () => {
  it("adds each Codex response once and excludes the prior resumed history", () => {
    const state = makeCodexTurnTokenUsageState();
    state.activeTurnId = "turn";
    const first = update(breakdown(1010, 505, 102), breakdown(10, 5, 2));
    accumulateCodexTurnTokenUsage(state, "turn", first);
    accumulateCodexTurnTokenUsage(state, "turn", first);
    accumulateCodexTurnTokenUsage(
      state,
      "turn",
      update(breakdown(1030, 515, 108), breakdown(20, 10, 6)),
    );
    expect(completeCodexTurnTokenUsage(state, "turn", true)).toEqual({
      usageStatus: "complete",
      usageScope: "main_agent",
      hasSubagents: false,
      inputTokens: 30,
      cachedInputTokens: 15,
      outputTokens: 8,
      reasoningTokens: 0,
    });
  });

  it("keeps previous responses when compaction resets Codex cumulative counters", () => {
    const state = makeCodexTurnTokenUsageState();
    state.activeTurnId = "turn";
    accumulateCodexTurnTokenUsage(state, "turn", update(breakdown(100, 40, 20)));
    accumulateCodexTurnTokenUsage(state, "turn", update(breakdown(20, 5, 3)));
    getCodexTurnAccumulator(state, "turn").hasSubagents = true;
    expect(completeCodexTurnTokenUsage(state, "turn", false)).toMatchObject({
      usageStatus: "partial",
      hasSubagents: true,
      inputTokens: 120,
      cachedInputTokens: 45,
      outputTokens: 23,
    });
  });

  it.effect("counts no extra usage when a Codex retry replays an older snapshot", () =>
    Effect.sync(() => {
      const state = makeCodexTurnTokenUsageState();
      state.activeTurnId = "turn-5";
      const first = update(breakdown(1_010, 505, 102), breakdown(10, 5, 2));
      const second = update(breakdown(1_030, 515, 108), breakdown(20, 10, 6));
      for (const frame of [first, second, first, second]) {
        accumulateCodexTurnTokenUsage(state, "turn-5", frame);
      }
      expect(completeCodexTurnTokenUsage(state, "turn-5", true)).toMatchObject({
        inputTokens: 30,
        cachedInputTokens: 15,
        outputTokens: 8,
      });
    }),
  );

  it.effect("does not bill late Codex updates against the next active turn", () =>
    Effect.sync(() => {
      const state = makeCodexTurnTokenUsageState();
      state.activeTurnId = "turn-4";
      accumulateCodexTurnTokenUsage(state, "turn-4", update(breakdown(90, 8, 18)));
      completeCodexTurnTokenUsage(state, "turn-4", true);
      state.activeTurnId = "turn-5";
      accumulateCodexTurnTokenUsage(
        state,
        "turn-5",
        update(breakdown(104, 12, 21), breakdown(4, 2, 1)),
      );
      accumulateCodexTurnTokenUsage(state, "turn-4", update(breakdown(100, 10, 20)));
      accumulateCodexTurnTokenUsage(
        state,
        "turn-5",
        update(breakdown(110, 15, 24), breakdown(6, 3, 3)),
      );
      expect(completeCodexTurnTokenUsage(state, "turn-5", true)).toMatchObject({
        inputTokens: 10,
        cachedInputTokens: 5,
        outputTokens: 4,
      });
      expect(completeCodexTurnTokenUsage(state, "missing", false).usageStatus).toBe("unavailable");
    }),
  );

  it("counts Claude cached input inside total input and bounds thinking output", () => {
    expect(
      normalizeClaudeTurnTokenUsage(
        {
          subtype: "success",
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 40,
            cache_creation_input_tokens: 10,
            output_tokens: 20,
            output_tokens_details: { thinking_tokens: 25 },
          },
        },
        true,
        "completed",
      ),
    ).toEqual({
      usageStatus: "complete",
      usageScope: "main_agent",
      hasSubagents: true,
      inputTokens: 150,
      cachedInputTokens: 40,
      cacheCreationTokens: 10,
      outputTokens: 20,
      reasoningTokens: 20,
    });
  });

  it("adds a running Claude turn's requests once each, with subagents as other usage", () => {
    const requests: ClaudeTurnRequests = new Map();
    const first = {
      input_tokens: 1_000,
      cache_read_input_tokens: 57_000,
      cache_creation_input_tokens: 2_000,
      output_tokens: 1,
    };
    // message_start, message_delta, then the assistant snapshot of the same request.
    recordClaudeRequestUsage(requests, "msg_1", first, false);
    recordClaudeRequestUsage(requests, "msg_1", { ...first, output_tokens: 1_500 }, false);
    recordClaudeRequestUsage(requests, "msg_1", { ...first, output_tokens: 1_500 }, false);
    recordClaudeRequestUsage(
      requests,
      "msg_2",
      { input_tokens: 500, cache_read_input_tokens: 60_000, output_tokens: 700 },
      false,
    );
    const subagent = {
      input_tokens: 10,
      cache_read_input_tokens: 14_652,
      cache_creation_input_tokens: 5_662,
    };
    recordClaudeRequestUsage(requests, "msg_sub", { ...subagent, output_tokens: 56 }, true);
    recordClaudeRequestUsage(requests, "msg_sub", { ...subagent, output_tokens: 4 }, true);
    expect(runningClaudeTurnTokenUsage(requests)).toEqual({
      usageStatus: "partial",
      usageScope: "main_agent",
      hasSubagents: true,
      inputTokens: 120_500,
      cachedInputTokens: 117_000,
      cacheCreationTokens: 2_000,
      outputTokens: 2_200,
      otherUsage: { inputTokens: 20_324, outputTokens: 56 },
    });
    // A turn that ends with no result, or a zeroed one, keeps what its requests used.
    for (const result of [undefined, { subtype: "error_during_execution" as const, usage: {} }]) {
      expect(
        normalizeClaudeTurnTokenUsage(result, true, "interrupted", [], { requests }),
      ).toMatchObject({ usageStatus: "partial", inputTokens: 120_500, outputTokens: 2_200 });
    }
  });

  it.effect(
    "keeps observed Claude subagent usage when a stopped result only measures the main agent",
    () =>
      Effect.sync(() => {
        const requests: ClaudeTurnRequests = new Map();
        recordClaudeRequestUsage(
          requests,
          "msg_3",
          { input_tokens: 100, output_tokens: 20 },
          false,
        );
        recordClaudeRequestUsage(requests, "msg_4", { input_tokens: 60, output_tokens: 12 }, true);
        const result = {
          subtype: "error_during_execution" as const,
          usage: { input_tokens: 100, output_tokens: 20 },
        };
        for (const ledger of [undefined, { inputTokens: 120, outputTokens: 25 }]) {
          expect(
            normalizeClaudeTurnTokenUsage(result, true, "interrupted", [], { requests, ledger }),
          ).toMatchObject({
            usageStatus: "partial",
            inputTokens: 100,
            outputTokens: 20,
            otherUsage: { inputTokens: 60, outputTokens: 12 },
          });
        }
      }),
  );

  it("does not turn a zeroed Claude crash result into a measured zero-cost turn", () => {
    expect(
      normalizeClaudeTurnTokenUsage(
        {
          subtype: "error_during_execution",
          usage: {
            input_tokens: 0,
            output_tokens: 0,
          },
        },
        false,
        "failed",
      ).usageStatus,
    ).toBe("unavailable");
    expect(
      normalizeClaudeTurnTokenUsage(
        {
          subtype: "success",
          usage: {
            input_tokens: 4,
            output_tokens: 2,
          },
        },
        false,
        "interrupted",
      ),
    ).toMatchObject({ usageStatus: "partial", inputTokens: 4, outputTokens: 2 });
  });

  it.each(["failed", "interrupted", "completed"] as const)(
    "retains measured Claude steering usage as partial after %s without final usage",
    (status) => {
      expect(
        normalizeClaudeTurnTokenUsage(
          status === "completed" ? { subtype: "success" } : undefined,
          true,
          status,
          [
            { input_tokens: 100, cache_read_input_tokens: 40, output_tokens: 20 },
            { input_tokens: 5, cache_read_input_tokens: 2, output_tokens: 3 },
          ],
        ),
      ).toEqual({
        usageStatus: "partial",
        usageScope: "main_agent",
        hasSubagents: true,
        inputTokens: 147,
        cachedInputTokens: 42,
        outputTokens: 23,
      });
    },
  );

  it.each([undefined, null, {}])(
    "keeps unavailable Claude usage unavailable without measured segments (%s)",
    (usage) => {
      expect(
        normalizeClaudeTurnTokenUsage({ subtype: "success", usage }, false, "completed")
          .usageStatus,
      ).toBe("unavailable");
    },
  );

  it("retains measured thinking tokens without a final result", () => {
    expect(
      normalizeClaudeTurnTokenUsage(undefined, false, "failed", [
        { input_tokens: 4, output_tokens: 3, output_tokens_details: { thinking_tokens: 2 } },
      ]),
    ).toMatchObject({
      usageStatus: "partial",
      inputTokens: 4,
      outputTokens: 3,
      reasoningTokens: 2,
    });
  });

  it.each([undefined, null])(
    "retains earlier cache counts when a steering segment reports %s",
    (cache) => {
      expect(
        normalizeClaudeTurnTokenUsage(undefined, false, "failed", [
          { input_tokens: 100, cache_read_input_tokens: 40, output_tokens: 20 },
          { input_tokens: 5, cache_read_input_tokens: cache, output_tokens: 3 },
        ]),
      ).toMatchObject({
        usageStatus: "partial",
        inputTokens: 145,
        cachedInputTokens: 40,
        outputTokens: 23,
      });
    },
  );

  it.each(["cache_read_input_tokens", "cache_creation_input_tokens"])(
    "keeps Claude usage partial when the final %s is invalid",
    (field) => {
      expect(
        normalizeClaudeTurnTokenUsage(
          { subtype: "success", usage: { input_tokens: 5, output_tokens: 3, [field]: -1 } },
          false,
          "completed",
          [{ input_tokens: 100, output_tokens: 20, [field]: 40 }],
        ),
      ).toMatchObject({ usageStatus: "partial", inputTokens: 145, outputTokens: 23 });
    },
  );

  it("measures Claude ledger growth only from a known, nondecreasing baseline", () => {
    const ledger = (output: number) =>
      claudeModelLedger({ "claude-sonnet-4-6": { inputTokens: 100, outputTokens: output } });
    expect(claudeLedgerDelta(ledger(10), ledger(25))).toEqual({ inputTokens: 0, outputTokens: 15 });
    expect(claudeLedgerDelta(ledger(25), ledger(10))).toBeUndefined();
    expect(claudeLedgerDelta(undefined, ledger(10))).toBeUndefined();
    expect(claudeModelLedger({})).toBeUndefined();
  });

  it("adds Claude steering segments to the final measured result once", () => {
    expect(
      normalizeClaudeTurnTokenUsage(
        { subtype: "success", usage: { input_tokens: 5, output_tokens: 3 } },
        false,
        "completed",
        [{ input_tokens: 4, output_tokens: 2 }],
      ),
    ).toMatchObject({ usageStatus: "complete", inputTokens: 9, outputTokens: 5 });
  });
});
