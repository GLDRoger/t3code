import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

// Start services at the fixture date so recurring work does not replay from 1970.
export const withFixtureClock =
  (time: number) =>
  <A, E, R>(layer: Layer.Layer<A, E, R>) =>
    Layer.unwrap(TestClock.setTime(time).pipe(Effect.as(layer)));
