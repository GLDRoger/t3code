import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";

export const DEV_CLOCK_FILE = "kin-dev-clock.json";

const decodeFile = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ offsetMs: Schema.Finite })),
);

/** Reads the file now rather than on the next second; does nothing where the clock is real. */
export class KinDevClock extends Context.Service<
  KinDevClock,
  { readonly reload: Effect.Effect<void> }
>()("t3/kin/DevClock/KinDevClock") {}

/** `base` moved forward by an offset that only grows; sleeps end early when the offset jumps. */
const shifted = Effect.fn("KinDevClock.shifted")(function* (base: Clock.Clock) {
  let offsetMs = 0;
  let moved = yield* Deferred.make<void>();
  const nowMs = () => base.currentTimeMillisUnsafe() + offsetMs;
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: nowMs,
    currentTimeMillis: Effect.sync(nowMs),
    currentTimeNanosUnsafe: () => base.currentTimeNanosUnsafe() + BigInt(offsetMs) * 1_000_000n,
    currentTimeNanos: Effect.sync(
      () => base.currentTimeNanosUnsafe() + BigInt(offsetMs) * 1_000_000n,
    ),
    monotonicTimeNanosUnsafe: () => base.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: base.monotonicTimeNanos,
    sleep: (duration) =>
      Effect.suspend(() => {
        const until = nowMs() + Duration.toMillis(duration);
        const wait: Effect.Effect<void> = Effect.suspend(() => {
          const left = until - nowMs();
          return left <= 0
            ? Effect.void
            : Effect.raceFirst(base.sleep(Duration.millis(left)), Deferred.await(moved)).pipe(
                Effect.andThen(wait),
              );
        });
        return wait;
      }),
  };
  const moveTo = Effect.fn("KinDevClock.moveTo")(function* (next: number) {
    if (next <= offsetMs) return;
    offsetMs = next;
    const was = moved;
    moved = yield* Deferred.make<void>();
    yield* Deferred.succeed(was, undefined);
  });
  return { clock, moveTo };
});

/**
 * `kin-verify` dev servers (`devUrl` and `KIN_DEV_CLOCK=1`): Kin's now is the real time plus the
 * offset in `<stateDir>/kin-dev-clock.json`, which `kv clock` only moves forward. Elsewhere,
 * including any built server, Kin keeps the clock it was given.
 */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    // Optional, so the tests of layers that carry this one need no server around them.
    const config = Option.getOrUndefined(yield* Effect.serviceOption(ServerConfig));
    const fs = Option.getOrUndefined(yield* Effect.serviceOption(FileSystem.FileSystem));
    const path = Option.getOrUndefined(yield* Effect.serviceOption(Path.Path));
    const on = yield* Config.Boolean("KIN_DEV_CLOCK").pipe(Config.withDefault(false));
    if (!on || config?.devUrl === undefined || fs === undefined || path === undefined)
      return Layer.succeed(KinDevClock, { reload: Effect.void });
    const file = path.join(config.stateDir, DEV_CLOCK_FILE);
    const base = yield* Clock.Clock;
    const { clock, moveTo } = yield* shifted(base);
    const reload = fs.readFileString(file).pipe(
      Effect.flatMap(decodeFile),
      Effect.flatMap((read) => moveTo(read.offsetMs)),
      Effect.ignore,
    );
    yield* reload;
    yield* Effect.logWarning(`Kin's clock follows ${file}`);
    return Layer.mergeAll(
      Layer.succeed(Clock.Clock, clock),
      Layer.succeed(KinDevClock, { reload }),
      Layer.effectDiscard(
        base
          .sleep(Duration.seconds(1))
          .pipe(Effect.andThen(reload), Effect.forever, Effect.forkScoped),
      ),
    );
  }),
);
