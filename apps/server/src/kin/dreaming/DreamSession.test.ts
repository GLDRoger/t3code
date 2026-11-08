import { assert, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ThreadId,
  type ProviderApprovalDecision,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { provideDeterministicTestRuntime } from "../../orchestration-v2/testkit/DeterministicRuntime.ts";
import { orchestrationHarness, orgId } from "../lead/WakeupRunner.testkit.ts";
import * as DreamSession from "./DreamSession.ts";

const model = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex-mini" };
const turn = {
  orgId,
  dreamId: "dream_20261108_fixture",
  turn: "extract",
  workspaceRoot: "/private/tmp",
  model,
  text: "Dream",
} as const;

it.effect.each([
  { failed: false, status: "completed" },
  { failed: true, status: "failed" },
] as const)("a dream turn on the fake provider ends $status", ({ failed, status }) =>
  Effect.gen(function* () {
    const session = yield* DreamSession.DreamSession;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const result = yield* session.run(turn);
    assert.strictEqual(result.status, status);
    assert.strictEqual(result.threadId, "kin-dream:dream_20261108_fixture:extract");
    const projection = yield* threads.getThreadProjection(result.threadId);
    assert.strictEqual(projection.thread.modelSelection.model, model.model);
  }).pipe(
    Effect.provide(DreamSession.layer.pipe(Layer.provideMerge(orchestrationHarness({ failed })))),
    provideDeterministicTestRuntime,
  ),
);

it.effect("interrupting a dream turn interrupts its provider run", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const hold = yield* Deferred.make<void>();
    return yield* Effect.gen(function* () {
      const session = yield* DreamSession.DreamSession;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const fiber = yield* session.run(turn).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(fiber);
      const projection = yield* threads.getThreadProjection(
        ThreadId.make("kin-dream:dream_20261108_fixture:extract"),
      );
      assert.notInclude(
        projection.runs.map((run) => run.status),
        "running",
      );
    }).pipe(
      Effect.provide(
        DreamSession.layer.pipe(Layer.provideMerge(orchestrationHarness({ entered, hold }))),
      ),
    );
  }).pipe(provideDeterministicTestRuntime),
);

it.effect("a dream turn may only edit its checkout and declines every other request", () =>
  Effect.gen(function* () {
    const approval = yield* Deferred.make<ProviderApprovalDecision | undefined>();
    const runtimeModes: Array<RuntimeMode> = [];
    return yield* Effect.gen(function* () {
      const session = yield* DreamSession.DreamSession;
      const result = yield* session.run(turn);
      assert.strictEqual(result.status, "completed");
      assert.deepStrictEqual(runtimeModes, ["auto-accept-edits"]);
      assert.strictEqual(yield* Deferred.await(approval), "decline");
    }).pipe(
      Effect.provide(
        DreamSession.layer.pipe(
          Layer.provideMerge(orchestrationHarness({ approval, runtimeModes })),
        ),
      ),
    );
  }).pipe(provideDeterministicTestRuntime),
);
