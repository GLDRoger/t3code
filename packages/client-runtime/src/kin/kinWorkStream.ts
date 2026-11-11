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
}

export const KIN_WORK_LABEL = "kin:work";
/** A burst of changes (a lead filing twenty tasks) settles for this long before one read. */
const KIN_WORK_SETTLE = Duration.millis(250);
const NOTHING: ReadonlyArray<KinWorkLive> = [];

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
    return resubscribeWhenKinReturns(
      retryWhileKinUnavailable(subscribe("kin.work.subscribe", input)),
      Stream.empty,
      Stream.empty,
    ).pipe(
      Stream.mapEffect((event) =>
        Effect.gen(function* () {
          const emit = (live: KinWorkLive): ReadonlyArray<KinWorkLive> => [live];
          if (held !== null && held.seq >= event.seq) return NOTHING;
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
