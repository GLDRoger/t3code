import { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

export function createKinBudgetEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    get: createEnvironmentRpcCommand(runtime, {
      label: "kin:budget:get",
      tag: "kin.budget.get",
    }),
    set: createEnvironmentRpcCommand(runtime, { label: "kin:budget:set", tag: "kin.budget.set" }),
  };
}
