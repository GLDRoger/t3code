import type { KinCapability } from "@t3tools/contracts";
import type * as Layer from "effect/Layer";

/**
 * Everything a provider contributes to Kin: its driver, its names for the built-ins Kin relies on
 * (one it lacks is left out, and `KIN_PROVIDER_FACTS` says so), and `install`, which tells
 * `KinSessions` whether the model in use can look a tool up and applies its plan to the T3 seam
 * its adapter runs sessions through. All else is shared.
 */
export interface KinProvider<Seam> {
  readonly driver: string;
  readonly capabilities: Partial<Readonly<Record<KinCapability, ReadonlyArray<string>>>>;
  readonly install: <E, R>(base: Layer.Layer<Seam, E, R>) => Layer.Layer<Seam, unknown, unknown>;
}
