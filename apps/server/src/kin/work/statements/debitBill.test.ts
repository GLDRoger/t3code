// Loaded first: the chat and trigger modules import each other.
import "../../chat/KinChatService.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { KinChatError, KinOrgId, KinPersonId } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../../../config.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import { KinChatHub } from "../../chat/KinChatHub.ts";
import { KinChatRepository } from "../../chat/KinChatRepository.ts";
import { KinChatService } from "../../chat/KinChatService.ts";
import { KinIdentity } from "../../chat/KinIdentity.ts";
import { KinConnections } from "../../connections/ConnectionsService.ts";
import { KinDocRenderer } from "../../gendocs/render.ts";
import { KinWorkspace } from "../../gendocs/workspace.ts";
import { KinBudget } from "../../lead/KinBudget.ts";
import * as KinEventQueue from "../../lead/KinEventQueue.ts";
import { KinLevelGate } from "../../lead/LevelGate.ts";
import * as KinPersistence from "../../persistence/KinPersistence.ts";
import * as KinRecords from "../KinRecords.ts";
import { ensureBankList } from "./bankList.ts";
import { billMatch, billMatches } from "./debitBill.ts";

const orgId = KinOrgId.make("ambermill-vendor-bills");
const rhea = KinPersonId.make("ambermill-rhea");
const NOW = Date.parse("2026-11-24T12:00:00Z");
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
  Layer.mock(KinChatHub)({}),
  Layer.mock(KinChatRepository)({}),
  Layer.mock(KinDocRenderer)({}),
  Layer.mock(KinWorkspace)({}),
  Layer.mock(KinBudget)({}),
  Layer.mock(KinConnections)({}),
).pipe(
  Layer.provideMerge(KinEventQueue.layer),
  Layer.provideMerge(KinPersistence.layer),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-debit-bill-" })),
  Layer.provideMerge(NodeServices.layer),
);

const day = (iso: string) => Date.parse(`${iso}T12:00:00Z`);

it.layer(layer)((it) => {
  it.effect("offers only an unambiguous bill for a debit no agent wrote", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Ambermill Studio', '2026-11-01')`;
      yield* sql`INSERT INTO kin_trigger_settings VALUES (${orgId}, 'UTC', '08:00',
        '18:00', '02:00', 0, 1, '09:00', '{}')`;
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
        VALUES (${rhea}, ${orgId}, 'rhea', 'Rhea', '2026-11-01', 'owner')`;
      yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in, created_at)
        VALUES (${orgId}, 'expenses', 'expenses', 'EXP', 1, 0)`;
      const bank = yield* ensureBankList(orgId, NOW);
      const row = (key: string, list: string, fields: string, by = "person") =>
        sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, state,
          owner_kind, owner_id, date_at, amount_minor, currency, confirmed, created_by_kind,
          created_by_id, origin_key, created_at, updated_at, fields_json)
        VALUES (${orgId}, ${key}, ${list}, ${key}, 'Acme Hosting', 'open',
          'person', ${rhea}, ${day("2026-11-24")}, 450000, 'USD', 1, ${by}, ${rhea},
          ${key}, 0, 0, ${fields})`;
      yield* row("BNK-4", bank.id, '{"direction":"debit"}');
      yield* row("BNK-5", bank.id, '{"direction":"debit"}', "agent");
      yield* row("EXP-7", "expenses", '{"vendor":"Acme Hosting"}');
      const pairs = billMatches(orgId, NOW).pipe(
        Effect.map((matches) => matches.map(({ debit, bill }) => [debit.key, bill.key])),
      );
      assert.deepStrictEqual(yield* pairs, [["BNK-4", "EXP-7"]]);
      yield* row("EXP-8", "expenses", '{"vendor":"Acme Hosting"}');
      assert.deepStrictEqual(yield* pairs, []);
      yield* sql`UPDATE kin_records SET state = 'dropped' WHERE org_id = ${orgId} AND record_id = 'EXP-8'`;
      yield* row("BNK-6", bank.id, '{"direction":"debit"}');
      assert.deepStrictEqual(
        [
          yield* pairs,
          (yield* billMatch(orgId, "BNK-4"))?.bill.key,
          (yield* billMatch(orgId, "BNK-6"))?.bill.key,
        ],
        [[], undefined, undefined],
      );
    }),
  );
});
