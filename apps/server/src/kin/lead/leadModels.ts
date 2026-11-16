import type { KinOrgId, ModelSelection, ServerProvider, ServerSettings } from "@t3tools/contracts";
import { isKinAgentDriver, KinLead } from "@t3tools/contracts";
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

const LeadModelJson = Schema.fromJsonString(KinLead.fields.model);
const decodeModel = Schema.decodeUnknownOption(LeadModelJson);
export const encodeLeadModel = Schema.encodeSync(LeadModelJson);

/** A dev server also runs leads on the scripted agent, so checks drive real turns for free. */
export const isDevServer = Effect.serviceOption(ServerConfig).pipe(
  Effect.map(Option.exists((config) => config.devUrl !== undefined)),
);

/** The models this host offers an agent: the one place that decides which providers qualify. */
export const kinAgentModels = (providers: ReadonlyArray<ServerProvider>) =>
  providers
    .filter((provider) => isKinAgentDriver(provider.driver) && provider.enabled)
    .flatMap((provider) =>
      provider.models.map((model) => ({ instanceId: provider.instanceId, model })),
    );

/** Only Claude sessions get LeadIsolation's no-shell tool set, so a lead runs on nothing else. */
export const nonClaudeLeadModel = (
  settings: ServerSettings,
  model: ModelSelection,
  devServer = false,
): string | undefined => {
  const { instanceId } = model;
  const driver = deriveProviderInstanceConfigMap(settings)[instanceId]?.driver;
  if (devServer && instanceId === KIN_VERIFY_SCRIPT_INSTANCE_ID && driver === "acpRegistry")
    return undefined;
  if (!isKinAgentDriver(driver))
    return `Kin agents run only on Claude, and the model's instance ${instanceId} is ${driver === undefined ? "not a configured provider" : `a ${driver} instance`}. Workers may still use any provider.`;
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
 * Why a turn can't run on this model: not Claude, or (when the host's providers are known) its
 * instance is off or not installed, or it no longer lists the model. Undefined when it can.
 */
export const leadModelProblem = (
  settings: ServerSettings,
  providers: ReadonlyArray<ServerProvider> | null,
  selection: ModelSelection,
  devServer = false,
): string | undefined => {
  const notClaude = nonClaudeLeadModel(settings, selection, devServer);
  if (notClaude !== undefined) return notClaude;
  if (providers === null) return undefined;
  if (devServer && selection.instanceId === KIN_VERIFY_SCRIPT_INSTANCE_ID) return undefined;
  const provider = providers.find((entry) => entry.instanceId === selection.instanceId);
  if (provider === undefined || !provider.enabled || !provider.installed)
    return `${modelLabel(providers, selection)} isn't available on this server right now.`;
  const onInstance = kinAgentModels([provider]);
  const listed =
    provider.models.length === 0 ||
    onInstance.some(
      ({ model }) => model.slug === selection.model || model.aliases?.includes(selection.model),
    );
  if (!listed) return `${selection.model} isn't offered on this server any more.`;
  return undefined;
};

/**
 * The model a turn runs on: the agent's own, or when it can't run, the company default, with the
 * line its page shows. When neither can run, its own, and the turn is refused as before.
 */
export const chooseLeadModel = (input: {
  readonly own: ModelSelection;
  readonly companyDefault: ModelSelection | null;
  readonly problemOf: (model: ModelSelection) => string | undefined;
}): { readonly model: ModelSelection; readonly note: string | null } => {
  const problem = input.problemOf(input.own);
  if (problem === undefined) return { model: input.own, note: null };
  if (input.companyDefault !== null && input.problemOf(input.companyDefault) === undefined)
    return {
      model: input.companyDefault,
      note: `${problem} It runs on the company default until you choose another.`,
    };
  return { model: input.own, note: problem };
};

/** The model the owner chose for new agents; null until they choose. */
export const companyDefaultModel = Effect.fn("KinLeadModels.companyDefault")(function* (
  orgId: KinOrgId,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ model: string }>`SELECT models_json AS model
    FROM kin_agent_defaults WHERE org_id = ${orgId}`;
  return row === undefined ? null : Option.getOrNull(decodeModel(row.model));
});

/** What a turn of this agent runs on right now, by the host's settings and providers. */
export const turnModel = Effect.fn("KinLeadModels.turnModel")(function* (
  orgId: KinOrgId,
  own: ModelSelection,
) {
  const settings = yield* (yield* ServerSettingsService).getSettings;
  const registry = yield* Effect.serviceOption(ProviderRegistry);
  const providers = Option.isSome(registry) ? yield* registry.value.getProviders : null;
  const devServer = yield* isDevServer;
  const chosen = chooseLeadModel({
    own,
    companyDefault: yield* companyDefaultModel(orgId),
    problemOf: (model) => leadModelProblem(settings, providers, model, devServer),
  });
  return { ...chosen, providers };
});
