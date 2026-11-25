// Loaded first: the chat and trigger modules import each other.
import "../../chat/KinChatService.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { KinAgentId, KinChatError, KinOrgId, KinPersonId } from "@t3tools/contracts";
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
import { presetDefinition } from "../registers.ts";
import { takeAlerts } from "./bankAlerts.ts";
import { ensureBankList, findBankList } from "./bankList.ts";
import { repaidMatches } from "./debitRepaid.ts";
import { drawRepaid, markRepaid, repaidLine } from "./repaidCard.ts";
import { repaidSeenSenses } from "../../pulse/senses/bank.ts";

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

        const matches = (yield* repaidMatches(orgId, NOW)).map((one) => ({
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
            marked: undefined,
          },
          // A rupee short, or counting an expense from after it: nothing adds up, nothing is split.
          {
            title: "ZOYA RAO zoya.rao@invented",
            minor: 12_399_00,
            partner: "Zoya Rao",
            repays: undefined,
            owed: 13_400_00n,
            marked: undefined,
          },
          {
            title: "ZOYA RAO zoya.rao@invented",
            minor: 13_400_00,
            partner: "Zoya Rao",
            repays: undefined,
            owed: 13_400_00n,
            marked: undefined,
          },
          // Arjun's 2,000 adds up to EXP-5, but the same money was marked repaid by hand that day.
          {
            title: "ARJUN MEHTA arjun.m@invented",
            minor: 2_000_00,
            partner: "Arjun Mehta",
            repays: ["EXP-5"],
            owed: 2_000_00n,
            marked: "2026-11-24",
          },
        ]);
      }),
  );
});

/** An invented company of its own: Rhea owns it, Zoya Rao funds expenses, all in Asia/Kolkata. */
const company = Effect.fn("test.company")(function* (org: KinOrgId) {
  yield* TestClock.setTime(NOW);
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_orgs VALUES (${org}, 'Ambermill Studio', '2026-09-01')`;
  yield* sql`INSERT INTO kin_trigger_settings VALUES (${org}, 'Asia/Kolkata', '08:00', '18:00',
      '02:00', 0, 1, '09:00', '{}')`;
  for (const [id, name, access] of [
    [`${org}-rhea`, "Rhea Kapoor", "owner"],
    [`${org}-zoya`, "Zoya Rao", "member"],
  ] as const)
    yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
      VALUES (${id}, ${org}, ${id}, ${name}, '2026-09-01', ${access})`;
  yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in, created_at, definition_json)
    VALUES (${org}, 'expenses', 'expenses', 'EXP', 0, 0, ${JSON.stringify(presetDefinition("expenses", "INR"))})`;
  const bank = yield* ensureBankList(org, NOW);
  const row = (
    key: string,
    list: string,
    title: string,
    rupees: number,
    on: string,
    fields: object,
    state: string,
  ) =>
    sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, state, owner_kind,
        owner_id, date_at, amount_minor, currency, confirmed, created_by_kind, created_by_id,
        origin_key, created_at, updated_at, fields_json)
      VALUES (${org}, ${`${org}-${key}`}, ${list}, ${key}, ${title}, ${state}, 'person',
        ${`${org}-rhea`}, ${day(on)}, ${rupees * 100}, 'INR', 1, 'person', ${`${org}-rhea`},
        ${key}, 0, 0, ${JSON.stringify(fields)})`;
  const zoya = `person:${org}-zoya`;
  const toldFacts = (at: number) =>
    repaidSeenSenses({
      orgId: org,
      at,
      zone: "Asia/Kolkata",
      chief: undefined,
      finance: KinAgentId.make("finance"),
      tech: undefined,
      liveAgents: new Set(),
    });
  const drawPlan = (key: string) =>
    drawRepaid(org, key, {
      agentId: "finance",
      wakeupId: "w-1",
      ceiling: "owner",
      people: [`${org}-rhea`],
      askers: [`${org}-rhea`],
    });
  return {
    sql,
    expense: (key: string, rupees: number, on: string, fields: object = {}) =>
      row(key, "expenses", `Phone bill ${key}`, rupees, on, { fundedBy: zoya, ...fields }, "done"),
    debit: (key: string, rupees: number, on: string, title = "ZOYA RAO zoya.rao@invented") =>
      row(key, bank.id, title, rupees, on, { direction: "debit" }, "open"),
    credit: (key: string, rupees: number, on: string) =>
      row(key, bank.id, "Tidewater Freight", rupees, on, { direction: "credit" }, "open"),
    /** What Finance is told now, and what a draw of the card for `key` answers. */
    told: (at = NOW) => Effect.map(toldFacts(at), (facts) => facts.map((fact) => fact.key)),
    toldFacts,
    drawPlan,
    draw: (key: string) =>
      drawPlan(key).pipe(
        Effect.match({
          onFailure: (error) => error.message,
          onSuccess: (plan) => plan.repays.map((one) => one.key).join(" "),
        }),
      ),
  };
});

