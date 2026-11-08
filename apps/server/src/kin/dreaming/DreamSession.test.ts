import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderApprovalDecision,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { provideDeterministicTestRuntime } from "../../orchestration-v2/testkit/DeterministicRuntime.ts";
import { orchestrationHarness, orgId } from "../lead/WakeupRunner.testkit.ts";
import * as DreamSession from "./DreamSession.ts";

const model = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-haiku-4-5" };
const codex = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex-mini" };
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
    Effect.provide(
      DreamSession.layer.pipe(Layer.provideMerge(orchestrationHarness({ claude: true, failed }))),
    ),
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
        DreamSession.layer.pipe(
          Layer.provideMerge(orchestrationHarness({ claude: true, entered, hold })),
        ),
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
          Layer.provideMerge(orchestrationHarness({ claude: true, approval, runtimeModes })),
        ),
      ),
    );
  }).pipe(provideDeterministicTestRuntime),
);

it.effect(
  "a request the dream cannot decline ends the run instead of waiting out the timeout",
  () =>
    Effect.gen(function* () {
      const approval = yield* Deferred.make<ProviderApprovalDecision | undefined>();
      const undeclined = Deferred.makeUnsafe<void>();
      const logger = Logger.make(({ message }) => {
        if (String(message).includes("could not decline"))
          Deferred.doneUnsafe(undeclined, Effect.void);
      });
      return yield* Effect.gen(function* () {
        const session = yield* DreamSession.DreamSession;
        const fiber = yield* session.run(turn).pipe(Effect.forkScoped);
        yield* Deferred.await(undeclined);
        yield* TestClock.adjust("16 minutes");
        assert.strictEqual((yield* Fiber.join(fiber)).status, "failed");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            DreamSession.layer.pipe(
              Layer.provideMerge(
                orchestrationHarness({
                  claude: true,
                  approval,
                  requestCapability: "not_resumable",
                }),
              ),
            ),
            Logger.layer([logger], { mergeWithExisting: false }),
          ),
        ),
      );
    }).pipe(provideDeterministicTestRuntime),
);

it.effect.each([
  { name: "a Codex instance", claudeLaunchArgs: undefined, reason: "only on Claude" },
  {
    name: "a Claude instance launched with --permission-mode",
    claudeLaunchArgs: "--permission-mode bypassPermissions",
    reason: "--permission-mode",
  },
  {
    name: "a Claude instance launched with --dangerously-skip-permissions",
    claudeLaunchArgs: "--verbose --dangerously-skip-permissions",
    reason: "--dangerously-skip-permissions",
  },
] as const)("a dream refuses $name", ({ claudeLaunchArgs, reason }) =>
  Effect.gen(function* () {
    const session = yield* DreamSession.DreamSession;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const exit = yield* session
      .run(claudeLaunchArgs === undefined ? { ...turn, model: codex } : turn)
      .pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(exit));
    const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
    assert.instanceOf(error, DreamSession.DreamRefused);
    assert.include(error.message, reason);
    const launched = yield* threads
      .getThreadProjection(ThreadId.make("kin-dream:dream_20261108_fixture:extract"))
      .pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(launched));
  }).pipe(
    Effect.provide(
      DreamSession.layer.pipe(
        Layer.provideMerge(
          orchestrationHarness({
            claude: claudeLaunchArgs !== undefined,
            ...(claudeLaunchArgs === undefined
              ? {}
              : {
                  settings: {
                    providerInstances: {
                      [ProviderInstanceId.make("claudeAgent")]: {
                        driver: ProviderDriverKind.make("claudeAgent"),
                        config: { launchArgs: claudeLaunchArgs },
                      },
                    },
                  },
                }),
          }),
        ),
      ),
    ),
    provideDeterministicTestRuntime,
  ),
);
