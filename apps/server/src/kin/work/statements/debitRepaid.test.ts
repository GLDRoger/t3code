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
import * as KinRecords from "../KinRecords.ts";
import { takeAlerts } from "./bankAlerts.ts";
import { findBankList } from "./bankList.ts";
import { repaidMatches } from "./debitRepaid.ts";

// Invented: Ambermill's owner Rhea gets HDFC alerts; Zoya and Arjun paid bills from their own cards.
const orgId = KinOrgId.make("ambermill-repaid");
const rhea = KinPersonId.make("ambermill-rhea");
const NOW = Date.parse("2026-11-24T12:00:00Z");
const AUTH = [
  "mx.google.com; dkim=pass header.i=@hdfcbank.net; spf=pass smtp.mailfrom=alerts@hdfcbank.net; dmarc=pass (p=REJECT) header.from=hdfcbank.net",
];

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
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-debit-repaid-" })),
  Layer.provideMerge(NodeServices.layer),
);

const day = (iso: string) => Date.parse(`${iso}T12:00:00Z`);

it.layer(layer)((it) => {
  it.effect(
    "a debit naming one partner is matched only when it pays back their oldest exactly",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Ambermill Studio', '2026-11-01')`;
        // The company's clock, which its days follow, on any host.
        yield* sql`INSERT INTO kin_trigger_settings VALUES (${orgId}, 'Asia/Kolkata', '08:00',
          '18:00', '02:00', 0, 1, '09:00', '{}')`;
        for (const [id, name, access] of [
          [rhea, "Rhea Kapoor", "owner"],
          ["zoya", "Zoya Rao", "member"],
          ["arjun", "Arjun Mehta", "member"],
        ] as const)
          yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at,
            access)
          VALUES (${id}, ${orgId}, ${id}, ${name}, '2026-11-01', ${access})`;
        yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in,
          created_at)
        VALUES (${orgId}, 'expenses', 'expenses', 'EXP', 1, 0)`;
        const expense = (key: string, rupees: number, on: string, fields: object) =>
          sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, state,
            owner_kind, owner_id, date_at, amount_minor, currency, confirmed, created_by_kind,
            created_by_id, origin_key, created_at, updated_at, fields_json)
          VALUES (${orgId}, ${`r-${key}`}, 'expenses', ${key}, ${`Supplier bill ${key}`}, 'done',
            'person', ${rhea}, ${day(on)}, ${rupees * 100}, 'INR', 1, 'person', ${rhea},
            ${key}, 0, 0, ${JSON.stringify(fields)})`;
        const owedTo = (person: string) => ({
          fundedBy: `person:${person}`,
          reimbursement: "owed",
        });
        yield* expense("EXP-4", 5_000, "2026-11-02", owedTo("zoya"));
        yield* expense("EXP-7", 4_200, "2026-11-09", owedTo("zoya"));
        yield* expense("EXP-9", 3_200, "2026-11-16", owedTo("zoya"));
        // Paid after the debit: it can't be what the debit paid back.
        yield* expense("EXP-12", 1_000, "2026-11-26", owedTo("zoya"));
        yield* expense("EXP-5", 2_000, "2026-11-02", owedTo("arjun"));
        // Marked repaid by hand on the 24th, with no bank line.
        yield* expense("EXP-6", 2_000, "2026-11-03", {
          fundedBy: "person:arjun",
          reimbursement: "repaid",
          repaidOn: "2026-11-24",
        });

        // A UPI debit alert names its payee: Kin's entry for it carries the name it read.
        const upi = (reference: string, rupees: string, payee: string) => ({
          messageId: `<${reference}@hdfc>`,
          fromAddress: "alerts@hdfcbank.net",
          subject: "You have done a UPI txn. Check details!",
          date: "Tue, 24 Nov 2026 10:00:00 +0530",
          authResults: AUTH,
          text: `Rs.${rupees} has been debited from account **4821 to VPA ${payee} on 24-11-26. Your UPI transaction reference number is ${reference}. Avl bal: INR 4,10,000.00`,
        });
        assert.deepInclude(
          yield* takeAlerts(orgId, {
            connectionId: "work-mail",
            threadId: "t1",
            now: NOW,
            messages: [
              upi("633011110009", "12,400.00", "zoya.rao@invented ZOYA RAO"),
              upi("633011110010", "12,399.00", "zoya.rao@invented ZOYA RAO"),
              upi("633011110011", "13,400.00", "zoya.rao@invented ZOYA RAO"),
              upi("633011110012", "7,000.00", "split@invented ZOYA RAO ARJUN MEHTA"),
              upi("633011110013", "2,000.00", "arjun.m@invented ARJUN MEHTA"),
            ],
          }),
          { recorded: 5 },
        );
        const bank = (yield* findBankList(orgId))!;
        // One an agent wrote is never the bank's word that money went out.
        yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, state,
          owner_kind, owner_id, date_at, amount_minor, currency, confirmed, created_by_kind,
          created_by_id, origin_key, created_at, updated_at, fields_json)
        VALUES (${orgId}, 'r-typed', ${bank.id}, 'BNK-90', 'UPI/Zoya Rao/reimb', 'open', 'person',
          ${rhea}, ${day("2026-11-24")}, 1240000, 'INR', 1, 'agent', 'finance', 'typed', 0, 0,
          '{"direction":"debit"}')`;

        const matches = (yield* repaidMatches(orgId)).map((one) => ({
          title: one.debit.title,
          minor: one.debit.amountMinor,
          partner: one.partner.name,
          repays: one.repays?.map((each) => each.key),
          owed: one.owedMinor,
          marked: one.marked,
        }));
        assert.sameDeepMembers(matches, [
          {
            title: "ZOYA RAO zoya.rao@invented",
            minor: 12_400_00,
            partner: "Zoya Rao",
            repays: ["EXP-4", "EXP-7", "EXP-9"],
            owed: 13_400_00n,
            marked: false,
          },
          // A rupee short, or counting an expense from after it: nothing adds up, nothing is split.
          {
            title: "ZOYA RAO zoya.rao@invented",
            minor: 12_399_00,
            partner: "Zoya Rao",
            repays: undefined,
            owed: 13_400_00n,
            marked: false,
          },
          {
            title: "ZOYA RAO zoya.rao@invented",
            minor: 13_400_00,
            partner: "Zoya Rao",
            repays: undefined,
            owed: 13_400_00n,
            marked: false,
          },
          // Arjun's 2,000 adds up to EXP-5, but the same total was marked repaid by hand that day.
          {
            title: "ARJUN MEHTA arjun.m@invented",
            minor: 2_000_00,
            partner: "Arjun Mehta",
            repays: ["EXP-5"],
            owed: 2_000_00n,
            marked: true,
          },
        ]);
      }),
  );
});