const cardMarkedCompany = Effect.fn("test.cardMarkedCompany")(function* (org: KinOrgId) {
  const kin = yield* company(org);
  const records = yield* KinRecords.KinRecords;
  const owner = {
    actor: { _tag: "person" as const, personId: KinPersonId.make(`${org}-rhea`) },
    via: "owner" as const,
  };
  yield* kin.expense("EXP-4", 5_000, "2026-10-01", { reimbursement: "owed" });
  yield* kin.expense("EXP-8", 5_000, "2026-11-01", { reimbursement: "owed" });
  yield* kin.debit("BNK-9", 5_000, "2026-11-20");
  const plan = yield* kin.drawPlan("BNK-9");
  assert.deepStrictEqual(
    plan.repays.map((one) => one.key),
    ["EXP-4"],
  );
  const outcome = yield* kin.sql.withTransaction(markRepaid(org, plan, owner, records));
  assert.strictEqual(outcome?.title, "Marked repaid");
  return { kin, records, owner };
});

it.layer(layer)((it) => {
  it.effect("newer unexplained credits do not hide a repayment debit", () =>
    Effect.gen(function* () {
      const org = KinOrgId.make("ambermill-bank-window");
      const kin = yield* company(org);
      yield* kin.expense("EXP-8", 5_000, "2026-11-01", { reimbursement: "owed" });
      yield* kin.debit("BNK-9", 5_000, "2026-11-20");
      assert.lengthOf(yield* repaidMatches(org, NOW), 1);

      for (let index = 0; index < 201; index++) {
        yield* kin.credit(`BNK-${100 + index}`, 900, "2026-11-21");
      }

      const matches = yield* repaidMatches(org, NOW);
      assert.deepStrictEqual(
        matches.map((match) => ({
          debit: match.debit.key,
          repays: match.repays?.map((expense) => expense.key),
        })),
        [{ debit: "BNK-9", repays: ["EXP-8"] }],
      );
    }),
  );

  // The same phone bill each month: Zoya is paid 5,000 on the 20th and the owner marks the
  // older one repaid by hand two days later. That 5,000 must not also repay the newer one.
  it.effect("a hand mark of the same money within ten days of the debit stops the card", () =>
    Effect.gen(function* () {
      const kin = yield* company(KinOrgId.make("ambermill-recurring"));
      yield* kin.expense("EXP-4", 5_000, "2026-10-01", {
        reimbursement: "repaid",
        repaidOn: "2026-11-22",
      });
      yield* kin.expense("EXP-8", 5_000, "2026-11-01", { reimbursement: "owed" });
      yield* kin.debit("BNK-9", 5_000, "2026-11-20");
      assert.deepStrictEqual(yield* kin.told(), []);
      assert.strictEqual(
        yield* kin.draw("BNK-9"),
        "BNK-9 may be the repayment already marked by hand for Zoya Rao on 2026-11-22, so Kin offers no card for it. Nothing was asked; tell the owner what you see instead.",
      );
    }),
  );

  it.effect(
    "a second debit within ten days of one a card marked is raised, not taken for a hand mark",
    () =>
      Effect.gen(function* () {
        const org = KinOrgId.make("ambermill-second-debit");
        const { kin, records, owner } = yield* cardMarkedCompany(org);

        const at = day("2026-11-25");
        yield* TestClock.setTime(at);
        yield* kin.debit("BNK-12", 5_000, "2026-11-25");
        assert.deepStrictEqual(yield* kin.told(at), ["repaid_seen:BNK-12"]);
        const [fact] = yield* kin.toldFacts(at);
        assert.strictEqual(fact!.wake, "now");
        assert.include(fact!.consequence, "EXP-8");
        assert.strictEqual(yield* kin.draw("BNK-12"), "EXP-8");
        const matches = yield* repaidMatches(org, at);
        assert.lengthOf(matches, 1);
        assert.isUndefined(matches[0]!.marked);

        const handOrg = KinOrgId.make("ambermill-second-debit-hand-mark");
        const hand = yield* company(handOrg);
        yield* TestClock.setTime(at);
        yield* hand.expense("EXP-4", 5_000, "2026-10-01", {
          reimbursement: "repaid",
          repaidOn: "2026-11-20",
        });
        yield* hand.expense("EXP-8", 5_000, "2026-11-01", { reimbursement: "owed" });
        yield* hand.debit("BNK-12", 5_000, "2026-11-25");
        assert.deepStrictEqual(yield* hand.told(at), []);
        assert.strictEqual(
          yield* hand.draw("BNK-12"),
          "BNK-12 may be the repayment already marked by hand for Zoya Rao on 2026-11-20, so Kin offers no card for it. Nothing was asked; tell the owner what you see instead.",
        );

        yield* records.update(org, owner, "BNK-9", { state: "open", category: null });
        const reopened = (yield* repaidMatches(org, at)).find((one) => one.debit.key === "BNK-9");
        assert.strictEqual(reopened?.marked, "2026-11-20");
        assert.deepStrictEqual(yield* kin.told(at), ["repaid_seen:BNK-12"]);
      }),
  );

  it.effect("the same payment recorded twice gets no second card", () =>
    Effect.gen(function* () {
      const org = KinOrgId.make("ambermill-duplicate-debit");
      const { kin } = yield* cardMarkedCompany(org);
      yield* kin.debit("BNK-10", 5_000, "2026-11-20", "UPI to Zoya Rao");
      yield* kin.debit("BNK-11", 5_000, "2026-11-22", "UPI debit to Zoya Rao");

      assert.deepStrictEqual(yield* kin.told(), []);
      for (const key of ["BNK-10", "BNK-11"])
        assert.strictEqual(
          yield* kin.draw(key),
          `${key} may be the repayment already marked by hand for Zoya Rao on 2026-11-20, so Kin offers no card for it. Nothing was asked; tell the owner what you see instead.`,
        );
    }),
  );

  it.effect("a mark tied to a dropped bank entry stops a debit as a hand mark does", () =>
    Effect.gen(function* () {
      const org = KinOrgId.make("ambermill-dropped-debit");
      const { kin, records, owner } = yield* cardMarkedCompany(org);
      yield* records.update(org, owner, "BNK-9", { state: "dropped" });

      const at = day("2026-11-25");
      yield* TestClock.setTime(at);
      yield* kin.debit("BNK-12", 5_000, "2026-11-25");

      assert.deepStrictEqual(yield* kin.told(at), []);
      assert.strictEqual(
        yield* kin.draw("BNK-12"),
        "BNK-12 may be the repayment already marked by hand for Zoya Rao on 2026-11-20, so Kin offers no card for it. Nothing was asked; tell the owner what you see instead.",
      );
    }),
  );

  it.effect("a hand mark on another day is not taken for the old card's tie", () =>
    Effect.gen(function* () {
      const org = KinOrgId.make("ambermill-later-hand-mark");
      const { kin, records, owner } = yield* cardMarkedCompany(org);
      yield* records.update(org, owner, "EXP-4", {
        fields: { reimbursement: "owed", repaidOn: null },
      });

      const at = day("2026-11-27");
      yield* TestClock.setTime(at);
      yield* records.update(org, owner, "EXP-4", {
        fields: { reimbursement: "repaid", repaidOn: "2026-11-27" },
      });
      yield* kin.debit("BNK-14", 5_000, "2026-11-27");

      assert.deepStrictEqual(yield* kin.told(at), []);
      assert.strictEqual(
        yield* kin.draw("BNK-14"),
        "BNK-14 may be the repayment already marked by hand for Zoya Rao on 2026-11-27, so Kin offers no card for it. Nothing was asked; tell the owner what you see instead.",
      );
    }),
  );

  // The same, with Repaid on left blank: the day the mark was written stands in, in the
  // company's zone (21 Nov 20:00 UTC is 22 Nov in Kolkata).
  it.effect("a hand mark with no repaid day counts from the day it was written", () =>
    Effect.gen(function* () {
      const org = KinOrgId.make("ambermill-blank-day");
      const kin = yield* company(org);
      yield* kin.expense("EXP-4", 5_000, "2026-10-01", { reimbursement: "repaid" });
      yield* kin.sql`INSERT INTO kin_record_changes (org_id, record_id, rev, at, actor_kind,
          actor_id, via, kind, fields_json)
        VALUES (${org}, ${`${org}-EXP-4`}, 2, ${Date.parse("2026-11-21T20:00:00Z")}, 'person',
          ${`${org}-rhea`}, 'owner', 'updated',
          '[{"field":"reimbursement","from":"owed","to":"repaid"}]')`;
      yield* kin.expense("EXP-8", 5_000, "2026-11-01", { reimbursement: "owed" });
      yield* kin.debit("BNK-9", 5_000, "2026-11-20");
      assert.deepStrictEqual(yield* kin.told(), []);
      assert.strictEqual(
        yield* kin.draw("BNK-9"),
        "BNK-9 may be the repayment already marked by hand for Zoya Rao on 2026-11-22, so Kin offers no card for it. Nothing was asked; tell the owner what you see instead.",
      );
    }),
  );

  // A debit from before anything was owed, or a salary, can't have repaid these expenses: no
  // "doesn't add up" line for them. An ordinary debit that doesn't add up keeps its line.
  it.effect("a debit that can't have repaid anything gets no line", () =>
    Effect.gen(function* () {
      const kin = yield* company(KinOrgId.make("ambermill-old-debits"));
      yield* kin.expense("EXP-8", 5_000, "2026-11-01", { reimbursement: "owed" });
      yield* kin.debit("BNK-3", 7_000, "2026-10-25");
      yield* kin.debit("BNK-4", 30_000, "2026-11-21", "NEFT-ZOYA RAO-SALARY NOV");
      yield* kin.debit("BNK-5", 9_000, "2026-11-21");
      assert.deepStrictEqual(yield* kin.told(), ["repaid_seen:BNK-5:short"]);
      assert.strictEqual(
        yield* kin.draw("BNK-3"),
        "BNK-3 names Zoya Rao but doesn't add up exactly to their oldest owed expenses, so Kin marks nothing and offers no card for it. Nothing was asked; tell the owner what you see instead.",
      );
    }),
  );

  // Typed with a day still to come: a repaid day can't be after today, so no card is offered.
  it.effect("a debit dated after today raises nothing and draws no card", () =>
    Effect.gen(function* () {
      const kin = yield* company(KinOrgId.make("ambermill-ahead"));
      yield* kin.expense("EXP-8", 5_000, "2026-11-01", { reimbursement: "owed" });
      yield* kin.debit("BNK-6", 5_000, "2026-11-26");
      assert.deepStrictEqual(yield* kin.told(), []);
      assert.strictEqual(
        yield* kin.draw("BNK-6"),
        "BNK-6 is dated after today, so Kin offers no card for it.",
      );
    }),
  );
});

