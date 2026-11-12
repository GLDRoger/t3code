import type { KinWorkSubscribeInput, KinWorkSummary } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { subscribe } from "../rpc/index.ts";
import { resubscribeWhenKinReturns, retryWhileKinUnavailable } from "./kinStreams.ts";
import { kinWorkRefused } from "./kinWork.ts";

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

/**
 * The host's change numbers, each followed by one read of the counts. A number the held counts
 * already cover reads nothing, so a burst costs one read, and reconnecting costs none unless
 * something changed meanwhile. Fails only when the host refuses this viewer.
 */
export function kinWorkLiveStream<E, R>(
  input: KinWorkSubscribeInput,
  readSummary: (input: KinWorkSubscribeInput) => Effect.Effect<KinWorkSummary, E, R>,
) {
  return Stream.suspend(() => {
    let held: KinWorkSummary | null = null;
    let first = true;
    let named = KIN_WORK_NOTHING_NAMED;
    let last: KinWorkLive | null = null;
    return resubscribeWhenKinReturns(
      retryWhileKinUnavailable(subscribe("kin.work.subscribe", input)),
      Stream.empty,
      Stream.empty,
    ).pipe(
      Stream.mapEffect((event) =>
        Effect.gen(function* () {
          const emit = (
            live: Pick<KinWorkLive, "seq" | "summary" | "failed">,
          ): ReadonlyArray<KinWorkLive> => [
            (last = { ...live, changed: named.changed, unnamed: named.unnamed }),
          ];
          const before = named;
          named = kinWorkNote(before, event);
          const news = named !== before;
          // Counts read during a burst already cover this number; only which task it was is new.
          if (held !== null && held.seq >= event.seq)
            return news && last !== null ? emit(last) : NOTHING;
          if (!first) yield* Effect.sleep(KIN_WORK_SETTLE);
          first = false;
          const read = yield* Effect.result(readSummary(input));
          if (read._tag === "Failure") {
            if (kinWorkRefused(read.failure)) return yield* Effect.fail(read.failure);
            return emit({ seq: event.seq, summary: held, failed: true });
          }
          held = read.success;
          return emit({ seq: Math.max(event.seq, held.seq), summary: held, failed: false });
        }),
      ),
      Stream.flattenIterable,
    );
  });
}
