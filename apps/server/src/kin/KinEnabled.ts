import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

export class KinEnabled extends Context.Service<
  KinEnabled,
  {
    readonly enabled: boolean;
    readonly reportFailure: (cause: Cause.Cause<unknown>) => Effect.Effect<void>;
  }
>()("t3/kin/KinEnabled") {}

export const layer = Layer.effect(
  KinEnabled,
  Effect.gen(function* () {
    const enabled = yield* Config.Boolean("KIN_ENABLED").pipe(
      Config.withDefault(false),
      Effect.catch((error) =>
        Effect.logError("Kin disabled: invalid KIN_ENABLED.", error.message).pipe(Effect.as(false)),
      ),
    );
    const reported = yield* Ref.make(false);
    return {
      enabled,
      reportFailure: Effect.fn("KinEnabled.reportFailure")(function* (cause) {
        if (!(yield* Ref.getAndSet(reported, true)))
          yield* Effect.logError("Kin disabled: initialization failed.", Cause.pretty(cause));
      }),
    };
  }),
);
