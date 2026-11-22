import type {
  KinOrgId,
  ModelSelection,
  OrchestratorMcpTarget,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderModel,
  ServerSettings,
} from "@t3tools/contracts";
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
  }. Helper tasks follow the same rule.`;
};

export const findProviderModel = (models: ReadonlyArray<ServerProviderModel>, slug: string) =>
  models.find((model) => model.slug === slug || model.aliases?.includes(slug));

/** The model's name as its provider lists it, else the id it was saved with. */
const modelLabel = (providers: ReadonlyArray<ServerProvider> | null, selection: ModelSelection) =>
  findProviderModel(
    providers?.find((provider) => provider.instanceId === selection.instanceId)?.models ?? [],
    selection.model,
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
    findProviderModel(provider.models, selection.model) !== undefined;
  if (!listed)
    return `${selection.model} isn't offered by ${provider.displayName ?? "Claude"} on this server any more.`;
  return undefined;
};

/** The provider turned the request away (400 or 404) naming `model`: it doesn't serve it here. */
export const modelNotOffered = (
  failure: {
    readonly code: string | null | undefined;
    readonly message: string | null | undefined;
  },
  model: string,
) =>
  (failure.code === "api_error_400" || failure.code === "api_error_404") &&
  model !== "" &&
  (failure.message ?? "").includes(model);

/** A model the owner hid from this host's model list; Kin's agent pickers leave it out too. */
const hiddenModel = (
  settings: ServerSettings,
  provider: ServerProvider,
  model: ServerProviderModel,
) =>
  !model.isCustom &&
  (settings.providerModelPreferences?.[provider.instanceId]?.hiddenModels.includes(model.slug) ??
    false);

/**
 * The models a helper task (`delegate_task`) may run on: the ones Kin's agent picker offers, on an
 * installed provider agents may run on, less those the owner hid. Current models first.
 */
const kinHelperModels = (settings: ServerSettings, providers: ReadonlyArray<ServerProvider>) =>
  providers
    .filter(
      (provider) =>
        provider.installed &&
        provider.enabled &&
        kinAgentDriverAllowed(provider.driver, settings.kinNonClaudeAgents),
    )
    .flatMap((provider) =>
      provider.models
        .filter((model) => !hiddenModel(settings, provider, model))
        .map((model) => ({ provider, model })),
    )
    .toSorted((a, b) => Number(a.model.isLegacy === true) - Number(b.model.isLegacy === true));

/** The host's providers as `orchestrator_capabilities` shows them to a Kin agent: `kinHelperModels`. */
export const kinHelperProviders = (
  settings: ServerSettings,
  providers: ReadonlyArray<ServerProvider>,
) => {
  const admitted = new Set(kinHelperModels(settings, providers).map(({ model }) => model));
  return providers.flatMap((provider) => {
    const models = provider.models.filter((model) => admitted.has(model));
    return models.length === 0 ? [] : [{ ...provider, models }];
  });
};

/** Why a helper can't run on this model, in a few words; undefined when it can. */
const helperModelProblem = (
  settings: ServerSettings,
  providers: ReadonlyArray<ServerProvider> | null,
  selection: { readonly instanceId: ProviderInstanceId; readonly model: string | undefined },
  devServer: boolean,
) => {
  const { instanceId } = selection;
  if (leadProviderProblem(settings, { instanceId, model: "" }, devServer) !== undefined)
    return `Kin's agents don't run on ${instanceId}`;
  if (kinProviderFacts(driverOf(settings, { instanceId, model: "" }))?.devOnly) return undefined;
  const unreadable = `Kin can't read ${instanceId}'s model list right now, so it can't check the model`;
  if (providers === null) return unreadable;
  const provider = providers.find((entry) => entry.instanceId === instanceId);
  if (provider === undefined || !provider.enabled || !provider.installed)
    return `${instanceId} isn't available on this server right now`;
  if (provider.models.length === 0) return unreadable;
  const listed =
    selection.model === undefined ? undefined : findProviderModel(provider.models, selection.model);
  if (listed === undefined) return `${instanceId} doesn't offer it`;
  if (hiddenModel(settings, provider, listed))
    return "it's switched off in this server's model list";
  return undefined;
};

/**
 * Why Kin refuses a helper task on this target, as the agent reads it, or undefined when it may
 * start: no model named runs on the caller's own (`callerInstanceId`), which its turn already
 * passed; anything else must be one of `kinHelperModels`. Never swaps in another model.
 */
export const helperModelRefusal = (input: {
  readonly settings: ServerSettings;
  /** Null when the host's providers can't be read. */
  readonly providers: ReadonlyArray<ServerProvider> | null;
  readonly devServer: boolean;
  readonly callerInstanceId: ProviderInstanceId | undefined;
  readonly target: OrchestratorMcpTarget | undefined;
}): string | undefined => {
  const { target, providers, callerInstanceId: own } = input;
  if (target === undefined) return undefined;
  const { model, providerInstanceId, driverKind } = target;
  if (
    model === undefined &&
    driverKind === undefined &&
    (providerInstanceId === undefined || providerInstanceId === own)
  )
    return undefined;
  // T3 runs a driver-only target on the caller's instance when it has that driver, else on one of its instances.
  const ofDriver =
    providerInstanceId !== undefined || driverKind === undefined
      ? undefined
      : (providers ?? []).filter((provider) => provider.driver === driverKind);
  const instances =
    providerInstanceId !== undefined
      ? [providerInstanceId]
      : ofDriver === undefined
        ? own === undefined
          ? []
          : [own]
        : ofDriver.some((provider) => provider.instanceId === own) && own !== undefined
          ? [own]
          : ofDriver.map((provider) => provider.instanceId);
  const refusal = (named: string, why: string) => {
    const allowed = providers === null ? [] : kinHelperModels(input.settings, providers);
    const offered = Map.groupBy(allowed, ({ provider }) => provider.instanceId);
    const list = [...offered].map(
      ([instanceId, entries]) =>
        `${entries
          .map(({ model: one }) => (one.name === one.slug ? one.slug : `${one.slug} (${one.name})`))
          .join(", ")} on ${instanceId}`,
    );
    return [
      `Kin didn't start this task on ${named}: ${why}. Nothing started, and no one was told.`,
      providers === null
        ? ""
        : list.length === 0
          ? "No other model is offered to Kin's agents here."
          : `Models you may use, as target.model with its target.providerInstanceId: ${list.join("; ")}.`,
      "Or leave target.model and target.providerInstanceId out, and it runs on your own model.",
    ]
      .filter((line) => line !== "")
      .join(" ");
  };
  if (instances.length === 0)
    return driverKind === undefined
      ? undefined
      : refusal(model ?? driverKind, `no ${driverKind} provider is available on this server`);
  for (const instanceId of instances) {
    const effective =
      model ??
      (instanceId === own
        ? undefined
        : providers?.find((provider) => provider.instanceId === instanceId)?.models[0]?.slug);
    if (model === undefined && instanceId === own) continue;
    const why = helperModelProblem(
      input.settings,
      providers,
      { instanceId, model: effective },
      input.devServer,
    );
    if (why !== undefined) return refusal(effective ?? instanceId, why);
  }
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
