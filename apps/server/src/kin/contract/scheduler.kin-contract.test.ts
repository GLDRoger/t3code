import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import * as Scheduler from "../../scheduling/Scheduler.ts";

it.effect("runs registered Kin sources on the five-second tick", () =>
  Effect.gen(function* () {
    const scheduler = yield* Scheduler.Scheduler;
    const runs = yield* Queue.unbounded<number>();
    yield* scheduler.register(
      "kin-contract",
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) => Queue.offer(runs, now)),
        Effect.asVoid,
      ),
    );
    yield* TestClock.adjust("5 seconds");
    assert.include(yield* Queue.takeAll(runs), 5000);
  }).pipe(Effect.provide(Scheduler.layer)),
);
