import { assert, it } from "@effect/vitest";

import { REVIEWED_RUNNER, runnerHash } from "./surface.ts";

// Selection refuses any other runner, so a runner change without a review fails here first.
it("pins the runner files in this tree", () => {
  const actual = runnerHash();
  if (actual !== REVIEWED_RUNNER)
    assert.fail(
      `REVIEWED_RUNNER is ${REVIEWED_RUNNER} but the runner files hash to ${actual}: review the runner change, then set the pin`,
    );
});
