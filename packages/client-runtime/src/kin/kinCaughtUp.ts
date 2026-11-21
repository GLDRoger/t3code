import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

const caught = new WeakMap<object, Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>>>();

/**
 * `read`, kept up with the host's live change number: once its settled answer is behind `live`,
 * it is read again, at most once per live number, so a host answering behind can't loop. One per
 * `read`: the first `live` given for it stays.
 */
export function kinCaughtUp<A, E>(
  read: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  live: Atom.Atom<number | null>,
  seqOf: (answer: A) => number,
): Atom.Atom<AsyncResult.AsyncResult<A, E>> {
  const held = caught.get(read);
  if (held !== undefined) return held as Atom.Atom<AsyncResult.AsyncResult<A, E>>;
  let asked: number | null = null;
  const atom = Atom.make((get) => {
    const result = get(read);
    const now = get(live);
    const answer = Option.getOrNull(AsyncResult.value(result));
    if (
      now !== null &&
      answer !== null &&
      !result.waiting &&
      seqOf(answer) < now &&
      asked !== now
    ) {
      asked = now;
      get.refresh(read);
    }
    return result;
  });
  caught.set(read, atom);
  return atom;
}
