// Loaded first: the chat and trigger modules import each other.
import "../../chat/KinChatService.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { KinAgentId, KinChatError, KinOrgId, KinPersonId } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";
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
import * as BankAlertReader from "./BankAlertReader.ts";
import {
  approveFixtureAlertSender,
  fixtureBankAlertReader,
  seedFixtureAlertMailbox,
} from "./bankAlerts.testkit.ts";
import { partnerPayees, partnersOwed } from "../partnersOwed.ts";
import { ensureBankList, findBankList } from "./bankList.ts";
import { repaidMatch, repaidMatches } from "./debitRepaid.ts";
import { drawRepaid, markRepaid, repaidLine, undoRepaid } from "./repaidCard.ts";
import { applyStatement, undoStatement } from "./statementApply.ts";
import { reviewCard } from "./statementCard.ts";
import { buildReview, storeReview } from "./statementReview.ts";
import type { Statement } from "./statementTable.ts";
import { bankDebitSenses } from "../../pulse/senses/bank.ts";

// Invented: Ambermill's owner Rhea gets Harbor Bank alerts; Zoya and Arjun paid bills from their own cards.
const orgId = KinOrgId.make("ambermill-repaid");
const rhea = KinPersonId.make("ambermill-rhea");
const NOW = Date.parse("2026-11-24T12:00:00Z");
const AUTH = [
  "mx.google.com; dkim=pass header.i=@harborbank.example; spf=pass smtp.mailfrom=alerts@harborbank.example; dmarc=pass (p=REJECT) header.from=harborbank.example",
];

