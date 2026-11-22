import { assert, it } from "@effect/vitest";
import {
  KinAgentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ProviderRegistryMock from "../../provider/testUtils/providerRegistryMock.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as Hub from "../chat/KinChatHub.ts";
import * as Repository from "../chat/KinChatRepository.ts";
import * as Service from "../chat/KinChatService.ts";
import * as Identity from "../chat/KinIdentity.ts";
import { environment } from "../chat/TaskCard.testkit.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as Presence from "../reply/KinPresence.ts";
import * as KinEventQueue from "./KinEventQueue.ts";
import { helperModelRefusal, kinHelperProviders } from "./leadModels.ts";
import { KinRefusedModels, layer as refusedModelsLayer } from "./refusedModels.ts";

const at = "1970-01-01T00:00:00.000Z";
const claude = ProviderInstanceId.make("claudeAgent");
const wren = { instanceId: claude, model: "invented-wren-4" };
const provider = {
  instanceId: claude,
  driver: ProviderDriverKind.make("claudeAgent"),
  displayName: "Invented Claude",
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: at,
  models: [
    { slug: "invented-quill-5", name: "Invented Quill 5", isCustom: false, capabilities: null },
    { slug: "invented-wren-4", name: "Invented Wren 4", isCustom: false, capabilities: null },
  ],
  slashCommands: [],
  skills: [],
} satisfies ServerProvider;

const layer = Layer.mergeAll(
  refusedModelsLayer,
  ServerSettingsService.layerTest(),
  ProviderRegistryMock.layer([provider]),
).pipe(
  Layer.provideMerge(Layer.mergeAll(Service.layer, KinEventQueue.layer)),
  Layer.provideMerge(
    Identity.KinIdentity.layer.pipe(
      Layer.provide(
        Layer.succeed(Identity.KinIdentityConfig, {
          orgName: "Ambermill",
          ownerHandle: "rhea",
          ownerDisplayName: "Rhea",
        }),
      ),
    ),
  ),
  Layer.provideMerge(Presence.layer),
  Layer.provideMerge(Hub.layer),
  Layer.provideMerge(Repository.layer),
  Layer.provideMerge(Layer.provideMerge(KinPersistence.layer, Sqlite.layerMemory)),
  Layer.provideMerge(environment),
);

it.effect(
  "a model the provider refused is hidden once, told once, refused to helpers, and comes back when the owner turns it on",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 10, 23, 9));
      const sql = yield* SqlClient.SqlClient;
      const repo = yield* Repository.KinChatRepository;
      const chats = yield* Service.KinChatService;
      const identity = yield* Identity.KinIdentity;
      const settings = yield* ServerSettingsService;
      const refusals = yield* KinRefusedModels;
      const { owner } = identity;
      const agentId = KinAgentId.make("chief");
      yield* repo.insertAgent({
        orgId: owner.orgId,
        agentId,
        ownerPersonId: owner.personId,
        displayName: "Chief of staff",
        role: "lead",
        createdAt: at,
      });
      const direct = yield* chats.createDirect(owner, { orgId: owner.orgId, agentId });
      yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id)
        VALUES (${agentId}, ${owner.orgId}, 'Chief of staff', 0, '{}', '[]', ${direct.chatId})`;
      const notices = sql<{ body: string }>`SELECT body FROM kin_messages
        WHERE org_id = ${owner.orgId} AND chat_id = ${direct.chatId} AND author_kind = 'system'
        ORDER BY created_at, message_id`;
      const helperOn = (model: string) =>
        Effect.map(settings.getSettings, (current) =>
          helperModelRefusal({
            settings: current,
            providers: [provider],
            devServer: false,
            callerInstanceId: claude,
            target: { model },
          }),
        );
      const offered = Effect.map(settings.getSettings, (current) =>
        kinHelperProviders(current, [provider]).flatMap((one) => one.models.map((m) => m.slug)),
      );

      // Two helpers refused at the same moment: one record, one notice.
      const first = yield* Effect.all(
        [
          refusals.refused({ orgId: owner.orgId, selection: wren }),
          refusals.refused({ orgId: owner.orgId, selection: wren }),
        ],
        { concurrency: "unbounded" },
      );
      assert.deepStrictEqual(first.toSorted(), [false, true]);
      assert.deepStrictEqual((yield* settings.getSettings).providerModelPreferences?.[claude], {
        hiddenModels: ["invented-wren-4"],
        modelOrder: [],
        refusedAt: { "invented-wren-4": Date.UTC(2026, 10, 23, 9) },
      });
      assert.deepStrictEqual(yield* notices, [
        {
          body: "Invented Claude on this server doesn't offer Invented Wren 4, so Kin stopped offering it. If that changes, turn it back on in Settings › Providers.",
        },
      ]);
      // The next ask is refused before anything starts, and capabilities no longer list it.
      assert.include(
        (yield* helperOn("invented-wren-4")) ?? "",
        "Kin didn't start this task on invented-wren-4:",
      );
      assert.deepStrictEqual(yield* offered, ["invented-quill-5"]);
      assert.isFalse(yield* refusals.refused({ orgId: owner.orgId, selection: wren }));
      assert.lengthOf(yield* notices, 1);

      // The owner turns it back on in Settings › Providers: the record goes with the hide.
      yield* settings.updateSettings({
        setModelsHidden: [{ provider: claude, model: "invented-wren-4", hidden: false }],
      });
      assert.deepStrictEqual((yield* settings.getSettings).providerModelPreferences?.[claude], {
        hiddenModels: [],
        modelOrder: [],
      });
      assert.isUndefined(yield* helperOn("invented-wren-4"));
      assert.deepStrictEqual(yield* offered, ["invented-quill-5", "invented-wren-4"]);

      // A model the owner hid himself is his; refused again after he turned it on, it is told anew.
      yield* settings.updateSettings({
        setModelsHidden: [{ provider: claude, model: "invented-quill-5", hidden: true }],
      });
      assert.isFalse(
        yield* refusals.refused({
          orgId: owner.orgId,
          selection: { instanceId: claude, model: "invented-quill-5" },
        }),
      );
      yield* TestClock.adjust("1 day");
      assert.isTrue(yield* refusals.refused({ orgId: owner.orgId, selection: wren }));
      assert.lengthOf(yield* notices, 2);
    }).pipe(Effect.provide(layer)),
);
