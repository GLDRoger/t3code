import { type KinOrgId, KinMessageId, type ModelSelection } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as Chat from "../chat/KinChatService.ts";
import { holdIfQuiet } from "../triggers/quietHold.ts";
import { findProviderModel } from "./leadModels.ts";
import { CHIEF_OF_STAFF_DOMAIN, liveLead } from "./orgLeads.ts";

const refusedModelNotice = (provider: string, model: string) =>
  `${provider} on this server doesn't offer ${model}, so Kin stopped offering it. If that changes, turn it back on in Settings › Providers.`;

/**
 * A model this server's provider refused: hidden in the owner's model list with when, so every
 * picker, the helper rule and `orchestrator_capabilities` leave it out, and the owner told once.
 */
export class KinRefusedModels extends Context.Service<
  KinRefusedModels,
  {
    /** False when the model was already hidden (by the owner or an earlier refusal). */
    readonly refused: (input: {
      readonly orgId: KinOrgId;
      readonly selection: ModelSelection;
    }) => Effect.Effect<boolean>;
  }
>()("t3/kin/lead/refusedModels/KinRefusedModels") {}

// Settings and providers are read where it runs: Kin's services are built before the server's.
const make = Effect.gen(function* () {
  const chat = yield* Chat.KinChatService;
  const sql = yield* SqlClient.SqlClient;
  // One read-then-hide at a time, so failures at once record and tell once.
  const lock = yield* Semaphore.make(1);

  const tell = Effect.fn("KinRefusedModels.tell")(function* (
    orgId: KinOrgId,
    selection: ModelSelection,
    model: { readonly slug: string; readonly name: string },
    providerName: string,
    at: number,
  ) {
    const lead = yield* liveLead(sql, orgId, { prefer: CHIEF_OF_STAFF_DOMAIN });
    if (lead === undefined) return;
    const body = refusedModelNotice(providerName, model.name);
    const held = yield* holdIfQuiet({
      orgId,
      chatId: lead.ownerChatId,
      personId: lead.ownerPersonId,
      kind: "refused_model",
      body,
      audience: "owner",
    }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
    if (held) return;
    yield* chat.notice({
      orgId,
      chatId: lead.ownerChatId,
      messageId: KinMessageId.make(`kin-refused-model:${selection.instanceId}:${model.slug}:${at}`),
      audience: "owner",
      body,
    });
  });

  const refused = Effect.fn("KinRefusedModels.refused")(
    function* (input: { readonly orgId: KinOrgId; readonly selection: ModelSelection }) {
      const { instanceId, model: asked } = input.selection;
      const host = yield* Effect.serviceOption(ServerSettingsService);
      if (Option.isNone(host)) return false;
      const settings = host.value;
      const registry = yield* Effect.serviceOption(ProviderRegistry);
      const providers = Option.isSome(registry) ? yield* registry.value.getProviders : [];
      const provider = providers.find((entry) => entry.instanceId === instanceId);
      const listed = findProviderModel(provider?.models ?? [], asked);
      // A model the owner added by hand stays theirs to remove.
      if (listed?.isCustom === true) return false;
      const model = { slug: listed?.slug ?? asked, name: listed?.name ?? asked };
      const at = yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* settings.getSettings;
          if (current.providerModelPreferences?.[instanceId]?.hiddenModels.includes(model.slug))
            return undefined;
          const now = yield* Clock.currentTimeMillis;
          yield* settings.updateSettings({
            setModelsHidden: [
              { provider: instanceId, model: model.slug, hidden: true, refusedAt: now },
            ],
          });
          return now;
        }),
      );
      if (at === undefined) return false;
      yield* tell(input.orgId, input.selection, model, provider?.displayName ?? instanceId, at);
      return true;
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Kin could not record a model the provider refused", { cause }).pipe(
        Effect.as(false),
      ),
    ),
  );

  return KinRefusedModels.of({ refused });
});

export const layer = Layer.effect(KinRefusedModels, make);
