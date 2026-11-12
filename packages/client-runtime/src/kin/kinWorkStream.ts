import type { KinWorkSubscribeInput, KinWorkSummary } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { subscribe } from "../rpc/index.ts";
import { resubscribeWhenKinReturns, retryWhileKinUnavailable } from "./kinStreams.ts";
import { kinWorkFailuresOf, kinWorkRefused } from "./kinWork.ts";

/** Work as the host last described it: its change number, and the counts read at that number. */
export interface KinWorkLive {
  /** The latest change number the host announced. A list or task read at a lower one is behind. */
  readonly seq: number;
  /** Null until the counts have been read once. */
  readonly summary: KinWorkSummary | null;
  /** The last read of the counts failed; what is held is older than `seq`. */
  readonly failed: boolean;
  /** The latest change number the host named each task with, for the tasks it named lately. */
  readonly changed: Readonly<Record<string, number>>;
  /**
   * The latest change number that came without a task's name and was news: something changed
   * while this was away, or the host is an older one that names nothing. 0 with none.
   */
  readonly unnamed: number;
}

export const KIN_WORK_LABEL = "kin:work";
/** A burst of changes (a lead filing twenty tasks) settles for this long before one read. */
const KIN_WORK_SETTLE = Duration.millis(250);
const NOTHING: ReadonlyArray<KinWorkLive> = [];
/** How many tasks' latest change numbers are remembered; one open task needs only its own. */
const KIN_WORK_NAMED_CAP = 64;

/** Which tasks the host has said changed, and the last change it announced without saying which. */
export interface KinWorkNamed {
  /** The highest change number heard; null before the first. */
  readonly latest: number | null;
  readonly changed: KinWorkLive["changed"];
  readonly unnamed: number;
}

export const KIN_WORK_NOTHING_NAMED: KinWorkNamed = { latest: null, changed: {}, unnamed: 0 };

/** Takes in one announcement. Returns `held` itself when it says nothing new about any task. */
export function kinWorkNote(
  held: KinWorkNamed,
  event: { readonly seq: number; readonly key?: string | undefined },
): KinWorkNamed {
  const latest = Math.max(held.latest ?? 0, event.seq);
  if (event.key === undefined) {
    // The first number ever is where things stand, not a change.
    return held.latest === null || event.seq <= held.latest
      ? held.latest === latest
        ? held
        : { ...held, latest }
      : { ...held, latest, unnamed: event.seq };
  }
  const { key } = event;
  if ((held.changed[key] ?? 0) >= event.seq) return held;
  const others = Object.entries(held.changed).filter(([name]) => name !== key);
  return {
    ...held,
    latest,
    changed: Object.fromEntries([...others.slice(1 - KIN_WORK_NAMED_CAP), [key, event.seq]]),
  };
}

/** Asks the counts stream to read again now, inside the running stream. */
export const KIN_WORK_RETRY = { _tag: "retry" } as const;
type KinWorkChange = { readonly seq: number; readonly key?: string | undefined };

/** A read cut off with its connection can stay pending; past this it counts as failed. */
export const KIN_WORK_READ_TIMEOUT = Duration.seconds(20);

/**
 * The host's change numbers, each followed by one read of the counts. A number the held counts
 * already cover reads nothing, so a burst costs one read, and reconnecting costs none unless
 * something changed meanwhile. Fails only when the host refuses this viewer.
 */
export function kinWorkLiveStream<E, R, RR = never>(
  input: KinWorkSubscribeInput,
  readSummary: (input: KinWorkSubscribeInput) => Effect.Effect<KinWorkSummary, E, R>,
  /** Each one reads the counts again, keeping what is held: the retry after a failed read. */
  retries: Stream.Stream<unknown, never, RR> = Stream.never,
) {
  return kinWorkLiveFold(
    Stream.merge(
      resubscribeWhenKinReturns(
        retryWhileKinUnavailable(subscribe("kin.work.subscribe", input)),
        Stream.empty,
        Stream.empty,
      ),
      retries.pipe(Stream.map(() => KIN_WORK_RETRY)),
    ),
    () => readSummary(input),
  );
}

/** `kinWorkLiveStream` over any source of changes and retries. */
export function kinWorkLiveFold<E, R, EE, RR>(
  events: Stream.Stream<KinWorkChange | typeof KIN_WORK_RETRY, EE, RR>,
  readSummary: () => Effect.Effect<KinWorkSummary, E, R>,
) {
  return Stream.suspend(() => {
    let held: KinWorkSummary | null = null;
    let first = true;
    let named = KIN_WORK_NOTHING_NAMED;
    let last: KinWorkLive | null = null;
    return events.pipe(
      Stream.mapEffect((event) =>
        Effect.gen(function* () {
          const emit = (
            live: Pick<KinWorkLive, "seq" | "summary" | "failed">,
          ): ReadonlyArray<KinWorkLive> => [
            (last = { ...live, changed: named.changed, unnamed: named.unnamed }),
          ];
          const retry = "_tag" in event;
          if (retry && named.latest === null) return NOTHING;
          const seq = retry ? (named.latest ?? 0) : event.seq;
          const before = named;
          if (!retry) named = kinWorkNote(before, event);
          const news = named !== before;
          // Counts read during a burst already cover this number; only which task it was is new.
          if (!retry && held !== null && held.seq >= seq)
            return news && last !== null ? emit(last) : NOTHING;
          if (!first && !retry) yield* Effect.sleep(KIN_WORK_SETTLE);
          first = false;
          // A dropped socket interrupts the read in flight, or leaves it pending. Either is a failed
          // read, not the stream's end, or the next session is never subscribed to.
          const read = yield* Effect.exit(
            readSummary().pipe(Effect.timeout(KIN_WORK_READ_TIMEOUT)),
          );
          if (read._tag === "Failure") {
            const refusal = kinWorkFailuresOf(read.cause).find(kinWorkRefused);
            if (refusal !== undefined) return yield* Effect.fail(refusal);
            return emit({ seq, summary: held, failed: true });
          }
          held = read.value;
          return emit({ seq: Math.max(seq, held.seq), summary: held, failed: false });
        }),
      ),
      Stream.flattenIterable,
    );
  });
}
