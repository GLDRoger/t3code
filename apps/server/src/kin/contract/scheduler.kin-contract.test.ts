import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import * as Scheduler from "../../scheduling/Scheduler.ts";

it.effect("runs registered Kin sources at startup and on the five-second tick", () =>
  Effect.gen(function* () {
    const scheduler = yield* Scheduler.Scheduler;
    const runs = yield* Queue.unbounded<string>();
    yield* scheduler.register("kin-contract", Queue.offer(runs, "due").pipe(Effect.asVoid));
    assert.equal(yield* Queue.take(runs), "due");
    yield* TestClock.adjust("5 seconds");
    assert.equal(yield* Queue.take(runs), "due");
    assert.equal(yield* Queue.size(runs), 0);
  }).pipe(Effect.provide(Scheduler.layer)),
);
