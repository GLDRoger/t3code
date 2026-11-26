// @effect-diagnostics nodeBuiltinImport:off
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as NodeFS from "node:fs";
import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { TURN_DIVIDER } from "../../apps/server/src/kin/lead/LeadPrompt.ts";
import { fillKinRules, kinLegacyHeaderPlace, kinSessionSplit } from "./kin.ts";
import { McpToolUseCase } from "./run.ts";

const readCases = (name: string) =>
  NodeFS.readFileSync(new URL(`./cases/${name}`, import.meta.url), "utf8")
    .trim()
    .split("\n")
    .map(Schema.decodeUnknownSync(Schema.fromJsonString(McpToolUseCase)));

const headerLines = (block: string) => {
  const lines = block.split("\n");
  return lines.every((line) => kinLegacyHeaderPlace(line) !== undefined) ? lines : [block];
};

it("places every legacy wake-up block exactly once, splitting the server's tagged header lines", () => {
  const failures: string[] = [];
  for (const name of NodeFS.readdirSync(new URL("./cases/", import.meta.url))) {
    if (!/^kin.*\.ndjson$/.test(name)) continue;
    for (const testCase of readCases(name)) {
      if (!testCase.prompt.includes(TURN_DIVIDER)) continue;
      const prompt = fillKinRules(testCase.prompt, testCase.setup.world);
      try {
        const { standing, delta, message } = kinSessionSplit(prompt);
        const blocks = [standing, delta, message]
          .filter(Boolean)
          .flatMap((text) => text.split("\n\n").flatMap(headerLines))
          .toSorted();
        const expected = prompt
          .split("\n\n")
          .filter((block) => block !== TURN_DIVIDER)
          .flatMap(headerLines)
          .toSorted();
        assert.deepEqual(blocks, expected);
      } catch (error) {
        failures.push(`${testCase.id}: ${String(error)}`);
      }
    }
  }
  assert.deepEqual(failures, []);
});

// Captured from mine/kin at 41f8a4f4705 before adding the layout flag.
const legacyRequestPin = "2fc2cb5b182755fd7a3896a5a2dbfb4460815d16381e7aeee81d9d0be4d7a93a";
const sessionRequestPin = "0fcf900fd03fb151570f3052253b68a12538eca95e8201d00c95b5ad0c154afc";
const pinnedIds = [
  "kin-lead-rereads-github-hint",
  "kin-lead-uses-display-name",
  "kin-lead-no-second-answer-after-end",
  "kin-lead-hi-gets-one-line",
  "kin-lead-capabilities-in-plain-words",
  "kin-lead-refused-work-is-not-a-setup-request",
  "kin-lead-notice-own-activity-is-silent",
  "kin-lead-notice-failing-check-reaches-owner",
  "kin-lead-reminder-is-only-its-subject",
  "kin-lead-get-back-does-the-check",
];

it.each([
  ["legacy", legacyRequestPin],
  ["session", sessionRequestPin],
] as const)("pins ten Kin dry-run requests in the %s layout", (layout, pin) => {
  const requests = execFileSync(
    process.execPath,
    [
      "mcp-tool-use/run.ts",
      "--dry-run",
      "--no-step-limit",
      "--kin-layout",
      layout,
      "--cases",
      "mcp-tool-use/cases/kin.ndjson",
      "--case",
      pinnedIds.join(","),
    ],
    { cwd: new URL("..", import.meta.url) },
  );
  assert.lengthOf(requests.toString().trimEnd().split("\n"), 10);
  assert.equal(createHash("sha256").update(requests).digest("hex"), pin);
});
