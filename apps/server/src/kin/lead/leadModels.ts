import type { ModelSelection, ServerSettings } from "@t3tools/contracts";

import { deriveProviderInstanceConfigMap } from "../../provider/ProviderInstanceRegistryHydration.ts";

/** Only Claude sessions get LeadIsolation's no-shell tool set, so a lead runs on nothing else. */
export const nonClaudeLeadModel = (
  settings: ServerSettings,
  models: { readonly strong: ModelSelection; readonly cheap: ModelSelection },
): string | undefined => {
  const instances = deriveProviderInstanceConfigMap(settings);
  for (const role of ["strong", "cheap"] as const) {
    const { instanceId } = models[role];
    const driver = instances[instanceId]?.driver;
    if (driver !== "claudeAgent")
      return `Kin leads run only on Claude, and the ${role} model's instance ${instanceId} is ${driver === undefined ? "not a configured provider" : `a ${driver} instance`}. Workers may still use any provider.`;
  }
  return undefined;
};
