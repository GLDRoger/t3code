// @effect-diagnostics nodeBuiltinImport:off
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
