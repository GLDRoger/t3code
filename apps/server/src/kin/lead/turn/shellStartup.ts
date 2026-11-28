import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { Services } from "../../KinServer.ts";

export const KinShellStartup = Context.Reference<{
  readonly available: boolean;
  readonly executables?: ReadonlySet<string>;
  readonly report?: (services: Context.Context<Services>) => Effect.Effect<void>;
}>("t3/kin/lead/KinShellStartup", { defaultValue: () => ({ available: true }) });
