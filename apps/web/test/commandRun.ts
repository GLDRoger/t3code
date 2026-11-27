import * as Effect from "effect/Effect";
import { AsyncResult } from "effect/reactivity";

/** A command mock's `run` that answers with an `AsyncResult`, as the Effect a command now returns. */
export const commandRun =
  <Args extends ReadonlyArray<unknown>>(run: (...args: Args) => unknown) =>
  (...args: Args): Effect.Effect<unknown, unknown> =>
    Effect.promise(async () => run(...args)).pipe(
      Effect.flatMap((result) =>
        AsyncResult.isAsyncResult(result) && AsyncResult.isSuccess(result)
          ? Effect.succeed(result.value)
          : AsyncResult.isAsyncResult(result) && AsyncResult.isFailure(result)
            ? // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- fails with the mock's own error, as its command would.
              Effect.failCause(result.cause)
            : Effect.die("A command mock answered with no AsyncResult."),
      ),
    );