const layer = Layer.mergeAll(
  KinRecords.layer,
  Layer.succeed(BankAlertReader.BankAlertReader, fixtureBankAlertReader),
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
        yield* approveFixtureAlertSender(orgId, rhea);
        yield* seedFixtureAlertMailbox(orgId, "work-mail");
        const upi = (reference: string, rupees: string, payee: string) => ({
          messageId: `<${reference}@harborbank.example>`,
          fromAddress: "alerts@harborbank.example",
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
            title: "ZOYA RAO",
            minor: 12_400_00,
            partner: "Zoya Rao",
            repays: ["EXP-4", "EXP-7", "EXP-9"],
            owed: 13_400_00n,
            marked: undefined,
          },
          // A rupee short, or counting an expense from after it: nothing adds up, nothing is split.
          {
            title: "ZOYA RAO",
            minor: 12_399_00,
            partner: "Zoya Rao",
            repays: undefined,
            owed: 13_400_00n,
            marked: undefined,
          },
          {
            title: "ZOYA RAO",
            minor: 13_400_00,
            partner: "Zoya Rao",
            repays: undefined,
            owed: 13_400_00n,
            marked: undefined,
          },
          // Arjun's 2,000 adds up to EXP-5, but the same money was marked repaid by hand that day.
          {
            title: "ARJUN MEHTA",
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
    [`${org}-arjun`, "Arjun Mehta", "member"],
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
    bankDebitSenses({
      orgId: org,
      at,
      zone: "Asia/Kolkata",
      chief: undefined,
      finance: KinAgentId.make("finance"),
      tech: undefined,
      liveAgents: new Set(),
    }).pipe(Effect.map((facts) => facts.filter((fact) => fact.sense === "repaid_seen")));
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
    debit: (key: string, rupees: number, on: string, title = "ZOYA RAO") =>
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
  assert.strictEqual(outcome?.outcome.title, "Marked repaid");
  return { kin, records, owner };
});

const arjunDebit = "UPI ARJUN MEHTA";
const handMark = (org: KinOrgId) => ({
  fundedBy: `person:${org}-arjun`,
  reimbursement: "repaid",
  repaidOn: "2026-11-18",
});
const repaymentStatement = (amountMinor: number): Statement => ({
  kind: "account",
  bank: null,
  account: "4821",
  currency: "INR",
  from: null,
  to: null,
  openingMinor: null,
  closingMinor: null,
  check: { status: "adds_up", line: "" },
  rows: [
    {
      index: 0,
      date: "2026-11-21",
      description: arjunDebit,
      reference: null,
      amountMinor,
      direction: "debit",
      balanceMinor: null,
      foreign: null,
    },
  ],
});

const repaymentReview = Effect.fn("test.repaymentReview")(function* (
  orgId: KinOrgId,
  amountMinor: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const personId = KinPersonId.make(`${orgId}-rhea`);
  const agentId = `${orgId}-finance`;
  const statementId = "st-repayment";
  const statement = repaymentStatement(amountMinor);
  const review = yield* buildReview(orgId, statement, null, "file", statementId);
  const card = reviewCard(statementId, review, []);
  yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
    VALUES (${agentId}, ${orgId}, 'Finance', 'specialist', ${personId}, '2026-11-01')`;
  yield* sql`INSERT INTO kin_bank_statements (org_id, statement_id, attachment_id, file_name,
      chat_id, agent_id, wakeup_id, status, account, review_json, review_hash, created_at)
    VALUES (${orgId}, ${statementId}, 'statement', 'harbor-bank.csv', 'finance-chat', ${agentId},
      'wake', 'read', ${statement.account}, ${yield* storeReview(review)}, ${card.hash}, ${NOW})`;
  const input = { orgId, personId, statementId, now: NOW };
  return {
    statement,
    apply: applyStatement({ ...input, hash: card.hash, revision: 0 }),
    undo: undoStatement(input),
    owner: { actor: { _tag: "person" as const, personId }, via: "owner" as const },
  };
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

  it.effect.each([
    [2_000, 0, 0],
    [2_000, 3, 1],
    [5_000, 3, 2],
  ] as const)(
    "reads only repayment assignment pages with %s open debits and %s marks",
    ([count, marks, expectedPages]) =>
      Effect.gen(function* () {
        const org = KinOrgId.make(`ambermill-assignment-pages-${count}-${marks}`);
        const kin = yield* company(org);
        const bank = (yield* findBankList(org))!;
        yield* kin.expense("EXP-8", 1_200, "2026-09-01", { reimbursement: "owed" });
        yield* kin.debit("BNK-9", 1_200, "2026-11-20");
        yield* kin.sql`WITH RECURSIVE seq(n) AS (
            SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ${count - 1}
          )
          INSERT INTO kin_records (org_id, record_id, register_id, key, title, state,
            owner_kind, owner_id, date_at, amount_minor, currency, confirmed, created_by_kind,
            created_by_id, origin_key, created_at, updated_at, fields_json)
          SELECT ${org}, ${org} || '-filler-' || n, ${bank.id}, 'BNK-' || (100 + n),
            'Tidewater Freight', 'open', 'person', ${`${org}-rhea`},
            ${NOW} - ((n - 1) * ${365 * 86_400_000}) / ${count},
            90000, 'INR', 1, 'person', ${`${org}-rhea`}, 'filler-' || n, 0, 0,
            '{"direction":"debit"}' FROM seq`;
        for (const [index, date] of ["2026-11-16", "2026-11-19", "2026-11-22"]
          .slice(0, marks)
          .entries())
          yield* kin.expense(`EXP-${index + 4}`, 1_200, "2026-09-01", {
            reimbursement: "repaid",
            repaidOn: date,
          });

        let pages = 0;
        const tracer = Tracer.make({
          span(options) {
            const span = new Tracer.NativeSpan(options);
            const end = span.end.bind(span);
            span.end = (time, exit) => {
              end(time, exit);
              const query = span.attributes.get("db.query.text");
              if (
                span.kind === "client" &&
                typeof query === "string" &&
                query.includes("ORDER BY r.date_at DESC, r.record_id DESC") &&
                !query.includes("AND r.record_id = ?")
              )
                pages++;
            };
            return span;
          },
        });
        const match = yield* repaidMatch(org, `${org}-BNK-9`, NOW).pipe(Effect.withTracer(tracer));
        assert.strictEqual(match?.marked, marks === 0 ? undefined : "2026-11-16");
        assert.strictEqual(pages, expectedPages);
      }),
  );

  it.effect("the bank pulse does not raise an old debit beyond the newest 200", () =>
    Effect.gen(function* () {
      const org = KinOrgId.make("ambermill-old-bank-debit");
      const kin = yield* company(org);
      yield* kin.expense("EXP-8", 1_200, "2026-09-01", { reimbursement: "owed" });
      yield* kin.expense("EXP-4", 1_200, "2026-09-01", {
        reimbursement: "repaid",
        repaidOn: "2026-11-16",
      });
      yield* kin.debit("BNK-9", 1_200, "2026-09-17");
      for (let index = 0; index < 199; index++)
        yield* kin.debit(`BNK-${100 + index}`, 900, "2026-11-20", "Tidewater Freight");
      yield* kin.debit("BNK-10", 1_200, "2026-11-21");
      yield* kin.debit("BNK-11", 1_200, "2026-11-22");

      assert.deepStrictEqual(yield* kin.told(), ["repaid_seen:BNK-11"]);
    }),
  );

  it.effect("an individual or total same-day hand mark stops another repayment card", () =>
    Effect.gen(function* () {
      const org = KinOrgId.make("ambermill-recurring");
      const kin = yield* company(org);
      const records = yield* KinRecords.KinRecords;
      const owner = {
        actor: { _tag: "person" as const, personId: KinPersonId.make(`${org}-rhea`) },
        via: "owner" as const,
      };
      for (const [key, amount, on] of [
        ["EXP-4", 1_200, "2026-10-01"],
        ["EXP-5", 800, "2026-10-02"],
        ["EXP-8", 1_200, "2026-11-01"],
      ] as const)
        yield* kin.expense(key, amount, on, { reimbursement: "owed" });
      for (const [key, amount] of [
        ["BNK-9", 1_200],
        ["BNK-10", 2_000],
        ["BNK-11", 500],
      ] as const)
        yield* kin.debit(key, amount, key === "BNK-9" ? "2026-11-22" : "2026-11-23");
      const marked = () =>
        Effect.map(repaidMatches(org, NOW), (matches) =>
          Object.fromEntries(matches.map((match) => [match.debit.key, match.marked])),
        );
      const mark = (key: string, reimbursement: string, repaidOn: string | null) =>
        records.update(org, owner, key, { fields: { reimbursement, repaidOn } });
      // The debits came before the marks: nothing is marked yet.
      assert.deepStrictEqual(yield* marked(), {
        "BNK-9": undefined,
        "BNK-10": undefined,
        "BNK-11": undefined,
      });
      yield* mark("EXP-4", "repaid", "2026-11-22");
      yield* mark("EXP-5", "repaid", "2026-11-22");
      assert.deepStrictEqual(yield* marked(), {
        "BNK-9": "2026-11-22",
        "BNK-10": undefined,
        "BNK-11": undefined,
      });
      assert.strictEqual(
        yield* kin.draw("BNK-9"),
        "BNK-9 may be the repayment already marked by hand for Zoya Rao on 2026-11-22, so Kin offers no card for it. Nothing was asked; tell the owner what you see instead.",
      );
      // One of the day's two marks set back to owed: the other still explains its own debit.
      yield* mark("EXP-5", "owed", null);
      assert.deepStrictEqual(yield* marked(), {
        "BNK-9": "2026-11-22",
        "BNK-10": undefined,
        "BNK-11": undefined,
      });
    }),
  );

  it.effect("evidence dated away from a hand mark does not spend the mark", () =>
    Effect.gen(function* () {
      const org = KinOrgId.make("tidewater-repayment-evidence");
      const kin = yield* company(org);
      const records = yield* KinRecords.KinRecords;
      const owner = {
        actor: { _tag: "person" as const, personId: KinPersonId.make(`${org}-rhea`) },
        via: "owner" as const,
      };
      yield* kin.expense("EXP-4", 1_200, "2026-10-01", {
        reimbursement: "repaid",
        repaidOn: "2026-11-18",
      });
      yield* kin.expense("EXP-8", 1_200, "2026-11-01", { reimbursement: "owed" });
      yield* kin.debit("BNK-7", 1_200, "2026-10-01", "Inkspot Cloud");
      yield* records.link(org, owner, `${org}-EXP-4`, {
        kind: "record",
        relation: "evidence",
        target: `${org}-BNK-7`,
      });
      yield* kin.debit("BNK-9", 1_200, "2026-11-21");

      assert.strictEqual((yield* repaidMatch(org, `${org}-BNK-9`, NOW))?.marked, "2026-11-18");
      const statement = repaymentStatement(120_000);
      const review = yield* buildReview(
        org,
        { ...statement, rows: [{ ...statement.rows[0]!, description: "ZOYA RAO" }] },
        null,
        "file",
        "st-existing-evidence",
      );
      assert.deepStrictEqual(review.matches.get(0)?.candidates, []);
    }),
  );

  it.effect("Confirm ties a hand mark so a later debit can repay another expense", () =>
    Effect.gen(function* () {
      const org = KinOrgId.make("tidewater-confirm-repayment");
      const kin = yield* company(org);
      const records = yield* KinRecords.KinRecords;
      yield* kin.expense("EXP-4", 1_200, "2026-10-01", handMark(org));
      yield* kin.expense("EXP-8", 1_200, "2026-11-01", {
        fundedBy: handMark(org).fundedBy,
        reimbursement: "owed",
      });
      yield* kin.debit("BNK-9", 1_200, "2026-11-21", arjunDebit);
      const review = yield* repaymentReview(org, 120_000);
      const { card } = yield* review.apply;
      const bankAfterConfirm = yield* records.get(org, "BNK-9");
      // Explaining the first debit used to free its mark.
      yield* records.update(org, review.owner, "BNK-9", { state: "done" });
      yield* kin.debit("BNK-10", 1_200, "2026-11-23", arjunDebit);

      assert.strictEqual(yield* kin.draw("BNK-10"), "EXP-8");
      assert.strictEqual(bankAfterConfirm?.state, "done");
      assert.include(card.result, "Linked 1 paid expense to their bank rows.");
      assert.notInclude(card.result, "Marked 1 partner-paid expense repaid.");
      assert.include(JSON.parse((yield* records.get(org, "EXP-4"))!.fieldsJson), {
        reimbursement: "repaid",
        repaidOn: "2026-11-21",
      });
      assert.deepStrictEqual(
        yield* kin.sql`SELECT record_id AS "recordId", target, relation FROM kin_record_links
          WHERE org_id = ${org} AND kind = 'record' ORDER BY record_id`,
        [
          { recordId: `${org}-BNK-9`, target: `${org}-EXP-4`, relation: "relates" },
          { recordId: `${org}-EXP-4`, target: `${org}-BNK-9`, relation: "evidence" },
        ],
      );
      const again = yield* buildReview(org, review.statement, null, "file", "st-reupload");
      assert.strictEqual(again.matches.size, 0);
    }),
  );

  it.effect("Undo restores the hand repayment day and frees the debit", () =>
    Effect.gen(function* () {
      const org = KinOrgId.make("tidewater-undo-repayment");
      const kin = yield* company(org);
      const records = yield* KinRecords.KinRecords;
      yield* kin.expense("EXP-4", 1_200, "2026-10-01", handMark(org));
      yield* kin.expense("EXP-8", 1_200, "2026-11-01", {
        fundedBy: handMark(org).fundedBy,
        reimbursement: "owed",
      });
      const review = yield* repaymentReview(org, 120_000);
      yield* review.apply;
      const { card } = yield* review.undo;

      assert.include(card.result, "Undone: 1 row taken back (1 expense).");
      assert.deepStrictEqual(
        JSON.parse((yield* records.get(org, "EXP-4"))!.fieldsJson),
        handMark(org),
      );
      assert.deepStrictEqual(
        yield* kin.sql`SELECT target FROM kin_record_links WHERE org_id = ${org}`,
        [],
      );
      assert.strictEqual((yield* records.get(org, "BNK-1"))?.state, "open");
      assert.strictEqual(
        (yield* repaidMatch(org, (yield* records.get(org, "BNK-1"))!.recordId, NOW))?.marked,
        "2026-11-18",
      );
      assert.include(
        (yield* review.apply).card.result,
        "Linked 1 paid expense to their bank rows.",
      );
    }),
  );

  it.effect.each([
    ["an edit to the expense", "EXP-4 was edited"],
    ["a newly filed debit", "Something changed"],
    ["a new evidence link", "Something changed"],
  ] as const)("Confirm refuses a stale hand mark after %s", ([change, message]) =>
    Effect.gen(function* () {
      const org = KinOrgId.make(`tidewater-stale-repayment-${change.replaceAll(" ", "-")}`);
      const kin = yield* company(org);
      const records = yield* KinRecords.KinRecords;
      yield* kin.expense("EXP-4", 1_200, "2026-10-01", handMark(org));
      const review = yield* repaymentReview(org, 120_000);
      if (change === "an edit to the expense")
        yield* records.update(org, review.owner, "EXP-4", { title: "Inkspot Cloud" });
      if (change === "a newly filed debit")
        yield* kin.debit("BNK-7", 1_200, "2026-11-19", arjunDebit);
      if (change === "a new evidence link") {
        yield* kin.debit("BNK-7", 1_200, "2026-10-01", "Inkspot Cloud");
        yield* records.link(org, review.owner, `${org}-EXP-4`, {
          kind: "record",
          relation: "evidence",
          target: `${org}-BNK-7`,
        });
      }

      const error = yield* Effect.flip(review.apply);
      assert.include(error.message, message);
      assert.notExists(yield* records.get(org, "BNK-1"));
      assert.deepStrictEqual(
        JSON.parse((yield* records.get(org, "EXP-4"))!.fieldsJson),
        handMark(org),
      );
    }),
  );

  it.effect("Confirm ties every expense in a hand-marked day total", () =>
    Effect.gen(function* () {
      const org = KinOrgId.make("tidewater-day-total-repayment");
      const kin = yield* company(org);
      const records = yield* KinRecords.KinRecords;
      for (const [key, amount] of [
        ["EXP-4", 1_200],
        ["EXP-5", 800],
      ] as const)
        yield* kin.expense(key, amount, "2026-10-01", handMark(org));
      const review = yield* repaymentReview(org, 200_000);
      const { card } = yield* review.apply;
      assert.include(card.result, "Linked 2 paid expenses to their bank rows.");
      assert.deepInclude(card.matched[0]?.target, {
        label: "EXP-4, EXP-5 · Arjun Mehta",
        note: "Looks like Arjun Mehta's repayment already marked on 2026-11-18, so it isn't recorded again",
      });
      const bank = (yield* records.get(org, "BNK-1"))!;
      assert.strictEqual(bank.state, "done");
      assert.deepStrictEqual(
        yield* kin.sql`SELECT record_id AS "recordId" FROM kin_record_links
          WHERE org_id = ${org} AND target = ${bank.recordId} AND relation = 'evidence'
          ORDER BY record_id`,
        [{ recordId: `${org}-EXP-4` }, { recordId: `${org}-EXP-5` }],
      );
      for (const key of ["EXP-4", "EXP-5"])
        assert.include(JSON.parse((yield* records.get(org, key))!.fieldsJson), {
          reimbursement: "repaid",
          repaidOn: "2026-11-21",
        });
    }),
  );

  it.effect.each(
    (
      [
        ["one-mark-first", [1_200], [1_200, 1_200], "marks"],
        ["one-debits-first", [1_200], [1_200, 1_200], "debits"],
        ["one-statement-first", [1_200], [1_200, 1_200], "statement"],
        ["two-equal", [1_200, 1_200], [1_200, 1_200, 1_200], "debits"],
        ["two-unequal", [1_200, 800], [1_200, 1_200], "marks"],
        ["single-before-total", [1_200, 800], [1_200, 2_000], "marks"],
        ["total-before-single", [1_200, 800], [2_000, 1_200], "marks"],
        ["same-day-key-order", [1_200], [1_200, 1_200], "debits"],
      ] as const
    ).map(([name, marks, amounts, order]) => ({ name, marks, amounts, order })),
  )(
    "shares the repayment assignment for $name between list, statement, draw and tap",
    ({ name, marks, amounts, order }) =>
      Effect.gen(function* () {
        const org = KinOrgId.make(`ambermill-${name}`);
        const kin = yield* company(org);
        const records = yield* KinRecords.KinRecords;
        const owner = {
          actor: { _tag: "person" as const, personId: KinPersonId.make(`${org}-rhea`) },
          via: "owner" as const,
        };
        const markDay = "2026-11-18";
        const paid = { reimbursement: "repaid", repaidOn: markDay };
        const offered = amounts.length - 1;
        const debits = amounts.map((amount, index) => ({
          index,
          key: `BNK-${10 + index}`,
          day:
            index === 0 || name === "same-day-key-order"
              ? "2026-11-19"
              : index === 1
                ? "2026-11-21"
                : "2026-11-22",
          amount,
          title: `UPI ZOYA RAO payment ${index}`,
        }));
        const statement = (rows: typeof debits): Statement => ({
          kind: "account",
          bank: null,
          account: "4821",
          currency: "INR",
          from: null,
          to: null,
          openingMinor: null,
          closingMinor: null,
          check: { status: "unchecked", line: "" },
          rows: rows.map((one, index) => ({
            index,
            date: one.day,
            description: one.title,
            reference: null,
            amountMinor: one.amount * 100,
            direction: "debit",
            balanceMinor: null,
            foreign: null,
          })),
        });
        const read = (rows: typeof debits, id = "st-repaid") =>
          buildReview(org, statement(rows), null, "file", id);
        const drawMarks = () =>
          Effect.forEach(marks, (amount, index) =>
            kin.expense(`EXP-${index + 4}`, amount, "2026-10-01", paid),
          );
        yield* kin.expense("EXP-8", amounts[offered]!, "2026-11-01", { reimbursement: "owed" });
        if (order !== "debits") yield* drawMarks();
        if (order === "statement") {
          const draft = yield* read(debits);
          assert.deepStrictEqual(
            [...draft.matches.values()].map(
              (one) => one.suggestion.why?.includes("repayment already marked") ?? false,
            ),
            [true, false],
          );
        }
        for (const one of debits.toReversed())
          yield* kin.debit(one.key, one.amount, one.day, one.title);
        if (order === "debits") yield* drawMarks();

        const bank = yield* repaidMatches(org, NOW);
        const single = yield* Effect.forEach(debits, (one) =>
          repaidMatch(org, `${org}-${one.key}`, NOW),
        );
        assert.deepStrictEqual(
          single,
          debits.map((one) => bank.find((match) => match.debit.key === one.key)),
        );
        assert.deepStrictEqual(
          single.map((one) => one?.marked ?? null),
          debits.map((_, index) => (index === offered ? null : markDay)),
        );
        for (const one of debits.slice(0, offered))
          assert.include(yield* kin.draw(one.key), "repayment already marked by hand");

        // Re-read the entire statement and upload again with only the last debit shown.
        // Other open debits already on file still compete, even if not in the uploaded period.
        for (const [rows, id] of [
          [debits, "st-repaid"],
          [debits, "st-repaid"],
          [debits.slice(offered), "st-reuploaded"],
        ] as const) {
          const review = yield* read(rows, id);
          assert.deepStrictEqual(
            [...review.known.values()].map((one) => one.key),
            rows.map((one) => one.key),
          );
          assert.deepStrictEqual(
            [...review.matches.values()].map(
              (one) => one.suggestion.why?.includes("repayment already marked") ?? false,
            ),
            rows.map((one) => one.index !== offered),
          );
        }
        const plan = yield* kin.drawPlan(debits[offered]!.key);
        assert.deepStrictEqual(
          plan.repays.map((one) => one.key),
          ["EXP-8"],
        );
        const outcome = yield* kin.sql.withTransaction(markRepaid(org, plan, owner, records));
        assert.strictEqual(outcome?.outcome.title, "Marked repaid");
      }),
  );

  it.effect("an unfiled statement debit competes with open debits outside the statement", () =>
    Effect.gen(function* () {
      const org = KinOrgId.make("ambermill-draft-repaid");
      const kin = yield* company(org);
      yield* kin.expense("EXP-4", 1_200, "2026-10-01", {
        reimbursement: "repaid",
        repaidOn: "2026-11-18",
      });
      yield* kin.expense("EXP-8", 1_200, "2026-11-01", { reimbursement: "owed" });
      yield* kin.debit("BNK-10", 1_200, "2026-11-19");
      const draft: Statement = {
        kind: "account",
        bank: null,
        account: "4821",
        currency: "INR",
        from: null,
        to: null,
        openingMinor: null,
        closingMinor: null,
        check: { status: "unchecked", line: "" },
        rows: [
          {
            index: 0,
            date: "2026-11-21",
            description: "UPI ZOYA RAO",
            reference: null,
            amountMinor: 120_000,
            direction: "debit",
            balanceMinor: null,
            foreign: null,
          },
        ],
      };
      for (const id of ["st-upload", "st-reupload"]) {
        const review = yield* buildReview(org, draft, null, "file", id);
        assert.strictEqual(review.known.size, 0);
        assert.deepStrictEqual(
          review.matches.get(0)?.candidates[0]?.repays?.map((one) => one.key),
          ["EXP-8"],
        );
      }
      const includingFiled = yield* buildReview(
        org,
        {
          ...draft,
          rows: [...draft.rows, { ...draft.rows[0]!, index: 1, date: "2026-11-19" }],
        },
        null,
        "file",
        "st-including-filed",
      );
      assert.deepStrictEqual(
        [...includingFiled.matches.values()].map((match) =>
          match.candidates[0]?.repays?.map((one) => one.key),
        ),
        [["EXP-8"], ["EXP-4"]],
      );
    }),
  );

  it.effect("an earlier possible duplicate cannot take an open debit's own tie", () =>
    Effect.gen(function* () {
      const org = KinOrgId.make("ambermill-reopened-tie");
      const { kin, records, owner } = yield* cardMarkedCompany(org);
      yield* kin.debit("BNK-7", 5_000, "2026-11-19");
      yield* records.update(org, owner, "BNK-9", { state: "open" });
      assert.sameDeepMembers(
        (yield* repaidMatches(org, NOW)).map((match) => [match.debit.key, match.marked]),
        [
          ["BNK-7", undefined],
          ["BNK-9", "2026-11-20"],
        ],
      );
    }),
  );

  it.effect(
    "taking back one equal hand mark offers the last debit again and rechecks old cards",
    () =>
      Effect.gen(function* () {
        const org = KinOrgId.make("ambermill-equal-undo");
        const kin = yield* company(org);
        const records = yield* KinRecords.KinRecords;
        const owner = {
          actor: { _tag: "person" as const, personId: KinPersonId.make(`${org}-rhea`) },
          via: "owner" as const,
        };
        const markDay = "2026-11-18";
        yield* kin.expense("EXP-4", 1_200, "2026-10-01", {
          reimbursement: "repaid",
          repaidOn: markDay,
        });
        yield* kin.expense("EXP-8", 1_200, "2026-10-15", { reimbursement: "owed" });
        yield* kin.debit("BNK-10", 1_200, "2026-11-19");
        yield* kin.debit("BNK-11", 1_200, "2026-11-21");
        const marked = () =>
          Effect.map(repaidMatches(org, NOW), (matches) =>
            Object.fromEntries(matches.map((match) => [match.debit.key, match.marked])),
          );

        yield* kin.expense("EXP-5", 1_200, "2026-11-01", {
          reimbursement: "repaid",
          repaidOn: markDay,
        });
        assert.deepStrictEqual(yield* marked(), { "BNK-10": markDay, "BNK-11": markDay });
        yield* records.update(org, owner, "EXP-5", {
          fields: { reimbursement: "owed", repaidOn: null },
        });
        assert.deepStrictEqual(yield* marked(), { "BNK-10": markDay, "BNK-11": undefined });
        assert.deepStrictEqual(yield* kin.told(), ["repaid_seen:BNK-11"]);

        const plan = yield* kin.drawPlan("BNK-11");
        // Explaining an earlier debit elsewhere frees the mark; the old card must record nothing.
        yield* records.update(org, owner, "BNK-10", { state: "done" });
        assert.deepStrictEqual(yield* marked(), { "BNK-11": markDay });
        const outcome = yield* kin.sql.withTransaction(markRepaid(org, plan, owner, records));
        assert.isUndefined(outcome);
        assert.strictEqual((yield* records.get(org, "BNK-11"))?.state, "open");
      }),
  );

  it.effect("taking back a mark of a day whose total explained a debit frees that total", () =>
    Effect.gen(function* () {
      const org = KinOrgId.make("ambermill-total-undo");
      const kin = yield* company(org);
      const records = yield* KinRecords.KinRecords;
      const owner = {
        actor: { _tag: "person" as const, personId: KinPersonId.make(`${org}-rhea`) },
        via: "owner" as const,
      };
      const markDay = "2026-11-18";
      for (const [key, amount] of [
        ["EXP-4", 1_200],
        ["EXP-5", 800],
      ] as const)
        yield* kin.expense(key, amount, "2026-10-01", {
          reimbursement: "repaid",
          repaidOn: markDay,
        });
      yield* kin.expense("EXP-8", 1_200, "2026-10-15", { reimbursement: "owed" });
      yield* kin.debit("BNK-10", 2_000, "2026-11-19");
      yield* kin.debit("BNK-11", 1_200, "2026-11-21");
      const marked = () =>
        Effect.map(repaidMatches(org, NOW), (matches) =>
          Object.fromEntries(matches.map((match) => [match.debit.key, match.marked])),
        );
      // The day's total explains the earlier debit, so neither mark explains the later one.
      assert.deepStrictEqual(yield* marked(), { "BNK-10": markDay, "BNK-11": undefined });
      yield* records.update(org, owner, "EXP-5", {
        fields: { reimbursement: "owed", repaidOn: null },
      });
      assert.deepStrictEqual(yield* marked(), { "BNK-10": undefined, "BNK-11": markDay });
      yield* records.update(org, owner, "EXP-4", {
        fields: { reimbursement: "owed", repaidOn: null },
      });
      assert.deepStrictEqual(yield* marked(), { "BNK-10": undefined, "BNK-11": undefined });
    }),
  );

  it.effect("a mark's ten days are the company's days, either side of its midnight", () =>
    Effect.gen(function* () {
      const org = KinOrgId.make("ambermill-midnight");
      const kin = yield* company(org);
      const bank = (yield* findBankList(org))!;
      for (const key of ["EXP-4", "EXP-5"])
        yield* kin.expense(key, 1_200, "2026-09-01", {
          reimbursement: "repaid",
          repaidOn: "2026-11-10",
        });
      yield* kin.expense("EXP-8", 1_200, "2026-09-15", { reimbursement: "owed" });
      // 00:15 in Asia/Kolkata: 31 October there, ten days before the marks, though 30 October in UTC;
      // and 21 November there, eleven days after them, though 20 November in UTC.
      for (const [key, at] of [
        ["BNK-8", "2026-10-30T18:45:00Z"],
        ["BNK-10", "2026-11-20T18:45:00Z"],
      ] as const)
        yield* kin.sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, state,
            owner_kind, owner_id, date_at, amount_minor, currency, confirmed, created_by_kind,
            created_by_id, origin_key, created_at, updated_at, fields_json)
          VALUES (${org}, ${`${org}-${key}`}, ${bank.id}, ${key}, 'ZOYA RAO', 'open', 'person',
            ${`${org}-rhea`}, ${Date.parse(at)}, 120000, 'INR', 1, 'person', ${`${org}-rhea`},
            ${key}, 0, 0, '{"direction":"debit"}')`;
      assert.deepStrictEqual(
        Object.fromEntries(
          (yield* repaidMatches(org, NOW)).map((match) => [match.debit.key, match.marked]),
        ),
        { "BNK-8": "2026-11-10", "BNK-10": undefined },
      );
    }),
  );

  it.effect(
    "a second debit within ten days of one a card marked is raised, not taken for a hand mark",
    () =>
      Effect.gen(function* () {
        const org = KinOrgId.make("ambermill-second-debit");
        const { kin, records, owner } = yield* cardMarkedCompany(org);
        yield* kin.expense("EXP-5", 800, "2026-10-02", {
          reimbursement: "repaid",
          repaidOn: "2026-11-20",
        });

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

  it.effect("a card's mark undone leaves its debit unmarked and offered again", () =>
    Effect.gen(function* () {
      const org = KinOrgId.make("ambermill-undo-mark");
      const kin = yield* company(org);
      const records = yield* KinRecords.KinRecords;
      const owner = {
        actor: { _tag: "person" as const, personId: KinPersonId.make(`${org}-rhea`) },
        via: "owner" as const,
      };
      yield* kin.expense("EXP-4", 5_000, "2026-10-01", { reimbursement: "owed" });
      yield* kin.expense("EXP-5", 800, "2026-10-02", {
        reimbursement: "repaid",
        repaidOn: "2026-11-20",
      });
      yield* kin.expense("EXP-8", 5_000, "2026-11-01", { reimbursement: "owed" });
      yield* kin.debit("BNK-9", 5_000, "2026-11-20");
      yield* kin.debit("BNK-10", 800, "2026-11-21");
      const plan = yield* kin.drawPlan("BNK-9");
      const done = yield* kin.sql.withTransaction(markRepaid(org, plan, owner, records));
      yield* kin.sql.withTransaction(undoRepaid(org, done!.undo!, owner, records));

      const matches = yield* repaidMatches(org, NOW);
      assert.sameDeepMembers(
        matches.map((match) => [
          match.debit.key,
          match.marked,
          match.repays?.map((one) => one.key),
        ]),
        [
          ["BNK-9", undefined, ["EXP-4"]],
          ["BNK-10", "2026-11-20", undefined],
        ],
      );
      assert.include(yield* kin.told(), "repaid_seen:BNK-9");
    }),
  );

  it.effect("a debit naming two partners with one name is no one's repayment", () =>
    Effect.gen(function* () {
      const org = KinOrgId.make("ambermill-two-zoyas");
      const kin = yield* company(org);
      yield* kin.sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at,
          access)
        VALUES (${`${org}-zoya-2`}, ${org}, 'zoya-2', 'Zoya Rao', '2026-09-01', 'member')`;
      yield* kin.expense("EXP-4", 1_200, "2026-10-01", {
        fundedBy: `person:${org}-zoya-2`,
        reimbursement: "repaid",
        repaidOn: "2026-11-22",
      });
      yield* kin.expense("EXP-8", 1_200, "2026-11-01", { reimbursement: "owed" });
      yield* kin.debit("BNK-9", 1_200, "2026-11-23", "UPI ZOYA RAO");
      assert.deepStrictEqual(yield* repaidMatches(org, NOW), []);
    }),
  );

  it.effect("the two-day duplicate total protects one debit, not every nearby debit", () =>
    Effect.gen(function* () {
      const org = KinOrgId.make("ambermill-duplicate-debit");
      const { kin } = yield* cardMarkedCompany(org);
      yield* kin.debit("BNK-10", 5_000, "2026-11-22", "UPI to Zoya Rao");
      yield* kin.debit("BNK-11", 5_000, "2026-11-22", "UPI debit to Zoya Rao");

      assert.deepStrictEqual(yield* kin.told(), ["repaid_seen:BNK-11"]);
      assert.strictEqual(
        yield* kin.draw("BNK-10"),
        "BNK-10 may be the repayment already marked by hand for Zoya Rao on 2026-11-20, so Kin offers no card for it. Nothing was asked; tell the owner what you see instead.",
      );
      assert.strictEqual(yield* kin.draw("BNK-11"), "EXP-8");
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

/** A statement of Arjun's debits read and stored for Rhea's Confirm; content differs by its rows. */
const arjunReview = Effect.fn("test.arjunReview")(function* (
  orgId: KinOrgId,
  statementId: string,
  rows: ReadonlyArray<
    readonly [date: string, amountMinor: number, description?: string | undefined]
  >,
  currency = "INR",
) {
  const sql = yield* SqlClient.SqlClient;
  const personId = KinPersonId.make(`${orgId}-rhea`);
  const agentId = `${orgId}-finance`;
  const statement: Statement = {
    ...repaymentStatement(0),
    currency,
    rows: rows.map(([date, amountMinor, description = arjunDebit], index) => ({
      index,
      date,
      description,
      reference: null,
      amountMinor,
      direction: "debit" as const,
      balanceMinor: null,
      foreign: null,
    })),
  };
  const review = yield* buildReview(orgId, statement, null, "file", statementId);
  const card = reviewCard(statementId, review, []);
  yield* sql`INSERT OR IGNORE INTO kin_agents (agent_id, org_id, display_name, role,
      owner_person_id, created_at)
    VALUES (${agentId}, ${orgId}, 'Finance', 'specialist', ${personId}, '2026-11-01')`;
  yield* sql`INSERT INTO kin_bank_statements (org_id, statement_id, attachment_id, file_name,
      chat_id, agent_id, wakeup_id, status, account, review_json, review_hash, created_at)
    VALUES (${orgId}, ${statementId}, ${statementId}, 'harbor-bank.csv', 'finance-chat', ${agentId},
      ${statementId}, 'read', ${statement.account}, ${yield* storeReview(review)}, ${card.hash},
      ${NOW})`;
  const as = (who: string) => ({
    orgId,
    personId: KinPersonId.make(who),
    statementId,
    now: NOW,
  });
  return {
    review,
    ties: rows.map(
      (_, index) =>
        review.matches
          .get(index)
          ?.candidates.find((one) => one.alreadyRepaid)
          ?.repays?.map((one) => one.key) ?? null,
    ),
    apply: applyStatement({ ...as(personId), hash: card.hash, revision: 0 }),
    applyAs: (who: string) => applyStatement({ ...as(who), hash: card.hash, revision: 0 }),
    undo: undoStatement(as(personId)),
    undoAs: (who: string) => undoStatement(as(who)),
  };
});

const fieldsOf = Effect.fn("test.fieldsOf")(function* (org: KinOrgId, key: string) {
  const records = yield* KinRecords.KinRecords;
  return JSON.parse((yield* records.get(org, key))!.fieldsJson) as Record<string, unknown>;
});

it.layer(layer)((it) => {
  it.effect.each([
    // [case, marks [key, rupees, expense day, repaid on], owed [key, rupees], rows, ties, owed after, repaid on after]
    [
      "one mark and one equal debit",
      [["EXP-4", 1_200, "2026-10-01", "2026-11-18"]],
      [["EXP-8", 1_200]],
      [["2026-11-21", 120_000]],
      [["EXP-4"]],
      ["EXP-8"],
      { "EXP-4": "2026-11-21" },
    ],
    [
      "a mark then two equal debits: the second is not silenced",
      [["EXP-4", 1_200, "2026-10-01", "2026-11-18"]],
      [["EXP-8", 1_200]],
      [
        ["2026-11-21", 120_000],
        ["2026-11-23", 120_000],
      ],
      [["EXP-4"], null],
      [],
      { "EXP-4": "2026-11-21", "EXP-8": "2026-11-23" },
    ],
    [
      "two marks and one debit",
      [
        ["EXP-4", 1_200, "2026-10-01", "2026-11-18"],
        ["EXP-5", 1_200, "2026-10-02", "2026-11-18"],
      ],
      [],
      [["2026-11-21", 120_000]],
      [["EXP-4"]],
      [],
      { "EXP-4": "2026-11-21", "EXP-5": "2026-11-18" },
    ],
    [
      "a debit of a different amount",
      [["EXP-4", 1_200, "2026-10-01", "2026-11-18"]],
      [],
      [["2026-11-21", 110_000]],
      [null],
      [],
      { "EXP-4": "2026-11-18" },
    ],
    [
      "a debit in another currency",
      [["EXP-4", 1_200, "2026-10-01", "2026-11-18"]],
      [],
      [["2026-11-21", 120_000, arjunDebit, "USD"]],
      [null],
      [],
      { "EXP-4": "2026-11-18" },
    ],
    [
      "a debit to another partner of the same amount",
      [["EXP-4", 1_200, "2026-10-01", "2026-11-18"]],
      [],
      [["2026-11-21", 120_000, "UPI ZOYA RAO"]],
      [null],
      [],
      { "EXP-4": "2026-11-18" },
    ],
    [
      "a mark dated after the debit",
      [["EXP-4", 1_200, "2026-10-01", "2026-11-24"]],
      [],
      [["2026-11-21", 120_000]],
      [["EXP-4"]],
      [],
      { "EXP-4": "2026-11-21" },
    ],
    [
      "an expense dated after the debit",
      [["EXP-4", 1_200, "2026-11-22", "2026-11-22"]],
      [],
      [["2026-11-21", 120_000]],
      [null],
      [],
      { "EXP-4": "2026-11-22" },
    ],
    [
      "a partial repayment",
      [["EXP-4", 1_200, "2026-10-01", "2026-11-18"]],
      [],
      [["2026-11-21", 60_000]],
      [null],
      [],
      { "EXP-4": "2026-11-18" },
    ],
    [
      "amounts a paisa apart",
      [["EXP-4", 1_200, "2026-10-01", "2026-11-18"]],
      [],
      [["2026-11-21", 120_001]],
      [null],
      [],
      { "EXP-4": "2026-11-18" },
    ],
  ] as const)("the sums: %s", ([name, marks, owed, rows, ties, owedAfter, repaidOnAfter]) =>
    Effect.gen(function* () {
      const org = KinOrgId.make(`tidewater-sums-${name.replace(/[^a-z]+/g, "-")}`);
      const kin = yield* company(org);
      for (const [key, rupees, on, repaidOn] of marks)
        yield* kin.expense(key, rupees, on, { ...handMark(org), repaidOn });
      for (const [key, rupees] of owed)
        yield* kin.expense(key, rupees, "2026-11-01", {
          fundedBy: handMark(org).fundedBy,
          reimbursement: "owed",
        });
      const lines = rows as ReadonlyArray<readonly [string, number, string?, string?]>;
      const review = yield* arjunReview(
        org,
        "st-sums",
        lines.map(([date, minor, description]) => [date, minor, description] as const),
        lines[0]![3] ?? "INR",
      );
      const owedNow = Effect.map(partnersOwed(org, "INR"), (partners) =>
        partners
          .filter((one) => one.personId === `${org}-arjun`)
          .flatMap((one) => one.entries.map((entry) => entry.key)),
      );
      assert.deepStrictEqual<unknown>(review.ties, ties);
      assert.deepStrictEqual<unknown>(
        yield* owedNow,
        owed.map(([key]) => key),
      );
      yield* review.apply;
      assert.deepStrictEqual<unknown>(yield* owedNow, owedAfter);
      for (const [key, day] of Object.entries(repaidOnAfter as Record<string, string>))
        assert.include(yield* fieldsOf(org, key), { reimbursement: "repaid", repaidOn: day }, key);
      // A hand mark left untied keeps no link; a tied one has exactly its two.
      for (const [key] of marks) {
        const links = yield* kin.sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_record_links
          WHERE org_id = ${org} AND (record_id = ${`${org}-${key}`} OR target = ${`${org}-${key}`})`;
        const tied = (ties as ReadonlyArray<ReadonlyArray<string> | null>).some(
          (one) => one?.includes(key) === true,
        );
        assert.strictEqual(links[0]!.n, tied ? 2 : 0, key);
      }
    }),
  );

  it.effect.each([
    ["with a repaid-on day", "2026-11-18"],
    ["with no repaid-on day", undefined],
  ] as const)("a full Undo returns the hand mark byte for byte, %s", ([, repaidOn]) =>
    Effect.gen(function* () {
      const org = KinOrgId.make(`tidewater-bytes-${repaidOn ?? "none"}`);
      const kin = yield* company(org);
      const { repaidOn: _day, ...unDated } = handMark(org);
      yield* kin.expense(
        "EXP-4",
        1_200,
        "2026-10-01",
        repaidOn === undefined ? unDated : handMark(org),
      );
      // Marked by hand on the 18th: with no repaid-on day, that day is the mark's.
      yield* kin.sql`UPDATE kin_records SET created_at = ${day("2026-11-18")}
        WHERE record_id = ${`${org}-EXP-4`}`;
      const row = () =>
        kin.sql<
          Record<string, unknown>
        >`SELECT * FROM kin_records WHERE record_id = ${`${org}-EXP-4`}`;
      const [before] = yield* row();
      const payeeDay = Effect.map(partnerPayees(org), (payees) =>
        payees.flatMap((one) => one.repaid.map((each) => each.day)),
      );
      assert.deepStrictEqual(yield* payeeDay, ["2026-11-18"]);
      const review = yield* arjunReview(org, "st-bytes", [["2026-11-21", 120_000]]);
      assert.deepStrictEqual(review.ties, [["EXP-4"]]);
      yield* review.apply;
      assert.deepStrictEqual(yield* payeeDay, []);
      yield* review.undo;
      const [after] = yield* row();
      const moved = Object.keys(before!).filter((column) => before![column] !== after![column]);
      // Only the bookkeeping a write must move: its revision and when it was last written.
      assert.deepStrictEqual(moved.toSorted(), ["rev", "updated_at"]);
      assert.strictEqual(after!.fields_json, before!.fields_json);
      assert.deepStrictEqual(yield* payeeDay, ["2026-11-18"]);
      assert.deepStrictEqual(
        (yield* kin.sql<{
          kind: string;
          fieldsJson: string;
        }>`SELECT kind, fields_json AS "fieldsJson"
          FROM kin_record_changes WHERE record_id = ${`${org}-EXP-4`} ORDER BY seq`).map((one) => [
          one.kind,
          JSON.parse(one.fieldsJson),
        ]),
        [
          ["updated", [{ field: "repaidOn", from: repaidOn ?? null, to: "2026-11-21" }]],
          // Undo takes the link off with no line of its own: the history keeps "linked".
          ["linked", [{ field: "record", from: null, to: "Account ••4821 · 2026-11-21 · BNK-1" }]],
          ["updated", [{ field: "repaidOn", from: "2026-11-21", to: repaidOn ?? null }]],
        ],
      );
      assert.deepStrictEqual(
        yield* kin.sql`SELECT * FROM kin_record_links WHERE org_id = ${org}`,
        [],
      );
      assert.deepStrictEqual(
        yield* kin.sql`SELECT * FROM kin_bank_statement_entries WHERE org_id = ${org}`,
        [],
      );
    }),
  );

  it.effect("the tie and the statement's own rows commit together or not at all", () =>
    Effect.gen(function* () {
      const org = KinOrgId.make("tidewater-tie-atomic");
      const kin = yield* company(org);
      for (const key of ["EXP-4", "EXP-5"])
        yield* kin.expense(key, 1_000, "2026-10-01", handMark(org));
      const review = yield* arjunReview(org, "st-atomic", [["2026-11-21", 200_000]]);
      assert.deepStrictEqual(review.ties, [["EXP-4", "EXP-5"]]);
      // The second expense's link fails after the first expense was rewritten and linked.
      const error = yield* Effect.flip(
        review.apply.pipe(
          Effect.updateService(KinRecords.KinRecords, (records) => ({
            ...records,
            link: (orgId, writer, recordId, link) =>
              recordId === `${org}-EXP-5`
                ? Effect.fail(new KinChatError({ reason: "unavailable", message: "link failed" }))
                : records.link(orgId, writer, recordId, link),
          })),
        ),
      );
      assert.strictEqual(error.message, "link failed");
      for (const key of ["EXP-4", "EXP-5"])
        assert.deepStrictEqual(yield* fieldsOf(org, key), handMark(org));
      for (const table of ["kin_record_links", "kin_bank_statement_entries"] as const)
        assert.deepStrictEqual(
          yield* kin.sql`SELECT * FROM ${kin.sql(table)} WHERE org_id = ${org}`,
          [],
        );
      const bank = (yield* findBankList(org))!;
      assert.deepStrictEqual(
        yield* kin.sql`SELECT key FROM kin_records WHERE org_id = ${org} AND register_id = ${bank.id}`,
        [],
      );
      assert.include(
        (yield* review.apply).card.result,
        "Linked 2 paid expenses to their bank rows.",
      );
    }),
  );

  it.effect("only the owner ties or unties; a co-owner's Confirm or Undo changes nothing", () =>
    Effect.gen(function* () {
      const org = KinOrgId.make("tidewater-tie-owner-only");
      const kin = yield* company(org);
      yield* kin.sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at,
          access)
        VALUES (${`${org}-meera`}, ${org}, 'meera', 'Meera Iyer', '2026-09-01', 'co_owner')`;
      yield* kin.expense("EXP-4", 1_200, "2026-10-01", handMark(org));
      const review = yield* arjunReview(org, "st-owner", [["2026-11-21", 120_000]]);
      for (const who of [`${org}-meera`, `${org}-zoya`])
        assert.deepInclude(yield* Effect.flip(review.applyAs(who)), { reason: "not_allowed" });
      assert.deepStrictEqual(yield* fieldsOf(org, "EXP-4"), handMark(org));
      yield* review.apply;
      for (const who of [`${org}-meera`, `${org}-zoya`])
        assert.deepInclude(yield* Effect.flip(review.undoAs(who)), { reason: "not_allowed" });
      assert.include(yield* fieldsOf(org, "EXP-4"), { repaidOn: "2026-11-21" });
    }),
  );

  it.effect.each(["Confirm twice", "Confirm and Undo", "Undo and Confirm"] as const)(
    "two taps at once tie at most once: %s",
    (taps) =>
      Effect.gen(function* () {
        const org = KinOrgId.make(`tidewater-tie-race-${taps.replaceAll(" ", "-").toLowerCase()}`);
        const kin = yield* company(org);
        yield* kin.expense("EXP-4", 1_200, "2026-10-01", handMark(org));
        const review = yield* arjunReview(org, "st-race", [["2026-11-21", 120_000]]);
        const tap = (name: string) =>
          Effect.exit(
            name === "Confirm" ? Effect.asVoid(review.apply) : Effect.asVoid(review.undo),
          );
        const [first, second] =
          taps === "Confirm twice" ? ["Confirm", "Confirm"] : taps.split(" and ");
        const exits = yield* Effect.all([tap(first!), tap(second!)], { concurrency: 2 });
        const links = (yield* kin.sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_record_links
          WHERE org_id = ${org} AND record_id = ${`${org}-EXP-4`}`)[0]!.n;
        const entries = (yield* kin.sql<{ n: number }>`SELECT COUNT(*) AS n
          FROM kin_bank_statement_entries WHERE org_id = ${org}`)[0]!.n;
        const fields = yield* fieldsOf(org, "EXP-4");
        // Whatever won, the books agree with themselves: tied once, or the hand mark as it was.
        if (entries === 0) {
          assert.deepStrictEqual(fields, handMark(org));
          assert.strictEqual(links, 0);
        } else {
          assert.strictEqual(entries, 1);
          assert.strictEqual(links, 1);
          assert.include(fields, { repaidOn: "2026-11-21" });
        }
        assert.deepStrictEqual(
          exits.map((one) => one._tag),
          taps === "Confirm twice"
            ? ["Success", "Failure"]
            : taps === "Confirm and Undo"
              ? ["Success", "Success"]
              : ["Failure", "Success"],
        );
      }),
  );

  it.effect.each(["first", "second"] as const)(
    "two statements claiming one mark: the %s confirmed ties it, the other is refused",
    (which) =>
      Effect.gen(function* () {
        const org = KinOrgId.make(`tidewater-two-statements-${which}`);
        const kin = yield* company(org);
        yield* kin.expense("EXP-4", 1_200, "2026-10-01", handMark(org));
        const one = yield* arjunReview(org, "st-one", [["2026-11-21", 120_000]]);
        const two = yield* arjunReview(org, "st-two", [["2026-11-22", 120_000]]);
        assert.deepStrictEqual([one.ties, two.ties], [[["EXP-4"]], [["EXP-4"]]]);
        const [winner, loser] = which === "first" ? [one, two] : [two, one];
        yield* winner.apply;
        assert.include((yield* Effect.flip(loser.apply)).message, "Nothing was applied");
        assert.strictEqual(
          (yield* kin.sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_record_links
            WHERE org_id = ${org} AND record_id = ${`${org}-EXP-4`}`)[0]!.n,
          1,
        );
        assert.include(yield* fieldsOf(org, "EXP-4"), {
          repaidOn: which === "first" ? "2026-11-21" : "2026-11-22",
        });
      }),
  );

  it.effect("Undo after a rename and after the partner left still unties, keeping the rename", () =>
    Effect.gen(function* () {
      const org = KinOrgId.make("tidewater-undo-after");
      const kin = yield* company(org);
      const records = yield* KinRecords.KinRecords;
      const owner = {
        actor: { _tag: "person" as const, personId: KinPersonId.make(`${org}-rhea`) },
        via: "owner" as const,
      };
      yield* kin.expense("EXP-4", 1_200, "2026-10-01", handMark(org));
      yield* kin.expense("EXP-5", 800, "2026-10-01", { ...handMark(org), repaidOn: "2026-11-10" });
      const review = yield* arjunReview(org, "st-after", [
        ["2026-11-21", 120_000],
        ["2026-11-12", 80_000],
      ]);
      assert.deepStrictEqual(review.ties, [["EXP-4"], ["EXP-5"]]);
      yield* review.apply;
      yield* records.update(org, owner, "EXP-4", { title: "Inkspot Cloud" });
      // What the bank tied stays as the bank saw it until that repayment is undone.
      assert.include(
        (yield* Effect.flip(
          records.update(org, owner, "EXP-5", { fields: { repaidOn: "2026-11-10" } }),
        )).message,
        "This was paid back on 2026-11-12. Undo that repayment first.",
      );
      yield* kin.sql`UPDATE kin_people SET removed_at = ${NOW} WHERE person_id = ${`${org}-arjun`}`;
      const { card } = yield* review.undo;
      assert.deepStrictEqual(card.result, [
        "Undone: 2 rows taken back (2 expenses).",
        "Confirm again to apply the rows taken back.",
      ]);
      assert.strictEqual((yield* records.get(org, "EXP-4"))?.title, "Inkspot Cloud");
      assert.deepStrictEqual(yield* fieldsOf(org, "EXP-4"), handMark(org));
      assert.deepStrictEqual(yield* fieldsOf(org, "EXP-5"), {
        ...handMark(org),
        repaidOn: "2026-11-10",
      });
    }),
  );
});
