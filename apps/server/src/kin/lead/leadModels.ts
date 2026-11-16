import type { KinOrgId, ModelSelection, ServerProvider, ServerSettings } from "@t3tools/contracts";
import { KinLead } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import { deriveProviderInstanceConfigMap } from "../../provider/ProviderInstanceRegistryHydration.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

/** `scripts/kin-verify`'s scripted agent: it calls tools it is told to and runs no model. */
const KIN_VERIFY_SCRIPT_INSTANCE_ID = "kinVerifyScript";

export type LeadModels = { readonly strong: ModelSelection; readonly cheap: ModelSelection };
const LeadModelsJson = Schema.fromJsonString(KinLead.fields.models);
const decodeModels = Schema.decodeUnknownOption(LeadModelsJson);
export const encodeLeadModels = Schema.encodeSync(LeadModelsJson);

/** A dev server also runs leads on the scripted agent, so checks drive real turns for free. */
export const isDevServer = Effect.serviceOption(ServerConfig).pipe(
  Effect.map(Option.exists((config) => config.devUrl !== undefined)),
);

/** Only Claude and confined Codex sessions get a lead's no-shell tool set; a lead runs on no other. */
export const nonClaudeLeadModel = (
  settings: ServerSettings,
  models: LeadModels,
  devServer = false,
): string | undefined => {
  const instances = deriveProviderInstanceConfigMap(settings);
  for (const role of ["strong", "cheap"] as const) {
    const { instanceId } = models[role];
    const driver = instances[instanceId]?.driver;
    if (devServer && instanceId === KIN_VERIFY_SCRIPT_INSTANCE_ID && driver === "acpRegistry")
      continue;
    if (driver === "claudeAgent" || (settings.kinNonClaudeAgents && driver === "codex")) continue;
    return `Kin agents run only on Claude, and the ${role} model's instance ${instanceId} is ${driver === undefined ? "not a configured provider" : `a ${driver} instance`}. Workers may still use any provider.${driver === "codex" ? " To use Codex, turn on Agents on OpenAI models in Kin's Settings." : ""}`;
  }
  return undefined;
};

/** The model's name as its provider lists it, else the id it was saved with. */
const modelLabel = (providers: ReadonlyArray<ServerProvider> | null, selection: ModelSelection) =>
  providers
    ?.find((provider) => provider.instanceId === selection.instanceId)
    ?.models.find(
      (model) => model.slug === selection.model || model.aliases?.includes(selection.model),
    )?.name ?? selection.model;

/**
 * Why a turn can't run on these models: not Claude, or (when the host's providers are known) its
 * instance is off or not installed, or it no longer lists the model. Undefined when they can.
 */
export const leadModelProblem = (
  settings: ServerSettings,
  providers: ReadonlyArray<ServerProvider> | null,
  models: LeadModels,
  devServer = false,
): string | undefined => {
  const notClaude = nonClaudeLeadModel(settings, models, devServer);
  if (notClaude !== undefined) return notClaude;
  if (providers === null) return undefined;
  for (const role of ["strong", "cheap"] as const) {
    const selection = models[role];
    if (devServer && selection.instanceId === KIN_VERIFY_SCRIPT_INSTANCE_ID) continue;
    const provider = providers.find((entry) => entry.instanceId === selection.instanceId);
    if (provider === undefined || !provider.enabled || !provider.installed)
      return `${modelLabel(providers, selection)} isn't available on this server right now.`;
    const listed =
      provider.models.length === 0 ||
      provider.models.some(
        (model) => model.slug === selection.model || model.aliases?.includes(selection.model),
      );
    if (!listed)
      return `${selection.model} isn't offered by ${provider.displayName ?? "Claude"} on this server any more.`;
  }
  return undefined;
};

/**
 * The models a turn runs on: the agent's own, or when those can't run, the company default, with
 * the line its page shows. When neither can run, its own, and the turn is refused as before.
 */
export const chooseLeadModels = (input: {
  readonly own: LeadModels;
  readonly companyDefault: LeadModels | null;
  readonly problemOf: (models: LeadModels) => string | undefined;
}): { readonly models: LeadModels; readonly note: string | null } => {
  const problem = input.problemOf(input.own);
  if (problem === undefined) return { models: input.own, note: null };
  if (input.companyDefault !== null && input.problemOf(input.companyDefault) === undefined)
    return {
      models: input.companyDefault,
      note: `${problem} It runs on the company default until you choose another.`,
    };
  return { models: input.own, note: problem };
};

/** The models the owner chose for new agents; null until they choose. */
export const companyDefaultModels = Effect.fn("KinLeadModels.companyDefault")(function* (
  orgId: KinOrgId,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ models: string }>`SELECT models_json AS models
    FROM kin_agent_defaults WHERE org_id = ${orgId}`;
  return row === undefined ? null : Option.getOrNull(decodeModels(row.models));
});

/** What a turn of this agent runs on right now, by the host's settings and providers. */
export const turnModels = Effect.fn("KinLeadModels.turnModels")(function* (
  orgId: KinOrgId,
  own: LeadModels,
) {
  const settings = yield* (yield* ServerSettingsService).getSettings;
  const registry = yield* Effect.serviceOption(ProviderRegistry);
  const providers = Option.isSome(registry) ? yield* registry.value.getProviders : null;
  const devServer = yield* isDevServer;
  const chosen = chooseLeadModels({
    own,
    companyDefault: yield* companyDefaultModels(orgId),
    problemOf: (models) => leadModelProblem(settings, providers, models, devServer),
  });
  return { ...chosen, providers };
});
