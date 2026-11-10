import { assert, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import * as PeerMcpClient from "../../peer/PeerMcpClient.ts";
import * as WorkerEnvironment from "./workerEnvironment.ts";

it.effect("a call to a worker server that never answers fails after its timeout", () =>
  Effect.gen(function* () {
    const env = yield* WorkerEnvironment.make({ stop: Effect.void, start: Effect.void }).pipe(
      Effect.provideService(
        PeerMcpClient.PeerMcpClient,
        PeerMcpClient.PeerMcpClient.of({ call: () => Effect.never }),
      ),
    );
    const environmentId = EnvironmentId.make("worker-env");
    const threadId = ThreadId.make("thread");
    const read = yield* env
      .call(environmentId, WorkerEnvironment.tools.read, { threadId })
      .pipe(Effect.flip, Effect.forkChild);
    const stop = yield* WorkerEnvironment.stopThere(env, {
      environmentId,
      threadId,
      key: "stop",
      reason: "test",
    }).pipe(Effect.flip, Effect.forkChild);
    yield* TestClock.adjust(WorkerEnvironment.STOP_TIMEOUT);
    assert.include(yield* Fiber.join(stop), { code: "orchestration_error" });
    assert.isUndefined(read.pollUnsafe());
    yield* TestClock.adjust(WorkerEnvironment.CALL_TIMEOUT);
    assert.include(yield* Fiber.join(read), { code: "orchestration_error" });
  }),
);

it.effect(
  "an answer there is read with a byte ceiling and refused with an oversized array or string",
  () =>
    Effect.gen(function* () {
      const asked: Array<number | undefined> = [];
      let answer: unknown;
      const env = yield* WorkerEnvironment.make({ stop: Effect.void, start: Effect.void }).pipe(
        Effect.provideService(
          PeerMcpClient.PeerMcpClient,
          PeerMcpClient.PeerMcpClient.of({
            call: (input) =>
              Effect.sync(() => {
                asked.push(input.maxResponseBytes);
                return answer;
              }),
          }),
        ),
      );
      const environmentId = EnvironmentId.make("worker-env");
      const list = () =>
        env.call(environmentId, WorkerEnvironment.tools.capabilities, {}).pipe(Effect.flip);
      answer = { providers: Array.from({ length: 5_000 }, () => ({})) };
      assert.include(yield* list(), {
        message: "The worker environment's answer was larger than Kin reads.",
      });
      answer = { providers: [{ providerInstanceId: "x".repeat(300_000) }] };
      assert.include(yield* list(), {
        message: "The worker environment's answer was larger than Kin reads.",
      });
      assert.deepStrictEqual(asked, [8 * 1024 * 1024, 8 * 1024 * 1024]);
    }),
);
