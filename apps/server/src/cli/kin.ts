import { runKinCli } from "@t3tools/kin-reliability";
import * as Effect from "effect/Effect";
import { Argument, Command } from "effect/cli";

/**
 * `t3 kin verify|chaos|sweep`. Lane 1 owns the top-level `kin` binary;
 * this subcommand is the reliability entry on the current `t3` CLI.
 */
export const kinCommand = Command.make("kin", {
  args: Argument.String("args").pipe(
    Argument.variadic(),
    Argument.withDescription("verify, chaos, or sweep, plus that command's flags."),
  ),
}).pipe(
  Command.withDescription("Kin reliability: kin verify (V0–V4), chaos, and the error sweep."),
  Command.withHandler(({ args }) =>
    Effect.promise(() => runKinCli(args)).pipe(
      Effect.tap((code) =>
        Effect.sync(() => {
          if (code !== 0) {
            process.exitCode = code;
          }
        }),
      ),
      Effect.asVoid,
    ),
  ),
);
