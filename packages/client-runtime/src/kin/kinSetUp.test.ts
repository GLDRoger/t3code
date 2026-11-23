import { describe, expect, it } from "vite-plus/test";

import { kinSetUpChief, kinWhatWeSellAnswer } from "./kinSetUp.ts";

const OUTLINE = "# What we sell\n\n## Who is a good customer for us\nThe kind of business.\n";

describe("kinWhatWeSellAnswer", () => {
  it.each([
    [
      "reads the line the host wrote above the outline",
      "# What we sell\n\nHandmade candles, sold online to gift buyers\n\n## Who is a good customer for us\n",
      "Handmade candles, sold online to gift buyers",
    ],
    ["finds none in Kin's bare outline", OUTLINE, null],
    ["finds none without a title", "Handmade candles\n## Who\n", null],
    [
      "keeps an edited opening as one line",
      "# What we sell\nCandles\nand diffusers\n### Scents\n",
      "Candles and diffusers",
    ],
  ] as const)("%s", (_name, body, answer) => {
    expect(kinWhatWeSellAnswer(body)).toBe(answer);
  });
});

it("asks the live Chief of staff, the same one on every client", () => {
  const leads = [
    { agentId: "lead-c", domain: "chief-of-staff" },
    { agentId: "lead-a", domain: "chief-of-staff", retired: "2026-11-01" },
    { agentId: "lead-b", domain: "chief-of-staff" },
    { agentId: "lead-0", domain: "finance" },
  ];
  expect(kinSetUpChief(leads)?.agentId).toBe("lead-b");
  expect(kinSetUpChief(leads.slice(3))).toBeNull();
});
