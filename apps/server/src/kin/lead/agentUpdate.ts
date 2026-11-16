import {
  KinChatError,
  type ModelSelection,
  type ServerProvider,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ownerLevel } from "../people/KinAccess.ts";
import { turnAsker } from "./Audience.ts";
import { leadsIn, update } from "./KinLeadProvision.ts";
import type { resolveLead } from "./LeadMemory.ts";

export const AgentUpdateInput = Schema.Struct({
  agent: TrimmedNonEmptyString,
  model: Schema.optional(TrimmedNonEmptyString),
  effort: Schema.optional(TrimmedNonEmptyString),
});
export type AgentUpdateInput = typeof AgentUpdateInput.Type;
export const AgentUpdateResult = Schema.Struct({ saved: Schema.String });

const refused = (reason: KinChatError["reason"], message: string) =>
  new KinChatError({ reason, message });
const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9.]+/g, "");

/**
 * The Claude model this host offers that the owner's words name ("Sonnet", "opus 4.6"), with an
 * effort when that model has one by that name. Exact ids first, then the newest listed match.
 */
export const matchModel = (
  providers: ReadonlyArray<ServerProvider>,
  words: string,
  effort: string | undefined,
  current: ModelSelection,
): ModelSelection | string => {
  const offered = providers
    .filter((provider) => provider.driver === "claudeAgent" && provider.enabled)
    .flatMap((provider) =>
      provider.models.map((model) => ({ instanceId: provider.instanceId, model })),
    );
  const wanted = squash(words);
  const found =
    offered.find(({ model }) => model.slug === words || model.aliases?.includes(words)) ??
    offered
      .filter(({ model }) => model.isLegacy !== true)
      .find(({ model }) => squash(model.name).includes(wanted) || squash(model.slug).includes(wanted));
  if (found === undefined && words !== current.model)
    return `This server offers no Claude model called ${words}. It has: ${offered
      .filter(({ model }) => model.isLegacy !== true)
      .map(({ model }) => model.name)
      .join(", ")}.`;
  const instanceId = found?.instanceId ?? current.instanceId;
  const model = found?.model.slug ?? current.model;
  if (effort === undefined) return { instanceId, model };
  const choices =
    found?.model.capabilities?.optionDescriptors?.find((one) => one.id === "effort") ?? null;
  const choice =
    choices?.type === "select"
      ? choices.options.find(
          (one) => squash(one.id) === squash(effort) || squash(one.label) === squash(effort),
        )
      : undefined;
  if (choice === undefined) return `${found?.model.name ?? model} has no ${effort} effort here.`;
  return choice.id === "default"
    ? { instanceId, model }
    : { instanceId, model, options: [{ id: "effort", value: choice.id }] };
};

/**
 * Changes which model an agent runs on, when the owner or a co-owner asked for it in their own
 * words. It saves through `kin.lead.update`'s method, so the same checks apply.
 */
export const updateAgent = Effect.fn("KinAgentUpdate.update")(function* (
  lead: Effect.Success<ReturnType<typeof resolveLead>>,
  input: AgentUpdateInput,
) {
  const asker = yield* turnAsker(lead);
  if (asker === null || !(yield* ownerLevel(lead.orgId, asker)))
    return yield* refused("not_allowed", "Only the owner or a co-owner changes an agent's model.");
  const named = input.agent.trim().toLowerCase();
  const agent = (yield* leadsIn(lead.orgId, { liveOnly: true })).find(
    (entry) => entry.name.toLowerCase() === named || entry.domain === named.replace(/\s+/g, "-"),
  );
  if (agent === undefined)
    return yield* refused("not_found", `No agent is called ${input.agent}. Nothing changed.`);
  if (input.model === undefined && input.effort === undefined)
    return yield* refused("invalid_state", "Say which model or effort. Nothing changed.");
  // Not every MCP context carries the host's settings; without them nothing is changed.
  const settings = yield* Effect.serviceOption(ServerSettingsService);
  if (Option.isNone(settings))
    return yield* refused("unavailable", "Kin can't change models from here right now.");
  const registry = yield* Effect.serviceOption(ProviderRegistry);
  const providers = Option.isSome(registry) ? yield* registry.value.getProviders : [];
  const strong = matchModel(
    providers,
    input.model ?? agent.models.strong.model,
    input.effort,
    agent.models.strong,
  );
  if (typeof strong === "string") return yield* refused("invalid_state", strong);
  yield* update({
    editor: { _tag: "person", personId: asker },
    orgId: lead.orgId,
    agentId: agent.agentId,
    fields: { models: { strong, cheap: agent.models.cheap } },
  }).pipe(
    Effect.provideService(ServerSettingsService, settings.value),
    Effect.catchTag("KinLeadProvisionError", (error) =>
      Effect.fail(
        refused(error.reason === "not_found" ? "not_found" : "invalid_state", error.message),
      ),
    ),
  );
  const effort = strong.options?.find((option) => option.id === "effort")?.value;
  return {
    saved: `${agent.name} runs on ${strong.model}${typeof effort === "string" ? ` at ${effort} effort` : ""} from its next reply.`,
  };
});
