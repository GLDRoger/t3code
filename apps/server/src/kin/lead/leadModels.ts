import type { ModelSelection, ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ServerConfig } from "../../config.ts";
import { deriveProviderInstanceConfigMap } from "../../provider/ProviderInstanceRegistryHydration.ts";

/** `scripts/kin-verify`'s scripted agent: it calls tools it is told to and runs no model. */
const KIN_VERIFY_SCRIPT_INSTANCE_ID = "kinVerifyScript";

/** A dev server also runs leads on the scripted agent, so checks drive real turns for free. */
export const isDevServer = Effect.serviceOption(ServerConfig).pipe(
  Effect.map(Option.exists((config) => config.devUrl !== undefined)),
);

/** Only Claude sessions get LeadIsolation's no-shell tool set, so a lead runs on nothing else. */
export const nonClaudeLeadModel = (
  settings: ServerSettings,
  models: { readonly strong: ModelSelection; readonly cheap: ModelSelection },
  devServer = false,
): string | undefined => {
  const instances = deriveProviderInstanceConfigMap(settings);
  for (const role of ["strong", "cheap"] as const) {
    const { instanceId } = models[role];
    const driver = instances[instanceId]?.driver;
    if (devServer && instanceId === KIN_VERIFY_SCRIPT_INSTANCE_ID && driver === "acpRegistry")
      continue;
    if (driver !== "claudeAgent")
      return `Kin agents run only on Claude, and the ${role} model's instance ${instanceId} is ${driver === undefined ? "not a configured provider" : `a ${driver} instance`}. Workers may still use any provider.`;
  }
  return undefined;
};
