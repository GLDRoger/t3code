import type { KinOrgId, ModelSelection, ServerProvider, ServerSettings } from "@t3tools/contracts";
import { kinAgentDriverAllowed, KinLead, kinProviderFacts } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import { deriveProviderInstanceConfigMap } from "../../provider/ProviderInstanceRegistryHydration.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

const decodeModel = Schema.decodeUnknownOption(Schema.fromJsonString(KinLead.fields.model));
const encodeSelection = Schema.encodeSync(KinLead.fields.model);
/** Rows from before K163 also carry `strong` and `cheap`; decoding ignores them. */
export const encodeLeadModel = (model: ModelSelection) => JSON.stringify(encodeSelection(model));

/** A dev server also runs leads on the scripted agent, so checks drive real turns for free. */
export const isDevServer = Effect.serviceOption(ServerConfig).pipe(
  Effect.map(Option.exists((config) => config.devUrl !== undefined)),
);

/** The models this host offers an agent: the one place that decides which providers qualify. */
export const kinAgentModels = (providers: ReadonlyArray<ServerProvider>, otherProviders: boolean) =>
  providers
    .filter(
      (provider) => kinAgentDriverAllowed(provider.driver, otherProviders) && provider.enabled,
    )
    .flatMap((provider) =>
      provider.models.map((model) => ({ instanceId: provider.instanceId, model })),
    );

export const driverOf = (settings: ServerSettings, model: ModelSelection) =>
  deriveProviderInstanceConfigMap(settings)[model.instanceId]?.driver;

/** An agent runs only on a provider Kin plans its sessions for (`lead/turn/providers.ts`). */
export const leadProviderProblem = (
  settings: ServerSettings,
  model: ModelSelection,
  devServer = false,
): string | undefined => {
  const driver = driverOf(settings, model);
  if (kinAgentDriverAllowed(driver, settings.kinNonClaudeAgents, devServer)) return undefined;
  const facts = kinProviderFacts(driver);
  return `Kin agents can't run on ${model.instanceId}: ${
    driver === undefined
      ? "it isn't a configured provider"
      : facts === undefined
        ? `Kin doesn't run agents on ${driver} yet`
        : facts.devOnly
          ? "it runs agents only on a dev server"
          : "turn on Agents on other providers in Kin's Settings first"
  }. Delegated tasks may still use any provider.`;
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
  const refused = leadProviderProblem(settings, selection, devServer);
  if (refused !== undefined) return refused;
  if (providers === null) return undefined;
  // A dev-only provider, such as kin-verify's scripted agent, lists no models of its own.
  if (kinProviderFacts(driverOf(settings, selection))?.devOnly) return undefined;
  const provider = providers.find((entry) => entry.instanceId === selection.instanceId);
  if (provider === undefined || !provider.enabled || !provider.installed)
    return `${modelLabel(providers, selection)} isn't available on this server right now.`;
  const listed =
    provider.models.length === 0 ||
    kinAgentModels([provider], settings.kinNonClaudeAgents).some(
      ({ model }) => model.slug === selection.model || model.aliases?.includes(selection.model),
    );
  if (!listed)
    return `${selection.model} isn't offered by ${provider.displayName ?? "Claude"} on this server any more.`;
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
