// Loaded first: the chat and trigger modules import each other.
import "../../chat/KinChatService.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { KinChatError, KinOrgId, KinPersonId } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

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
import { parseFields } from "../lists.ts";
import * as KinRecords from "../KinRecords.ts";
import { alertBalances, rejectedAlerts, takeAlerts, threadSeen } from "./bankAlerts.ts";
import { ensureBankList } from "./bankList.ts";

// Invented: Lakeview Studio's owner Rhea gets HDFC alerts in two connected mailboxes.
const orgId = KinOrgId.make("lakeview");
const rhea = KinPersonId.make("lakeview-rhea");
const NOW = Date.parse("2026-11-18T12:00:00Z");
const AUTH = [
  "mx.google.com; dkim=pass header.i=@hdfcbank.net; spf=pass smtp.mailfrom=alerts@hdfcbank.net; dmarc=pass (p=REJECT) header.from=hdfcbank.net",
];
const alert = (
  messageId: string | null,
  text: string,
  date = "Wed, 18 Nov 2026 10:00:00 +0530",
) => ({
  messageId,
  fromAddress: "alerts@hdfcbank.net",
  subject: "You have done a UPI txn. Check details!",
  date,
  authResults: AUTH,
  text,
});
const debit = (reference: string, balance = "4,10,000.00") =>
  `Rs.1,250.00 has been debited from account **4821 to VPA cafe@okaxis LAKEVIEW CAFE on 18-11-26. Your UPI transaction reference number is ${reference}. Avl bal: INR ${balance}`;

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
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-bank-alerts-" })),
  Layer.provideMerge(NodeServices.layer),
);

const entries = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    recordId: string;
    originKey: string;
    amountMinor: number;
    fieldsJson: string;
  }>`SELECT record_id AS "recordId", origin_key AS "originKey", amount_minor AS "amountMinor",
      fields_json AS "fieldsJson"
    FROM kin_records WHERE org_id = ${orgId} AND register_id = 'bank_transactions'
    ORDER BY origin_key`;
});

it.layer(layer)((it) => {
  it.effect("an alert is one bank transaction however often, and wherever, it is seen", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Lakeview Studio', '2026-11-01')`;
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
        VALUES (${rhea}, ${orgId}, 'rhea', 'Rhea', '2026-11-01', 'owner')`;
      const take = (connectionId: string, threadId: string, messages: ReturnType<typeof alert>[]) =>
        takeAlerts(orgId, { connectionId, threadId, messages, now: NOW });

      assert.deepStrictEqual(
        yield* take("work-mail", "t1", [alert("<m1@hdfc>", debit("632211110001"))]),
        {
          recorded: 1,
          duplicate: 0,
          rejected: 0,
        },
      );
      const [made] = yield* entries;
      assert.strictEqual(made!.originKey, "alert:hdfc:4821:632211110001");
      assert.strictEqual(made!.amountMinor, 125_000);
      assert.deepStrictEqual(parseFields(made!.fieldsJson), {
        direction: "debit",
        reference: "632211110001",
        account: "HDFC Bank ••4821",
        balance: { minor: 41_000_000, currency: "INR" },
      });

      // A re-poll reads the same mail: nothing new, nothing counted.
      assert.deepStrictEqual(
        yield* take("work-mail", "t1", [alert("<m1@hdfc>", debit("632211110001"))]),
        {
          recorded: 0,
          duplicate: 0,
          rejected: 0,
        },
      );
      // The same alert in a second mailbox, and the bank sending it again: the same entry.
      assert.deepStrictEqual(
        yield* take("home-mail", "t9", [
          alert("<m1@hdfc>", debit("632211110001")),
          alert("<m1-again@hdfc>", debit("0632211110001")),
        ]),
        { recorded: 0, duplicate: 2, rejected: 0 },
      );
      assert.strictEqual((yield* entries).length, 1);
      const linked = yield* sql<{ recordId: string }>`SELECT DISTINCT record_id AS "recordId"
        FROM kin_bank_alerts WHERE org_id = ${orgId} AND record_id IS NOT NULL`;
      assert.deepStrictEqual(linked, [{ recordId: made!.recordId }]);

      // A thread Kin read to its newest mail needn't be read again; a newer mail in it must.
      const sent = Date.parse("2026-11-18T04:30:00Z");
      assert.isTrue(yield* threadSeen(orgId, "work-mail", "t1", sent));
      assert.isFalse(yield* threadSeen(orgId, "work-mail", "t1", sent + 1));
    }),
  );

  it.effect("an alert of money a statement already saved is that row", () =>
    Effect.gen(function* () {
      const records = yield* KinRecords.KinRecords;
      const def = yield* ensureBankList(orgId, NOW);
      // As a confirmed statement saves it: its own key, the bank's zero-padded reference.
      yield* records.create(
        orgId,
        { actor: { _tag: "person", personId: rhea }, via: "owner" },
        {
          list: def.id,
          originKey: "bank:statement-row",
          title: "UPI-LAKEVIEW CAFE",
          owner: { _tag: "person", personId: rhea },
          amount: { minor: 99_900, currency: "INR" },
          dateAt: Date.parse("2026-11-18T18:29:59Z"),
          dateAllDay: true,
          fields: {
            direction: "debit",
            reference: "0000632211110077",
            account: "HDFC Bank ••4821",
          },
        },
      );
      const tally = yield* takeAlerts(orgId, {
        connectionId: "work-mail",
        threadId: "t2",
        messages: [
          alert(
            "<m2@hdfc>",
            "Rs.999.00 has been debited from account **4821 to VPA cafe@okaxis LAKEVIEW CAFE on 18-11-26. Your UPI transaction reference number is 632211110077.",
          ),
        ],
        now: NOW,
      });
      assert.deepStrictEqual(tally, { recorded: 0, duplicate: 1, rejected: 0 });
      assert.strictEqual((yield* entries).length, 2);
    }),
  );

  it.effect("what doesn't read is counted, and the newest Avl bal is the account's", () =>
    Effect.gen(function* () {
      const tally = yield* takeAlerts(orgId, {
        connectionId: "work-mail",
        threadId: "t3",
        messages: [
          alert("<m3@hdfc>", "Dear Customer, your statement is ready."),
          { ...alert("<m4@hdfc>", debit("632211110004")), authResults: [] },
          { ...alert("<m5@x>", debit("632211110005")), fromAddress: "alerts@hdfcbank.example" },
          alert(
            "<m6@hdfc>",
            debit("632211110006", "3,90,000.00"),
            "Wed, 18 Nov 2026 11:30:00 +0530",
          ),
          alert(
            "<m7@hdfc>",
            debit("632211110007", "4,00,000.00"),
            "Wed, 18 Nov 2026 11:00:00 +0530",
          ),
        ],
        now: NOW,
      });
      // Another sender's mail in the thread is no alert, so it isn't counted as one.
      assert.deepStrictEqual(tally, { recorded: 2, duplicate: 0, rejected: 2 });
      assert.deepStrictEqual(yield* rejectedAlerts(orgId, 0), { unverified: 1, unparsed: 1 });
      assert.deepStrictEqual(yield* alertBalances(orgId), [
        {
          bank: "HDFC Bank",
          account: "4821",
          currency: "INR",
          balanceMinor: 39_000_000,
          sentAt: Date.parse("2026-11-18T06:00:00Z"),
        },
      ]);
    }),
  );
});
