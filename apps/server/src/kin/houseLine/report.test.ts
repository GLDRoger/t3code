import { assert, it } from "@effect/vitest";

import { firstReadsMatchLog, parseLaneReport } from "./report.ts";

it("parses First reads and Misleading notes", () => {
  const parsed = parseLaneReport("First reads: will:a, note:b\nMisleading notes: none\n");
  assert.deepEqual(parsed.firstReads, [
    { kind: "will", id: "a" },
    { kind: "note", id: "b" },
  ]);
  assert.deepEqual(parsed.misleading, []);
  assert.isTrue(
    firstReadsMatchLog(parsed.firstReads, [
      { kind: "note", id: "b" },
      { kind: "will", id: "a" },
    ]),
  );
  assert.isFalse(firstReadsMatchLog(parsed.firstReads, [{ kind: "will", id: "a" }]));
});

it("rejects a report that is missing its lines", () => {
  assert.throws(() => parseLaneReport("I read the code."));
  assert.throws(() => parseLaneReport("First reads: later\nMisleading notes: none\n"));
});
