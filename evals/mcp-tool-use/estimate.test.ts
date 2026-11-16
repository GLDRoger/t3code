import { expect, it } from "@effect/vitest";

import { ASSUMED_SHAPE, caseProblems, sampleCost } from "./estimate.ts";

const tools = new Set(["kin_relay", "record_create", "kin_journal"]);

it("finds a regex that doesn't compile and a needed call to a tool the agent lacks", () => {
  expect(
    caseProblems(
      {
        expect: {
          calls: [{ tool: "kin_relays" }, { tool: "record_create|kin_relay" }],
          textMust: ["(?s).{400}", "(?i:fine)"],
        },
      },
      tools,
    ),
  ).toEqual([
    "regex does not compile: (?s).{400}",
    "names a tool the agent doesn't have: kin_relays",
  ]);
});

it("prices a cached sample below an uncached one", () => {
  const prices = { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 };
  const uncached = sampleCost(prices, 30_000, 1_000, ASSUMED_SHAPE, false, false);
  const cached = sampleCost(prices, 30_000, 1_000, ASSUMED_SHAPE, true, true);
  // 3 calls: 31k, 31.85k and 32.7k input at $4/M, plus 2.1k output at $20/M.
  expect(uncached).toBeCloseTo(0.4242, 4);
  expect(cached).toBeLessThan(uncached / 3);
});
