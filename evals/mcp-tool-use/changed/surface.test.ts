import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { assert, it } from "@effect/vitest";

import type { McpToolUseCase } from "../run.ts";
import { REVIEWED_RUNNER, runnerHash, surfaceOf } from "./surface.ts";

// Selection refuses any other runner, so a runner change without a review fails here first.
it("pins the runner files in this tree", () => {
  const actual = runnerHash();
  if (actual !== REVIEWED_RUNNER)
    assert.fail(
      `REVIEWED_RUNNER is ${REVIEWED_RUNNER} but the runner files hash to ${actual}: review the runner change, then set the pin`,
    );
});

it.effect("uses the request effort when no changed-case override is given", () =>
  Effect.gen(function* () {
    const kin: McpToolUseCase = {
      id: "kin-owner",
      area: "kin",
      kind: "control",
      pattern: "owner greeting",
      experience: "Reply to the owner",
      setup: { role: "top", world: { kinAgent: true, kinLead: true } },
      prompt: "Hi",
      expect: {},
    };
    const input = { model: "claude-haiku-5-5", shellModel: "claude-haiku-5-5" } as const;
    const kinOnly = yield* surfaceOf({ ...input, cases: [kin] });
    const forced = yield* surfaceOf({ ...input, cases: [kin], effort: "low" });
    const mixed = yield* surfaceOf({
      ...input,
      cases: [kin, { ...kin, id: "ordinary", area: "orchestration", setup: { role: "top" } }],
    });
    assert.equal(kinOnly.effort, "medium");
    assert.equal(forced.effort, "low");
    assert.equal(mixed.effort, "mixed");
    assert.notEqual(forced.cases[kin.id]?.request, kinOnly.cases[kin.id]?.request);
    assert.deepEqual(mixed.cases[kin.id], kinOnly.cases[kin.id]);
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
