import { layer as archivistKeeperLayer } from "@t3tools/keeper/archivist";
import { activeReliabilityDir, tickErrorSweep } from "@t3tools/kin-reliability";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Scheduler from "../scheduling/Scheduler.ts";
import { tickArchivists } from "./ArchivistTick.ts";
import { chaosSeams } from "./chaosSeams.ts";
import { layer as cheapSummarizerLayer } from "./cheapSummarizer.ts";
import { dispatchFixLanes } from "./FixLaneDispatch.ts";
import * as HouseLineKeeper from "./houseLineKeeper.ts";

/**
 * Hourly error sweep and archivist look. The scheduler ticks every few
 * seconds; each body runs on its own interval or count gate.
 * Live chaos canary and weekly tiers stay off unless KIN_CHAOS_LIVE=1.
 */
const make = Effect.gen(function* () {
  const scheduler = yield* Scheduler.Scheduler;
  const dir = activeReliabilityDir();
  yield* scheduler.register(
    "kin-error-sweep",
    dir === null
      ? Effect.void
      : Effect.gen(function* () {
          const now = yield* DateTime.now;
          const result = tickErrorSweep({ dir, nowMs: DateTime.toEpochMillis(now) });
          if (result.ran && result.requests.length > 0) {
            const dispatched = yield* dispatchFixLanes(result.requests);
            yield* Effect.logInfo("kin.error-sweep.opened", {
              opened: result.opened,
              dispatched: dispatched.dispatched,
              skipped: dispatched.skipped,
              seamsArmed: chaosSeams.chaosActive({ env: process.env }),
            });
          }
        }),
  );
  yield* scheduler.register("kin-archivist", tickArchivists());
});

export const layer = Layer.effectDiscard(make).pipe(
  Layer.provide(
    archivistKeeperLayer.pipe(
      Layer.provide(HouseLineKeeper.layer),
      Layer.provide(cheapSummarizerLayer),
    ),
  ),
);
