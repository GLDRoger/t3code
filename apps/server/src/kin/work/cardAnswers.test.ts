// Loaded first: the chat and trigger modules import each other.
import "../chat/KinChatService.ts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  KinChatError,
  KinChatId,
  KinMemberId,
  KinMessageId,
  KinOrgId,
  KinPersonId,
  KinWidgetId,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { KinChatHub } from "../chat/KinChatHub.ts";
import { KinChatRepository } from "../chat/KinChatRepository.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { KinConnections } from "../connections/ConnectionsService.ts";
import { KinDocRenderer } from "../gendocs/render.ts";
import { KinWorkspace } from "../gendocs/workspace.ts";
import { KinBudget } from "../lead/KinBudget.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import { KinLevelGate } from "../lead/LevelGate.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import { answerChoice } from "./cardAnswers.ts";
import * as KinRecords from "./KinRecords.ts";

// Invented: Ambermill's owner Rhea cancels a mail card in chat.
const orgId = KinOrgId.make("ambermill");
const rhea = KinPersonId.make("ambermill-rhea");

const layer = Layer.mergeAll(
  KinRecords.layer,
  Layer.mock(KinIdentity)({
    owner: { _tag: "person" as const, orgId, personId: rhea },
    isAgentThread: () => true,
    isLeadThread: () => true,
  }),
  Layer.mock(KinLevelGate)({
    ask: () => Effect.fail(new KinChatError({ reason: "unavailable", message: "No chat here." })),
  }),
  Layer.mock(KinChatService)({}),
  // A receipt's PDF needs these; a mail card's answer never reaches them.
  Layer.mock(KinChatHub)({}),
  Layer.mock(KinChatRepository)({}),
  Layer.mock(KinDocRenderer)({}),
  Layer.mock(KinWorkspace)({}),
  Layer.mock(KinBudget)({}),
  Layer.mock(KinConnections)({
    answerAsk: () => Effect.succeed({ _tag: "declined" as const, askId: "ask-1" }),
  }),
).pipe(
  Layer.provideMerge(KinEventQueue.layer),
  Layer.provideMerge(KinPersistence.layer),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-card-answers-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(layer)((it) => {
  it.effect("a mail cancelled on its card tells an open Tasks list to read again", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const taken = sql<{ seq: number | null }>`SELECT seq FROM sqlite_sequence
        WHERE name = 'kin_record_changes'`.pipe(Effect.map(([row]) => row?.seq ?? 0));
      yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Ambermill', '2026-11-01')`;
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
        VALUES (${rhea}, ${orgId}, 'rhea', 'Rhea', '2026-11-01', 'owner')`;
      yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in,
          created_at, definition_json) VALUES (${orgId}, 'clients', 'clients', 'C', 1, 0, '{}')`;
      yield* (yield* KinRecords.KinRecords).create(
        orgId,
        { actor: { _tag: "system" }, via: "import" },
        {
          list: "clients",
          title: "Lumen Grove Clinics",
          owner: { _tag: "person", personId: rhea },
          originKey: "lumen",
        },
      );
      const before = yield* taken;
      const scope = yield* Scope.make();
      const outcome = yield* sql.withTransaction(
        answerChoice(
          {
            orgId,
            widget: {
              orgId,
              chatId: KinChatId.make("chat-1"),
              widgetId: KinWidgetId.make("card-1"),
              messageId: KinMessageId.make("message-1"),
              widgetClass: "native",
              type: "choice",
              revision: 1,
              state: {},
              source: null,
              feed: null,
              awaiting: [rhea],
              pinnedAt: null,
              closedAt: null,
              updatedAt: "2026-11-20T09:00:00.000Z",
            },
            personId: rhea,
            memberId: KinMemberId.make("member-rhea"),
            option: { label: "Cancel", kind: "no" },
            via: "tap",
            now: Date.UTC(2026, 10, 20, 9),
          },
          scope,
        ),
      );
      assert.deepStrictEqual(outcome, {
        title: "Not sent",
        text: "You cancelled it, so nothing was sent.",
      });
      // `KinRecords.announce` takes the next number once the cancel commits.
      assert.strictEqual(yield* taken, before + 1);
    }),
  );
});
