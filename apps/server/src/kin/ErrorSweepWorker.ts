import { activeReliabilityDir, tickErrorSweep } from "@t3tools/kin-reliability";
import { chaosSeams } from "./chaosSeams.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Scheduler from "../scheduling/Scheduler.ts";

/**
 * Hourly error sweep. The scheduler ticks every few seconds; the sweep
 * body runs only when its own interval has elapsed. Fix lanes are
 * `delegate_task` payloads in the outbox. Upstream `delegate_task` needs
 * an active parent run, so this worker does not dispatch them itself.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const scheduler = yield* Scheduler.Scheduler;
    const dir = activeReliabilityDir();
    if (dir === null) {
      yield* scheduler.register("kin-error-sweep", Effect.void);
      return;
    }
    yield* scheduler.register(
      "kin-error-sweep",
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const result = tickErrorSweep({ dir, nowMs: DateTime.toEpochMillis(now) });
        if (result.ran && result.opened > 0) {
          yield* Effect.logInfo("kin.error-sweep.opened", {
            opened: result.opened,
            seamsArmed: chaosSeams.chaosActive({ env: process.env }),
          });
        }
      }),
    );
  }),
);
