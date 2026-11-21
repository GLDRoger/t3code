import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { kinCaughtUp } from "./kinCaughtUp.ts";

function setup() {
  const asked: Array<Deferred.Deferred<{ readonly seq: number }>> = [];
  const read = Atom.make(
    Effect.gen(function* () {
      const answer = Deferred.makeUnsafe<{ readonly seq: number }>();
      asked.push(answer);
      return yield* Deferred.await(answer);
    }),
  ).pipe(Atom.keepAlive);
  const live = Atom.make<number | null>(null);
  const registry = AtomRegistry.make();
  const atom = kinCaughtUp(read, live, (answer) => answer.seq);
  const stop = registry.mount(atom);
  /** The host answers the read in flight; settled once the screen holds it, or reads again. */
  const answer = (seq: number) => {
    const out = asked.length;
    const settled = new Promise((resolve) => {
      const check = () => {
        const result = registry.get(atom);
        if (!AsyncResult.isSuccess(result) || result.value.seq !== seq) return;
        if (result.waiting && asked.length === out) return;
        stopWatching();
        resolve(result.value);
      };
      const stopWatching = registry.subscribe(atom, check);
    });
    Deferred.doneUnsafe(asked.at(-1)!, Effect.succeed({ seq }));
    return settled;
  };
  const reads = () => asked.length;
  const waiting = () => {
    const result = registry.get(atom);
    return AsyncResult.isInitial(result) || result.waiting;
  };
  return { registry, live, atom, answer, reads, waiting, stop };
}

describe("kinCaughtUp", () => {
  it("reads again once per change number the answer is behind, never while one is in flight", async () => {
    const { registry, live, answer, reads, waiting, stop } = setup();
    expect(await answer(1)).toEqual({ seq: 1 });
    registry.set(live, 1);
    expect(reads()).toBe(1);

    registry.set(live, 2);
    expect([reads(), waiting()]).toEqual([2, true]);
    // The stream moves again while that read is out: no second read until it is back.
    registry.set(live, 3);
    expect(reads()).toBe(2);
    // Back still behind 3: read once more for 3, and only once even if still behind.
    expect(await answer(2)).toEqual({ seq: 2 });
    expect(reads()).toBe(3);
    expect(await answer(2)).toEqual({ seq: 2 });
    expect([reads(), waiting()]).toEqual([3, false]);

    registry.set(live, 4);
    expect(await answer(4)).toEqual({ seq: 4 });
    registry.set(live, 4);
    expect(reads()).toBe(4);
    stop();
  });

  it("gives one atom per read, so every screen on it shares its reads", () => {
    const { atom, live } = setup();
    const read = Atom.make(AsyncResult.success({ seq: 1 }));
    expect(kinCaughtUp(read, live, (one) => one.seq)).toBe(
      kinCaughtUp(read, live, (one) => one.seq),
    );
    expect(atom).not.toBe(kinCaughtUp(read, live, (one) => one.seq));
  });
});
