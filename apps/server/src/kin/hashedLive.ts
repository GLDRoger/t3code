import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

/**
 * Kin's hashed live reads (`kin.money.subscribe`, `kin.pulse.subscribe`): T3's skip-unchanged for
 * derived state. The first build is sent whole, or as `current` when the client names it held;
 * after that only what differs, each event carrying the hash of what it leaves the client holding.
 * Who may read stays in each stream's build, checked again every time it runs.
 */

/** Names what a screen holds by its text: cyrb53, as hex. */
export const viewHash = (text: string) => {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
};

export type HashedEvent<Snapshot, Change> =
  | Snapshot
  | { readonly _tag: "current"; readonly hash: string }
  | (Change & { readonly _tag: "changed"; readonly hash: string });

/** One subscriber's side: what it was last sent, and what to send for the next build. */
export const hashedLive = <Held, Change extends object, Snapshot>(spec: {
  /** The hash the client says it holds from an earlier session. */
  readonly held: string | undefined;
  readonly hash: (held: Held) => string;
  readonly snapshot: (held: Held, hash: string) => Snapshot;
  /** What differs from `before` in `next`, or null when nothing a screen shows does. */
  readonly diff: (before: Held, next: Held) => Change | null;
  /** `before` with `change` applied, as the client applies it. */
  readonly apply: (before: Held, change: Change) => Held;
}) => {
  let sent: { readonly held: Held } | null = null;
  const first = (built: Held): HashedEvent<Snapshot, Change> => {
    sent = { held: built };
    const hash = spec.hash(built);
    return spec.held === hash ? { _tag: "current", hash } : spec.snapshot(built, hash);
  };
  const next = (built: Held): ReadonlyArray<HashedEvent<Snapshot, Change>> => {
    if (sent === null) return [first(built)];
    const change = spec.diff(sent.held, built);
    if (change === null) return [];
    const held = spec.apply(sent.held, change);
    sent = { held };
    return [{ ...change, _tag: "changed", hash: spec.hash(held) }];
  };
  return { first, next };
};

/**
 * Runs `build` over `changes`: a burst during a build is one more build, of everything it asked
 * for. `wait` holds a change back a moment for the rest of its burst. Untraced: the builds inside
 * carry the spans.
 */
export const coalesced = <D, A, E, R, E2, R2>(
  changes: Stream.Stream<D, E, R>,
  build: (asked: ReadonlyArray<D>) => Effect.Effect<ReadonlyArray<A>, E2, R2>,
  wait?: (asked: ReadonlyArray<D>) => Duration.Duration | undefined,
): Stream.Stream<A, E | E2, R | R2> => {
  let pending: Array<D> = [];
  return changes.pipe(
    Stream.map((one) => {
      pending.push(one);
    }),
    Stream.buffer({ capacity: 1, strategy: "sliding" }),
    Stream.mapEffect(
      Effect.fnUntraced(function* () {
        const none: ReadonlyArray<A> = [];
        if (pending.length === 0) return none;
        const pause = wait?.(pending);
        if (pause !== undefined) yield* Effect.sleep(pause);
        const asked = pending;
        pending = [];
        return yield* build(asked);
      }),
    ),
    Stream.flattenIterable,
  );
};