// The line shows what the debit itself says, quoted and cut at a whole word, so a payment to a
// shop that only shares a word with a partner's name reads as one.
it("the card's line quotes the debit's own words, cut to fit", () => {
  const plan = (narration: string) => ({
    kind: "mark_repaid" as const,
    recordId: "r-bnk-9",
    key: "BNK-9",
    rev: 1,
    amountMinor: 2_400_00,
    currency: "INR",
    day: "2026-11-20",
    narration,
    partner: { id: "kiran", name: "Kiran" },
    repays: [
      { recordId: "r-exp-3", key: "EXP-3", rev: 1, amountMinor: 2_400_00, day: "2026-11-02" },
    ],
    owedAfterMinor: 0,
    draw: {
      agentId: "finance",
      wakeupId: "w-1",
      ceiling: "owner" as const,
      people: [],
      askers: [],
    },
  });
  assert.strictEqual(
    repaidLine(plan("SRI KIRANA STORES")),
    'Mark EXP-3 (₹2,400.00) repaid on 20 Nov by BNK-9 "SRI KIRANA STORES"; nothing more is owed to Kiran',
  );
  assert.strictEqual(
    repaidLine(plan('UPI-SRI KIRANA  STORES-kirana@okaxis-PAYMENT FROM "PHONE" 632211110009 REF')),
    "Mark EXP-3 (₹2,400.00) repaid on 20 Nov by BNK-9 \"UPI-SRI KIRANA STORES-kirana@okaxis-PAYMENT FROM 'PHONE'…\"; nothing more is owed to Kiran",
  );
  assert.isAtMost(
    repaidLine({ ...plan("SRI KIRANA STORES"), partner: { id: "k", name: "K".repeat(150) } })
      .length,
    200,
  );
});
