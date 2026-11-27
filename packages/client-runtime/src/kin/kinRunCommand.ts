import type { AtomRegistry } from "effect/reactivity";

import { type AtomCommand, runAtomCommand } from "../state/runtime.ts";

/** Starts a Kin command outside Effect. Quiet: each caller shows its own failure. */
export const runKinCommand = <W, A, E>(
  registry: AtomRegistry.AtomRegistry,
  command: AtomCommand<W, A, E>,
  input: W,
) => runAtomCommand(registry, command, input, { reportFailure: false, reportDefect: false });
