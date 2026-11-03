import { runKinCli } from "@t3tools/kin-reliability";
import * as Effect from "effect/Effect";
import { Argument, Command } from "effect/cli";

const runKinArgs = (args: readonly string[]): Effect.Effect<void> =>
  Effect.promise(() => runKinCli(args)).pipe(
    Effect.tap((code) =>
      Effect.sync(() => {
        if (code !== 0) process.exitCode = code;
      }),
    ),
    Effect.asVoid,
  );

/** `t3 kin init|verify|chaos|sweep`. Invoking the `kin` binary rewrites those names onto this command. */
export const kinCommand = Command.make("kin", {
  args: Argument.String("args").pipe(
    Argument.variadic(),
    Argument.withDescription("init, verify, chaos, or sweep, plus that command's flags."),
  ),
}).pipe(
  Command.withDescription("Kin: init, verify (V0–V4), chaos, and the error sweep."),
  Command.withHandler(({ args }) => runKinArgs(args)),
);
