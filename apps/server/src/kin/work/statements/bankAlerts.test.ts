// Loaded first: the chat and trigger modules import each other.
import "../../chat/KinChatService.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { KinChatError, KinConnectionId, KinOrgId, KinPersonId } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
import { newCompanyProfileJson } from "../companyProfile.ts";
import { parseFields } from "../lists.ts";
import * as KinRecords from "../KinRecords.ts";
import { MAIL_TOOL, type MailMessage } from "../../connections/MailProvider.ts";
import { fromConnections } from "../../pulse/outside.ts";
import * as KinShell from "../../shell/KinShell.ts";
import { alertsOnMail, takeAlertMail } from "./alertMail.ts";
import { candidateGate } from "./bankAlertCandidates.ts";
import * as BankAlertReader from "./BankAlertReader.ts";
import * as BankSenders from "./bankSenders.ts";
import migrateBankSenders from "../../persistence/migrations/K229_BankSenders.ts";
import {
  approveFixtureAlertSender,
  fixtureBankAlertReader,
  seedFixtureAlertMailbox,
} from "./bankAlerts.testkit.ts";
import {
  alertBalances,
  alertCheck,
  alertsBeside,
  rejectedAlerts,
  takeAlerts,
  threadSeen,
  UNREAD_ALERT_MARKER,
} from "./bankAlerts.ts";
import { ensureBankList, findBankList, knownRows } from "./bankList.ts";
import { creditMatches, openEntries } from "./invoiceCredits.ts";
import type { Statement, StatementRow } from "./statementTable.ts";
import { DAY_MS } from "../../durations.ts";

// Invented: Lakeview Studio's owner Rhea gets Harbor Bank alerts in two connected mailboxes.
const orgId = KinOrgId.make("lakeview");
const rhea = KinPersonId.make("lakeview-rhea");
const NOW = Date.parse("2026-11-18T12:00:00Z");
const AUTH = [
  "mx.google.com; dkim=pass header.i=@harborbank.example; spf=pass smtp.mailfrom=alerts@harborbank.example; dmarc=pass (p=REJECT) header.from=harborbank.example",
];
const alert = (
  messageId: string | null,
  text: string,
  date = "Wed, 18 Nov 2026 10:00:00 +0530",
) => ({
  messageId,
  fromAddress: "alerts@harborbank.example",
  subject: "You have done a UPI txn. Check details!",
  date,
  authResults: AUTH,
  text,
});
const debit = (reference: string, balance = "4,10,000.00") =>
  `Rs.1,250.00 has been debited from account **4821 to VPA lakeview.cafe@invented LAKEVIEW CAFE on 18-11-26. Your UPI transaction reference number is ${reference}. Avl bal: INR ${balance}`;

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
      yield* approveFixtureAlertSender(orgId, rhea, [
        "4821",
        "5530",
        "7001",
        "7002",
        "7061",
        "7063",
        "7064",
        "7065",
      ]);
      for (const id of ["work-mail", "home-mail", "other-mail"])
        yield* seedFixtureAlertMailbox(orgId, id);
      const take = (connectionId: string, threadId: string, messages: ReturnType<typeof alert>[]) =>
        takeAlerts(orgId, { connectionId, threadId, messages, now: NOW });

      assert.deepStrictEqual(
        yield* take("work-mail", "t1", [alert("<m1@harborbank.example>", debit("632211110001"))]),
        {
          recorded: 1,
          duplicate: 0,
          rejected: 0,
        },
      );
      const [made] = yield* entries;
      assert.match(made!.originKey, /^alert:b[0-9a-f]{8}:4821:debit:632211110001$/);
      assert.strictEqual(made!.amountMinor, 125_000);
      assert.deepStrictEqual(parseFields(made!.fieldsJson), {
        direction: "debit",
        reference: "632211110001",
        account: "Harbor Bank ••4821",
        balance: { minor: 41_000_000, currency: "INR" },
      });

      // A re-poll reads the same mail: nothing new, nothing counted.
      assert.deepStrictEqual(
        yield* take("work-mail", "t1", [alert("<m1@harborbank.example>", debit("632211110001"))]),
        {
          recorded: 0,
          duplicate: 0,
          rejected: 0,
        },
      );
      // The same alert in a second mailbox, and the bank sending it again: the same entry.
      assert.deepStrictEqual(
        yield* take("home-mail", "t9", [
          alert("<m1@harborbank.example>", debit("632211110001")),
          alert("<m1-again@harborbank.example>", debit("0632211110001")),
        ]),
        { recorded: 0, duplicate: 2, rejected: 0 },
      );
      assert.strictEqual((yield* entries).length, 1);
      const linked = yield* sql<{ recordId: string }>`SELECT DISTINCT record_id AS "recordId"
        FROM kin_bank_alerts WHERE org_id = ${orgId} AND record_id IS NOT NULL`;
      assert.deepStrictEqual(linked, [{ recordId: made!.recordId }]);

      // A failed payment's reversal quotes the debit's own reference: money back, its own entry.
      const reversal = (way: "debited from" | "credited to") =>
        alert(
          `<m-${way.slice(0, 3)}@harborbank.example>`,
          `Rs.700.00 has been ${way} account **5530 on 18-11-26. Your UPI transaction reference number is 632211110050.`,
        );
      assert.deepStrictEqual(
        yield* take("work-mail", "t5", [reversal("debited from"), reversal("credited to")]),
        { recorded: 2, duplicate: 0, rejected: 0 },
      );

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
      const before = (yield* entries).length;
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
            account: "Harbor Bank ••4821",
          },
        },
      );
      const tally = yield* takeAlerts(orgId, {
        connectionId: "work-mail",
        threadId: "t2",
        messages: [
          alert(
            "<m2@harborbank.example>",
            "Rs.999.00 has been debited from account **4821 to VPA lakeview.cafe@invented LAKEVIEW CAFE on 18-11-26. Your UPI transaction reference number is 632211110077.",
          ),
        ],
        now: NOW,
      });
      assert.deepStrictEqual(tally, { recorded: 0, duplicate: 1, rejected: 0 });
      assert.strictEqual((yield* entries).length, before + 1);
    }),
  );

  it.effect("what doesn't read is counted, and the newest Avl bal is the account's", () =>
    Effect.gen(function* () {
      const tally = yield* takeAlerts(orgId, {
        connectionId: "work-mail",
        threadId: "t3",
        messages: [
          alert("<m3@harborbank.example>", "Dear Customer, your statement is ready."),
          { ...alert("<m4@harborbank.example>", debit("632211110004")), authResults: [] },
          {
            ...alert("<m5@x>", debit("632211110005")),
            fromAddress: "alerts@harborbank-secure.example",
          },
          alert(
            "<m6@harborbank.example>",
            debit("632211110006", "3,90,000.00"),
            "Wed, 18 Nov 2026 11:30:00 +0530",
          ),
          alert(
            "<m7@harborbank.example>",
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
          bank: "Harbor Bank",
          account: "4821",
          currency: "INR",
          balanceMinor: 39_000_000,
          sentAt: Date.parse("2026-11-18T06:00:00Z"),
        },
      ]);
      // Beside the one statement account it is, when no older than that statement's balance.
      const account = (on: string, bank: string | null = "Harbor Bank") => ({
        kind: "account" as const,
        bank,
        digits: "4821",
        currency: "INR",
        on,
      });
      const mine = account("2026-10-31", "harbor BANK");
      const beside = yield* alertsBeside(orgId, [mine, { ...mine, digits: "9999" }]);
      assert.strictEqual(beside.beside.get(mine)?.balanceMinor, 39_000_000);
      assert.lengthOf(beside.alone, 0);
      const newer = yield* alertsBeside(orgId, [account("2026-11-30")]);
      assert.deepStrictEqual([newer.beside.size, newer.alone.length], [0, 0]);
      // A statement's balance is its day's close, so that day's alerts are older than it.
      const sameDay = yield* alertsBeside(orgId, [account("2026-11-18")]);
      assert.deepStrictEqual([sameDay.beside.size, sameDay.alone.length], [0, 0]);
      const twins = yield* alertsBeside(orgId, [mine, account("2026-10-31", null)]);
      assert.deepStrictEqual([twins.beside.size, twins.alone.length], [0, 1]);
      assert.lengthOf((yield* alertsBeside(orgId, [])).alone, 1);
    }),
  );

  it.effect(
    "a pass reads only approved senders' threads, and each only until Kin has its newest mail",
    () =>
      Effect.gen(function* () {
        const reads: Array<string> = [];
        const message = (text: string, threadId: string): MailMessage => ({
          threadId,
          from: "Harbor Bank alerts <alerts@harborbank.example>",
          fromAddress: "alerts@harborbank.example",
          to: [],
          replyTo: [],
          toLine: null,
          ccLine: null,
          deliveredTo: [],
          date: "Wed, 18 Nov 2026 10:00:00 +0530",
          subject: "You have done a UPI txn. Check details!",
          preview: "",
          unread: true,
          messageId: `<${threadId}@harborbank.example>`,
          references: null,
          authResults: AUTH,
          body: { text, attachments: [] },
        });
        const connections = {
          readThread: (_orgId: KinOrgId, _connectionId: string, threadId: string) =>
            Effect.sync(() => {
              reads.push(threadId);
              const [reference, account] =
                threadId === "t-bank" ? ["632211110008", "**7001"] : ["632211110018", "**7002"];
              return [message(debit(reference).replace("**4821", account), threadId)];
            }),
        };
        const activity = {
          _tag: "mail" as const,
          connectionId: KinConnectionId.make("work-mail"),
          since: 0,
          until: NOW,
          account: "rhea@lakeview.example",
          cursor: null,
          calendar: [],
          mail: [
            {
              threadId: "t-bank",
              receivedBy: null,
              subject: "You have done a UPI txn. Check details!",
              from: "Harbor Bank alerts <alerts@harborbank.example>",
              date: "Wed, 18 Nov 2026 10:00:00 +0530",
              unread: true,
            },
            {
              threadId: "t-bank-2",
              receivedBy: null,
              subject: "You have done a UPI txn. Check details!",
              from: "Harbor Bank alerts <alerts@harborbank.example>",
              date: "Wed, 18 Nov 2026 10:00:00 +0530",
              unread: true,
            },
            {
              threadId: "t-client",
              receivedBy: null,
              subject: "Invoice 004",
              from: "Raj <raj@client.example>",
              date: "Wed, 18 Nov 2026 10:00:00 +0530",
              unread: true,
            },
          ],
        };
        yield* TestClock.setTime(NOW);
        const sql = yield* SqlClient.SqlClient;
        const [before] = yield* sql`SELECT COUNT(*) AS count FROM kin_bank_alerts`;
        let calls = 0;
        const onMail = yield* alertsOnMail(connections).pipe(
          Effect.provideService(BankAlertReader.BankAlertReader, {
            read: Effect.fnUntraced(function* () {
              calls++;
              assert.isTrue(Option.isNone(yield* Effect.serviceOption(sql.transactionService)));
              return yield* new BankAlertReader.BankAlertReaderUnavailable();
            }),
          }),
        );
        // The mailbox moves on, each alert is kept as one no model read, and one failed call
        // stands for the pass.
        assert.isTrue(yield* onMail(orgId, activity));
        assert.strictEqual(calls, 1);
        assert.deepStrictEqual(reads, ["t-bank", "t-bank-2"]);
        assert.deepStrictEqual(
          yield* sql`SELECT thread_id AS thread, outcome, reference FROM kin_bank_alerts
          WHERE org_id = ${orgId} AND connection_id = ${activity.connectionId}
            AND thread_id LIKE 't-bank%' ORDER BY thread_id`,
          ["t-bank", "t-bank-2"].map((thread) => ({
            thread,
            outcome: "unparsed",
            reference: UNREAD_ALERT_MARKER,
          })),
        );
        assert.lengthOf(
          yield* sql`SELECT alert_id FROM kin_bank_alerts`,
          Number(before!.count) + 2,
        );
        assert.isTrue(
          yield* threadSeen(
            orgId,
            activity.connectionId,
            "t-bank",
            Date.parse(activity.mail[0]!.date),
          ),
        );
        // Still down on the next pass: nothing is marked read past it.
        reads.length = 0;
        for (const tool of [MAIL_TOOL.list, MAIL_TOOL.read]) {
          yield* sql`INSERT INTO kin_connection_tools (org_id, connection_id, tool_name,
          definition_json, pin_digest, mode, suggested_mode, open_world, first_seen_at)
          VALUES (${orgId}, ${activity.connectionId}, ${tool}, '{}', 'digest', 'read', 'read', 0,
            ${NOW})`;
        }
        // One read by an older parser, retried while no model is available, stays to be read.
        yield* sql`UPDATE kin_bank_alerts SET reference = 'parser:0002'
        WHERE org_id = ${orgId} AND thread_id = 't-bank-2'`;
        assert.isTrue(yield* onMail(orgId, activity));
        assert.strictEqual(calls, 2);
        assert.lengthOf(
          yield* sql`SELECT alert_id FROM kin_bank_alerts WHERE reference = ${UNREAD_ALERT_MARKER}`,
          2,
        );
        reads.length = 0;
        const first = yield* takeAlertMail(connections, orgId, activity);
        assert.deepStrictEqual(first, { threads: 2, recorded: 2, duplicate: 0, rejected: 0 });
        const again = yield* takeAlertMail(connections, orgId, activity);
        assert.deepStrictEqual(again, { threads: 0, recorded: 0, duplicate: 0, rejected: 0 });
        assert.deepStrictEqual(reads, ["t-bank", "t-bank-2"]);
      }),
  );

  it.effect("revisits recent unresolved alerts once without needing new mail", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const sql = yield* SqlClient.SqlClient;
      const connectionId = KinConnectionId.make("recovery-mail");
      yield* sql`INSERT INTO kin_connections (org_id, connection_id, preset, label, kind,
        url_host, auth, reach, state, created_at, updated_at)
        VALUES (${orgId}, ${connectionId}, 'google', 'Accounts', 'builtin', 'example.test',
          'oauth', 'closed', 'active', ${NOW}, ${NOW})`;
      for (const tool of [MAIL_TOOL.list, MAIL_TOOL.read]) {
        yield* sql`INSERT INTO kin_connection_tools (org_id, connection_id, tool_name,
          definition_json, pin_digest, mode, suggested_mode, open_world, first_seen_at)
          VALUES (${orgId}, ${connectionId}, ${tool}, '{}', 'digest', 'off', 'read', 0, ${NOW})`;
      }

      const legacy = (threadId: string, date?: string) =>
        alert(`<${threadId}@invented>`, "Unreadable.", date);
      for (const [mailbox, threadId, message] of [
        [connectionId, "fixed", legacy("fixed")],
        [connectionId, "unknown", legacy("unknown")],
        [connectionId, "old", legacy("old", "Mon, 02 Nov 2026 10:00:00 +0530")],
        ["other-mail", "elsewhere", legacy("elsewhere")],
      ] as const) {
        yield* takeAlerts(orgId, {
          connectionId: mailbox,
          threadId,
          messages: [message],
          now: Date.parse(message.date),
        });
      }
      yield* sql`UPDATE kin_bank_alerts SET reference = 'parser:0002' WHERE org_id = ${orgId}
        AND outcome = 'unparsed' AND connection_id IN (${connectionId}, 'other-mail')`;

      const def = yield* ensureBankList(orgId, NOW);
      const hand = Effect.fn("test.handBankEntry")(function* (
        id: string,
        reference: string | null,
        account: string,
        direction: "debit" | "credit",
        dateAt = Date.parse("2026-11-18T18:29:59Z"),
      ) {
        const fields = JSON.stringify({
          direction,
          account,
          ...(reference === null ? {} : { reference }),
        });
        yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, state,
          owner_kind, owner_id, amount_minor, currency, date_at, date_all_day, fields_json,
          created_by_kind, created_by_id, origin_key, created_at, updated_at)
          VALUES (${orgId}, ${id}, ${def.id}, ${id}, 'Juniper Cold Chain', 'open',
          'person', ${rhea}, 125000, 'INR', ${dateAt}, 1,
          ${fields}, 'agent', 'finance', ${`manual:finance:${id}`}, ${NOW}, ${NOW})`;
        return id;
      });
      yield* hand("a-wrong-reference", "OTHER99876", "Harbor Bank ••7061", "debit");
      yield* hand("b-wrong-account", "632211119876", "Harbor Bank ••7062", "debit");
      yield* hand("c-wrong-direction", "632211119876", "Harbor Bank ••7061", "credit");
      const manual = yield* hand("d-matching", "632211119876", "Harbor Bank ••7061", "debit");

      yield* takeAlerts(orgId, {
        connectionId,
        threadId: "current",
        messages: [legacy("current")],
        now: NOW,
      });

      const mail = (threadId: string, stub: ReturnType<typeof legacy>): MailMessage => ({
        ...stub,
        threadId,
        from: "Harbor Bank <alerts@harborbank.example>",
        to: [],
        replyTo: [],
        toLine: null,
        ccLine: null,
        deliveredTo: [],
        unread: false,
        preview: "",
        references: null,
        body: { text: stub.text, attachments: [] },
      });
      const reads: string[] = [];
      const connections = {
        readThread: (_orgId: KinOrgId, _connectionId: string, threadId: string) =>
          Effect.sync(() => {
            reads.push(threadId);
            const message = legacy(threadId);
            return threadId === "fixed"
              ? [
                  mail(threadId, {
                    ...message,
                    text: debit("632211119876").replace("**4821", "**7061"),
                  }),
                  mail(threadId, { ...legacy("not-listed"), text: debit("632211119877") }),
                ]
              : [mail(threadId, message)];
          }),
      };
      const pass = takeAlertMail(connections, orgId, {
        _tag: "mail",
        connectionId,
        since: NOW - 1,
        until: NOW,
        account: "accounts@lakeview.example",
        cursor: null,
        calendar: [],
        mail: [],
      });

      yield* sql`UPDATE kin_connection_tools SET mode = 'read' WHERE org_id = ${orgId}
        AND connection_id = ${connectionId} AND tool_name = ${MAIL_TOOL.read}`;
      assert.deepStrictEqual(yield* pass, { threads: 0, recorded: 0, duplicate: 0, rejected: 0 });
      assert.deepStrictEqual(reads, []);
      yield* sql`UPDATE kin_connection_tools SET mode = 'read' WHERE org_id = ${orgId}
        AND connection_id = ${connectionId} AND tool_name = ${MAIL_TOOL.list}`;
      assert.deepStrictEqual(yield* pass, { threads: 2, recorded: 0, duplicate: 1, rejected: 1 });
      assert.deepStrictEqual(reads, ["fixed", "unknown"]);
      assert.deepStrictEqual(yield* pass, { threads: 0, recorded: 0, duplicate: 0, rejected: 0 });
      assert.deepStrictEqual(reads, ["fixed", "unknown"]);
      const rows =
        yield* sql`SELECT thread_id AS thread, outcome, record_id AS "recordId" FROM kin_bank_alerts
        WHERE org_id = ${orgId} AND connection_id = ${connectionId} ORDER BY thread_id`;
      assert.deepStrictEqual(rows, [
        { thread: "current", outcome: "unparsed", recordId: null },
        { thread: "fixed", outcome: "duplicate", recordId: manual },
        { thread: "old", outcome: "unparsed", recordId: null },
        { thread: "unknown", outcome: "unparsed", recordId: null },
      ]);

      const noReference = yield* hand("e-no-reference", null, "Harbor Bank ••7063", "debit");
      yield* hand("f-ambiguous", null, "Harbor Bank ••7064", "debit");
      yield* hand("g-ambiguous", null, "Harbor Bank ••7064", "debit");
      // Entered by hand the next morning, the reference typed in small letters with spaces.
      const nextDay = yield* hand(
        "h-next-day",
        "ab 6322 1111 9882",
        "Harbor Bank ••7065",
        "debit",
        Date.parse("2026-11-19T04:30:00Z"),
      );
      for (const [i, [digits, reference, expected, linked]] of (
        [
          ["7063", "632211119879", { recorded: 0, duplicate: 1 }, noReference],
          ["7063", "632211119879", { recorded: 0, duplicate: 1 }, noReference],
          ["7063", "632211119880", { recorded: 1, duplicate: 0 }, null],
          ["7064", "632211119881", { recorded: 1, duplicate: 0 }, null],
          ["7065", "AB632211119882", { recorded: 0, duplicate: 1 }, nextDay],
        ] as const
      ).entries()) {
        const threadId = `reference-${i}`;
        const taken = yield* takeAlerts(orgId, {
          connectionId,
          threadId,
          now: NOW,
          messages: [alert(null, debit(reference).replace("**4821", `**${digits}`))],
        });
        assert.deepInclude(taken, expected);
        if (linked !== null) {
          const [picked] = yield* sql`SELECT record_id AS "recordId" FROM kin_bank_alerts
            WHERE org_id = ${orgId} AND thread_id = ${threadId}`;
          assert.strictEqual(picked?.recordId, linked);
        }
      }
      const [unchanged] = yield* sql<{ fields: string; kind: string; origin: string | null }>`
        SELECT fields_json AS fields, created_by_kind AS kind, origin_key AS origin
        FROM kin_records WHERE org_id = ${orgId} AND record_id = ${noReference}`;
      assert.deepInclude(unchanged, { kind: "agent", origin: `manual:finance:${noReference}` });
      assert.notProperty(parseFields(unchanged!.fields), "reference");
    }),
  );

  it.effect("a statement's row is an alert's entry by reference, else by day and amount", () =>
    Effect.gen(function* () {
      const def = yield* findBankList(orgId);
      const row = (
        index: number,
        date: string,
        amountMinor: number,
        direction: "debit" | "credit",
        reference: string | null,
      ): StatementRow => ({
        index,
        date,
        description: "UPI-SOMEONE-INVENTED",
        reference,
        amountMinor,
        direction,
        balanceMinor: null,
        foreign: null,
      });
      const statement = (account: string, rows: ReadonlyArray<StatementRow>): Statement => ({
        kind: "account",
        bank: "Harbor Bank",
        account,
        accountId: `id-${account}`,
        currency: "INR",
        from: "2026-11-17",
        to: "2026-11-18",
        openingMinor: null,
        closingMinor: null,
        rows,
        check: { status: "adds_up", line: "" },
      });
      // ••4821 has three ₹1,250 debits on 18 Nov from alerts: ...0001, ...0006 and ...0007.
      const review = statement("4821", [
        row(0, "2026-11-18", 125_000, "debit", "0000632211110001"),
        row(1, "2026-11-18", 125_000, "debit", null),
        row(2, "2026-11-17", 500_000, "credit", "N3212345"),
      ]);
      const found = yield* knownRows(orgId, def, review, "st-1");
      assert.deepStrictEqual([...found.known.keys()], [0]);
      // Two alerts it could be: neither, rather than a guess.
      assert.strictEqual(found.possible.size, 0);
      const check = yield* alertCheck(orgId, def?.id, review, found.known);
      assert.deepStrictEqual(
        {
          merged: check?.merged,
          notOnStatement: check?.notOnStatement.map((one) => [one.date, one.amountMinor]),
          notInAlerts: check?.notInAlerts,
          alertsSince: check?.alertsSince,
        },
        {
          merged: 1,
          notOnStatement: [
            ["2026-11-18", 125_000],
            ["2026-11-18", 125_000],
          ],
          // The 17 Nov credit came before any alert of this account.
          notInAlerts: 1,
          alertsSince: "2026-11-18",
        },
      );

      // ••7001 has one ₹1,250 debit on 18 Nov from an alert.
      const unique = yield* knownRows(
        orgId,
        def,
        statement("7001", [row(0, "2026-11-18", 125_000, "debit", null)]),
        "st-2",
      );
      assert.deepStrictEqual([unique.known.size, unique.possible.size], [1, 0]);
      const conflicting = yield* knownRows(
        orgId,
        def,
        statement("7001", [row(0, "2026-11-18", 125_000, "debit", "OTHERREF99")]),
        "st-3",
      );
      assert.deepStrictEqual([conflicting.known.size, conflicting.possible.size], [0, 1]);
      // Another bank's statement isn't checked against Harbor Bank alerts.
      assert.isUndefined(
        yield* alertCheck(orgId, def?.id, { ...review, bank: "Invented Bank" }, found.known),
      );
    }),
  );

  it.effect("a credit alert seen twice is one credit that looks like its invoice's payment", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // Ambermill (invented) bills Harbourline Logistics; its own org, apart from Lakeview's.
      const org = KinOrgId.make("ambermill-alerts");
      yield* sql`INSERT INTO kin_orgs VALUES (${org}, 'Ambermill Studio', '2026-11-01')`;
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
        VALUES ('ambermill-rhea', ${org}, 'rhea', 'Rhea', '2026-11-01', 'owner')`;
      yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in, created_at)
        VALUES (${org}, 'clients', 'clients', 'C', 1, 0), (${org}, 'invoices', 'invoices', 'INV', 1, 0)`;
      yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, state,
          owner_kind, owner_id, party_id, date_at, amount_minor, currency, confirmed,
          created_by_kind, created_by_id, origin_key, created_at, updated_at, fields_json)
        VALUES (${org}, 'r-amb-c1', 'clients', 'C-1', 'Ambermill Design LLP', 'open', 'person',
            'ambermill-rhea', NULL, NULL, NULL, NULL, 1, 'person', 'ambermill-rhea', 'c-1', 0, 0,
            '{}'),
          (${org}, 'r-amb-inv4', 'invoices', 'INV-4', 'October retainer', 'waiting', 'person',
            'ambermill-rhea', 'r-amb-c1', ${Date.parse("2026-11-02T12:00:00Z")}, 9_500_000, 'INR', 1,
            'person', 'ambermill-rhea', 'inv-4', 0, 0, '{"number":"26-27/004"}')`;
      const credit = alert(
        "<neft-1@harborbank.example>",
        "Dear Customer, INR 95,000.00 was credited to your A/c No. XX4821 on 17-11-2026 for NEFT Cr-INVT0000001-AMBERMILL DESIGN LLP-Invoice 26-27/004. UTR No: INVTN52026111700042. Available balance: INR 5,05,250.50.",
      );
      yield* approveFixtureAlertSender(org, KinPersonId.make("ambermill-rhea"));
      yield* seedFixtureAlertMailbox(org, "work-mail");
      yield* seedFixtureAlertMailbox(org, "home-mail");
      const take = (connectionId: string, threadId: string) =>
        takeAlerts(org, { connectionId, threadId, messages: [credit], now: NOW });
      assert.deepInclude(yield* take("work-mail", "c1"), { recorded: 1 });
      assert.deepInclude(yield* take("home-mail", "c9"), { recorded: 0, duplicate: 1 });
      const groups = yield* creditMatches(org);
      assert.deepStrictEqual(
        groups.map((group) => ({
          credit: group.credit.key,
          first: group.first.map((pair) => [pair.invoice.key, pair.reason]),
          recorded: group.recorded,
        })),
        [{ credit: "BNK-1", first: [["INV-4", "cites 26-27/004"]], recorded: undefined }],
      );
    }),
  );
});

const senderSetup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Tidewater Freight', '2026-11-01')`;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
    VALUES (${rhea}, ${orgId}, 'rhea', 'Rhea', '2026-11-01', 'owner')`;
  yield* sql`INSERT INTO kin_connections (org_id, connection_id, preset, label, kind, url_host,
      auth, reach, state, created_at, updated_at)
    VALUES (${orgId}, 'approved-inbox', 'google', 'Accounts', 'builtin', 'example.test',
      'oauth', 'closed', 'active', ${NOW}, ${NOW})`;
  return sql;
});
const harbor = "notices@harborbank.example";
const withSender = (fromAddress: string, text: string, id = "gate") => ({
  ...alert(`<${id}@invented.example>`, text),
  fromAddress,
  authResults: [`mx.invented.example; dmarc=pass header.from=${fromAddress.split("@")[1]}`],
});
const takeOne = (message: ReturnType<typeof alert>) =>
  takeAlerts(orgId, {
    connectionId: "approved-inbox",
    threadId: "sender-gate",
    messages: [message],
    now: NOW,
  });

it.effect.each([
  ["an approved address", harbor, "4821", "recorded", 1],
  ["an unknown address", "news@stranger.example", "4821", "sender", 0],
  ["an authenticated look-alike", "notices@harborbank-secure.example", "4821", "sender", 0],
  ["a different address on the approved domain", "else@harborbank.example", "4821", "sender", 0],
  ["a different account ending", harbor, "9999", "other_account", 0],
] as const)("gates %s before the model", ([, address, ending, expected, calls]) =>
  Effect.gen(function* () {
    const sql = yield* senderSetup;
    yield* BankSenders.add(orgId, rhea, {
      address: harbor,
      bankName: "Harbor Bank",
      accounts: ["4821"],
    });
    let modelCalls = 0;
    yield* takeOne(
      withSender(address, debit("632211112200").replace("**4821", `**${ending}`)),
    ).pipe(
      Effect.provideService(BankAlertReader.BankAlertReader, {
        read: (input) =>
          Effect.sync(() => {
            modelCalls++;
          }).pipe(Effect.andThen(fixtureBankAlertReader.read(input))),
      }),
    );
    assert.lengthOf(yield* entries, calls);
    assert.strictEqual(modelCalls, calls);
    assert.deepStrictEqual(yield* sql`SELECT outcome, sender_address FROM kin_bank_alerts`, [
      { outcome: expected, sender_address: address },
    ]);
  }).pipe(Effect.provide(layer)),
);

it.effect("a removed sender keeps old entries but cannot add or offer more money", () =>
  Effect.gen(function* () {
    const sql = yield* senderSetup;
    yield* BankSenders.add(orgId, rhea, {
      address: harbor,
      bankName: "Harbor Bank",
      accounts: ["4821"],
    });
    assert.strictEqual((yield* takeOne(withSender(harbor, debit("632211112201")))).recorded, 1);
    const def = (yield* findBankList(orgId))!;
    assert.lengthOf(yield* openEntries(orgId, def, "debit", undefined), 1);
    yield* BankSenders.remove(orgId, rhea, harbor);
    yield* takeOne(withSender(harbor, debit("632211112202"), "removed")).pipe(
      Effect.provideService(BankAlertReader.BankAlertReader, {
        read: () => Effect.die("The removed sender reached the reader"),
      }),
    );
    assert.lengthOf(yield* entries, 1);
    assert.lengthOf(yield* openEntries(orgId, def, "debit", undefined), 0);
    assert.deepStrictEqual(yield* sql`SELECT outcome FROM kin_bank_alerts ORDER BY outcome`, [
      { outcome: "recorded" },
      { outcome: "sender" },
    ]);
  }).pipe(Effect.provide(layer)),
);

it.effect("carried addresses retain the original origin key on a replay", () =>
  Effect.gen(function* () {
    const sql = yield* senderSetup;
    const def = yield* ensureBankList(orgId, NOW);
    const records = yield* KinRecords.KinRecords;
    const originKey = "alert:hdfc:4821:debit:632211112203";
    const { row } = yield* records.create(
      orgId,
      { actor: { _tag: "system" }, via: "import" },
      {
        list: def.id,
        originKey,
        title: "Historic alert",
        owner: { _tag: "person", personId: rhea },
        state: "open",
        amount: { minor: 125_000, currency: "INR" },
        dateAt: Date.parse("2026-11-18T12:00:00Z"),
        fields: { account: "HDFC Bank ••4821", direction: "debit", reference: "632211112203" },
      },
    );
    yield* sql`INSERT INTO kin_bank_alerts (org_id, alert_id, connection_id, thread_id, outcome,
      bank, account, record_id, seen_at)
      VALUES (${orgId}, 'historic', 'approved-inbox', 'before-upgrade', 'recorded',
        'HDFC Bank', '4821', ${row.recordId}, ${NOW})`;
    yield* sql`DROP INDEX kin_bank_alerts_sender`;
    yield* sql`ALTER TABLE kin_bank_alerts DROP COLUMN sender_address`;
    yield* migrateBankSenders;
    const [address] = (yield* BankSenders.sendersOf(orgId)).keys();
    assert.isDefined(address);
    const result = yield* takeOne(withSender(address!, debit("632211112203")));
    assert.deepStrictEqual(result, { recorded: 0, duplicate: 1, rejected: 0 });
    assert.deepStrictEqual(
      (yield* entries).map((entry) => entry.originKey),
      [originKey],
    );
    const [duplicate] = yield* sql`SELECT sender_address, record_id FROM kin_bank_alerts
      WHERE outcome = 'duplicate'`;
    assert.deepStrictEqual(duplicate, { sender_address: address, record_id: row.recordId });
  }).pipe(Effect.provide(layer)),
);

it.effect("after the upgrade an unread alert recorded by hand is tied to that entry once", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const sql = yield* senderSetup;
    for (const tool of [MAIL_TOOL.list, MAIL_TOOL.read]) {
      yield* sql`INSERT INTO kin_connection_tools (org_id, connection_id, tool_name,
        definition_json, pin_digest, mode, suggested_mode, open_world, first_seen_at)
        VALUES (${orgId}, 'approved-inbox', ${tool}, '{}', 'digest', 'read', 'read', 0, ${NOW})`;
    }
    const hdfc = "alerts@hdfcbank.net";
    const unread = withSender(hdfc, debit("632211112211"), "unread-before-upgrade");
    // The live shape before K229: one recorded alert, and one the old parser couldn't read.
    yield* BankSenders.add(orgId, rhea, {
      address: hdfc,
      bankName: "HDFC Bank",
      accounts: ["4821"],
    });
    yield* takeAlerts(orgId, {
      connectionId: "approved-inbox",
      threadId: "unread",
      messages: [unread],
      now: NOW,
    }).pipe(
      Effect.provideService(BankAlertReader.BankAlertReader, {
        read: () => Effect.succeed("not_one_transaction" as const),
      }),
    );
    yield* sql`DELETE FROM kin_bank_senders`;
    yield* sql`UPDATE kin_bank_alerts SET reference = 'parser:0002', sender_address = NULL`;
    const def = yield* ensureBankList(orgId, NOW);
    const records = yield* KinRecords.KinRecords;
    const { row: recorded } = yield* records.create(
      orgId,
      { actor: { _tag: "system" }, via: "import" },
      {
        list: def.id,
        originKey: "alert:hdfc:4821:debit:632211112210",
        title: "Historic alert",
        owner: { _tag: "person", personId: rhea },
        state: "open",
        amount: { minor: 125_000, currency: "INR" },
        dateAt: Date.parse("2026-11-17T12:00:00Z"),
        fields: { account: "HDFC Bank ••4821", direction: "debit", reference: "632211112210" },
      },
    );
    yield* sql`INSERT INTO kin_bank_alerts (org_id, alert_id, connection_id, thread_id, sent_at,
      outcome, bank, account, reference, record_id, currency, balance_minor, seen_at)
      VALUES (${orgId}, 'historic', 'approved-inbox', 'recorded', ${NOW - DAY_MS}, 'recorded',
        'HDFC Bank', '4821', '632211112210', ${recorded.recordId}, 'INR', 41000000, ${NOW})`;
    // Since then an agent recorded the unread one by hand.
    yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, state,
      owner_kind, owner_id, amount_minor, currency, date_at, date_all_day, fields_json,
      created_by_kind, created_by_id, origin_key, created_at, updated_at)
      VALUES (${orgId}, 'by-hand', ${def.id}, 'by-hand', 'Lakeview Cafe', 'open', 'person',
        ${rhea}, 125000, 'INR', ${Date.parse("2026-11-18T12:00:00Z")}, 1,
        '{"direction":"debit","account":"HDFC Bank ••4821","reference":"632211112211"}', 'agent',
        'finance', 'manual:finance:by-hand', ${NOW}, ${NOW})`;
    yield* sql`DROP INDEX kin_bank_alerts_sender`;
    yield* sql`ALTER TABLE kin_bank_alerts DROP COLUMN sender_address`;
    yield* migrateBankSenders;

    const unreadCount = sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_bank_alerts
      WHERE org_id = ${orgId} AND outcome = 'unparsed'`;
    assert.deepStrictEqual(yield* unreadCount, [{ n: 1 }]);
    const reads: Array<string> = [];
    let modelCalls = 0;
    const pass = takeAlertMail(
      {
        readThread: (_orgId, _connectionId, threadId) =>
          Effect.sync(() => {
            reads.push(threadId);
            return [
              {
                ...unread,
                threadId,
                from: `HDFC Bank <${hdfc}>`,
                to: [],
                replyTo: [],
                toLine: null,
                ccLine: null,
                deliveredTo: [],
                unread: false,
                preview: "",
                references: null,
                body: { text: unread.text, attachments: [] },
              },
            ];
          }),
      },
      orgId,
      {
        _tag: "mail",
        connectionId: KinConnectionId.make("approved-inbox"),
        since: NOW - 1,
        until: NOW,
        account: "accounts@lakeview.example",
        cursor: null,
        calendar: [],
        mail: [],
      },
    ).pipe(
      Effect.provideService(BankAlertReader.BankAlertReader, {
        read: (input) =>
          Effect.sync(() => {
            modelCalls++;
          }).pipe(Effect.andThen(fixtureBankAlertReader.read(input))),
      }),
    );
    assert.deepInclude(yield* pass, { recorded: 0, duplicate: 1 });
    assert.deepInclude(yield* pass, { threads: 0 });
    assert.deepStrictEqual(reads, ["unread"]);
    assert.strictEqual(modelCalls, 1);
    assert.deepStrictEqual(yield* unreadCount, [{ n: 0 }]);
    assert.deepStrictEqual(
      yield* sql`SELECT thread_id, outcome, record_id, sender_address FROM kin_bank_alerts
        ORDER BY thread_id`,
      [
        {
          thread_id: "recorded",
          outcome: "recorded",
          record_id: recorded.recordId,
          sender_address: null,
        },
        { thread_id: "unread", outcome: "duplicate", record_id: "by-hand", sender_address: hdfc },
      ],
    );
    assert.deepStrictEqual(
      (yield* entries).map((entry) => entry.recordId).toSorted(),
      ["by-hand", recorded.recordId].toSorted(),
    );
  }).pipe(Effect.provide(layer)),
);

const candidateSetup = Effect.fn("Test.candidateSetup")(function* (
  source: "company_details" | "statement" | "no_ending",
) {
  yield* TestClock.setTime(NOW);
  const sql = yield* senderSetup;
  if (source === "statement") {
    yield* sql`INSERT INTO kin_bank_statements
      (org_id, statement_id, attachment_id, file_name, chat_id, agent_id, wakeup_id, status,
        account, review_json, created_at, applied_at)
      VALUES (${orgId}, 'statement', 'document', 'statement.csv', 'chat', 'finance', 'wake', 'read',
        '4821', '{"statement":{"kind":"account","bank":"Harbor Bank","account":"4821"}}', 1, 2)`;
  } else {
    yield* sql`INSERT INTO kin_company_profile (org_id, profile_json, rev, updated_at,
        updated_by_kind, updated_by_id)
      VALUES (${orgId}, json_set(json_remove(${yield* newCompanyProfileJson}, '$.countryPending'),
        '$.bank.bankName', 'Harbor Bank', '$.bank.accountNumber',
        ${source === "no_ending" ? null : "00004821"}),
        1, 0, 'person', ${rhea})`;
  }
  return sql;
});

const material = (
  threadId: string,
  {
    fromAddress = harbor,
    body = debit("632211112204"),
    auth = `dmarc=pass header.from=${fromAddress.split("@")[1]}`,
    date = "Wed, 18 Nov 2026 10:00:00 +0530",
  } = {},
): MailMessage => ({
  threadId,
  from: `A name to keep out of Kin <${fromAddress}>`,
  fromAddress,
  to: [],
  replyTo: [],
  toLine: null,
  ccLine: null,
  deliveredTo: [],
  date,
  subject: "A subject to keep out of Kin",
  preview: "",
  unread: true,
  messageId: `<${threadId}@invented.example>`,
  references: null,
  authResults: [`mx.invented.example; ${auth}`],
  body: { text: body, attachments: [] },
});

const candidatePass = (...mail: ReadonlyArray<MailMessage>) => {
  const reads: Array<string> = [];
  const connections = {
    readThread: (_orgId: KinOrgId, _connectionId: string, threadId: string) =>
      Effect.sync(() => {
        reads.push(threadId);
        return mail.filter((message) => message.threadId === threadId);
      }),
  };
  const activity = {
    _tag: "mail" as const,
    connectionId: KinConnectionId.make("approved-inbox"),
    since: 0,
    until: NOW,
    account: "accounts@tidewater.example",
    cursor: null,
    calendar: [],
    mail: mail.map(({ threadId, from, date, subject, unread }) => ({
      threadId,
      from,
      date,
      subject,
      unread,
      receivedBy: null,
    })),
  };
  const pass = takeAlertMail(connections, orgId, activity).pipe(
    Effect.provideService(BankAlertReader.BankAlertReader, {
      read: () => Effect.die("Unapproved mail reached the model"),
    }),
  );
  return { activity, connections, pass, reads };
};

it.effect.each([
  ["company_details", "held", material("company")],
  ["statement", "held", material("statement-source", { fromAddress: "notices@harborbank.co.uk" })],
  ["no_ending", "held", material("masked")],
  [
    "company_details",
    "unverified",
    material("no-dmarc", { auth: "dmarc=fail header.from=harborbank.example" }),
  ],
  [
    "company_details",
    "unverified",
    material("forged-look-alike", {
      fromAddress: "alerts@harborbank-notices.example",
      auth: "spf=pass (dmarc=pass header.from=harborbank-notices.example); dmarc=fail header.from=harborbank-notices.example",
    }),
  ],
  [
    "company_details",
    "sender",
    material("no-digits", { body: "Wrong account **5530, reference 99848215." }),
  ],
  ["no_ending", "sender", material("unmasked", { body: "The year is 2026. See 4821." })],
] as const)("candidate discovery: %s gives %s for $2.threadId", ([source, outcome, mail]) =>
  Effect.gen(function* () {
    const sql = yield* candidateSetup(source);
    const { pass, reads } = candidatePass(mail);
    yield* pass;
    assert.deepStrictEqual(reads, [mail.threadId]);
    const rows = yield* BankSenders.list(orgId);
    if (outcome === "held") {
      assert.lengthOf(rows, 1);
      assert.include(rows[0], {
        state: "candidate",
        matchedFrom: source === "no_ending" ? "company_details" : source,
        address: mail.fromAddress!,
        seenCount: 1,
        bankName: "Harbor Bank",
      });
      assert.deepStrictEqual(rows[0]!.seenAccounts, ["4821"]);
    } else assert.deepStrictEqual(rows, []);
    assert.deepStrictEqual(
      yield* sql`SELECT outcome, sender_address, account, balance_minor, record_id
      FROM kin_bank_alerts`,
      [
        {
          outcome,
          sender_address: mail.fromAddress,
          account: outcome === "held" ? "4821" : null,
          balance_minor: null,
          record_id: null,
        },
      ],
    );
    assert.deepStrictEqual(yield* entries, []);
  }).pipe(Effect.provide(layer)),
);

it.effect.each([
  ["Harbor Bank", "alerts@harborbank.example", true],
  // A look-alike can raise one: the owner's tap decides, and the card shows the address.
  ["Harbor Bank", "alerts@harbor.mail-relay.example", true],
  ["Harbor Bank", "alerts@xn--harborbnk-7fg.example", true],
  ["Harbor Bank", "harborbank@gmail.com", false],
  ["Harbor Bank", "alerts@bank.example", false],
  ["Harbor Bank", "alerts@example.harbor", false],
  ["Société Générale", "alerts@societegenerale.example", true],
] as const)("the candidate name rule: %s and %s gives %s", ([bankName, address, raised]) =>
  Effect.gen(function* () {
    const sql = yield* senderSetup;
    yield* sql`INSERT INTO kin_company_profile (org_id, profile_json, rev, updated_at,
        updated_by_kind, updated_by_id)
      VALUES (${orgId}, json_set(${yield* newCompanyProfileJson}, '$.bank.bankName', ${bankName}),
        1, 0, 'person', ${rhea})`;
    assert.strictEqual((yield* candidateGate(orgId))(address) !== undefined, raised);
  }).pipe(Effect.provide(layer)),
);

it.effect("a waiting address's mail stays in check-in lines unless Money is off", () =>
  Effect.gen(function* () {
    const sql = yield* candidateSetup("company_details");
    yield* BankSenders.noteCandidate(orgId, {
      address: "notices@harborbank-alerts.example",
      bankName: "Harbor Bank",
      accounts: ["4821"],
      seenAt: NOW,
      matchedFrom: "company_details",
    });
    yield* BankSenders.add(orgId, rhea, {
      address: harbor,
      bankName: "Harbor Bank",
      accounts: ["4821"],
    });
    const { activity } = candidatePass(
      material("waiting", { fromAddress: "notices@harborbank-alerts.example" }),
      material("approved"),
      material("stranger", { fromAddress: "notices@stranger.example" }),
    );
    const source = fromConnections(
      KinConnections.of({ ...(yield* KinConnections), activity: () => Effect.succeed(activity) }),
      sql,
    );
    const threads = Effect.map(source.read(orgId), ({ lines }) => lines.map((line) => line.thread));
    assert.deepStrictEqual(yield* threads, ["waiting", "approved", "stranger"]);
    yield* sql`INSERT INTO kin_company_shell (org_id, shell_json, rev, set_by, set_at)
      VALUES (${orgId}, '[{"id":"money","on":false}]', 1, ${rhea}, ${NOW})`;
    yield* KinShell.invalidate(orgId);
    assert.deepStrictEqual(yield* threads, ["stranger"]);
  }).pipe(Effect.provide(layer)),
);

it.effect("reads at most three matching candidate threads per mailbox and pass", () =>
  Effect.gen(function* () {
    yield* candidateSetup("company_details");
    const { pass, reads } = candidatePass(
      material("noise", { fromAddress: "notices@stranger.example" }),
      ...Array.from({ length: 5 }, (_, index) => material(`held-${index}`)),
    );
    yield* pass;
    assert.deepStrictEqual(reads, ["held-0", "held-1", "held-2"]);
    assert.strictEqual((yield* BankSenders.list(orgId))[0]?.seenCount, 3);
    yield* pass;
    assert.deepStrictEqual(reads, ["held-0", "held-1", "held-2", "held-3", "held-4"]);
    assert.strictEqual((yield* BankSenders.list(orgId))[0]?.seenCount, 5);
  }).pipe(Effect.provide(layer)),
);

it.effect("does not read or raise an address again after the owner declines it", () =>
  Effect.gen(function* () {
    yield* candidateSetup("company_details");
    const first = candidatePass(material("first"));
    yield* first.pass;
    assert.strictEqual((yield* BankSenders.list(orgId))[0]?.state, "candidate");
    yield* BankSenders.decline(orgId, rhea, harbor);
    const next = candidatePass(material("next"));
    yield* next.pass;
    assert.deepStrictEqual(next.reads, []);
    assert.include((yield* BankSenders.list(orgId))[0], { state: "declined", seenCount: 1 });
  }).pipe(Effect.provide(layer)),
);

it.effect("approval re-reads a held alert once, after the outside transaction commits", () =>
  Effect.gen(function* () {
    const sql = yield* candidateSetup("company_details");
    for (const tool of [MAIL_TOOL.list, MAIL_TOOL.read]) {
      yield* sql`INSERT INTO kin_connection_tools (org_id, connection_id, tool_name,
        definition_json, pin_digest, mode, suggested_mode, open_world, first_seen_at)
        VALUES (${orgId}, 'approved-inbox', ${tool}, '{}', 'digest', 'read', 'read', 0, ${NOW})`;
    }
    const mail = material("replay");
    const { activity, connections, pass, reads } = candidatePass(mail);
    yield* pass;
    assert.deepStrictEqual(yield* sql`SELECT outcome FROM kin_bank_alerts`, [{ outcome: "held" }]);
    assert.deepStrictEqual(yield* entries, []);

    const committed = yield* Deferred.make<void>();
    const records = yield* KinRecords.KinRecords;
    let modelCalls = 0;
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* BankSenders.approve(orgId, rhea, harbor, ["4821"]);
          assert.deepStrictEqual(reads, ["replay"]);
          assert.deepStrictEqual(yield* entries, []);
        }),
      )
      .pipe(
        Effect.provideService(
          KinConnections,
          KinConnections.of({
            ...(yield* KinConnections),
            ...connections,
          }),
        ),
        Effect.provideService(KinRecords.KinRecords, {
          ...records,
          create: (...args) =>
            records
              .create(...args)
              .pipe(
                Effect.tap(() =>
                  sql.afterCommit(Deferred.succeed(committed, undefined).pipe(Effect.asVoid)),
                ),
              ),
        }),
        Effect.provideService(BankAlertReader.BankAlertReader, {
          read: (input) =>
            Effect.gen(function* () {
              modelCalls++;
              assert.isTrue(Option.isNone(yield* Effect.serviceOption(sql.transactionService)));
              return yield* fixtureBankAlertReader.read(input);
            }),
        }),
      );
    yield* Deferred.await(committed);
    assert.deepStrictEqual(yield* takeAlertMail(connections, orgId, activity), {
      threads: 0,
      recorded: 0,
      duplicate: 0,
      rejected: 0,
    });
    assert.strictEqual(modelCalls, 1);
    assert.deepStrictEqual(reads, ["replay", "replay"]);
    assert.lengthOf(yield* entries, 1);
    assert.deepStrictEqual(yield* sql`SELECT outcome FROM kin_bank_alerts`, [
      { outcome: "recorded" },
    ]);
  }).pipe(Effect.provide(layer)),
);

it.effect("a model selection cannot switch an alert to an unapproved ending", () =>
  Effect.gen(function* () {
    const sql = yield* senderSetup;
    yield* BankSenders.add(orgId, rhea, {
      address: harbor,
      bankName: "Harbor Bank",
      accounts: ["4821"],
    });
    const message = withSender(
      harbor,
      debit("632211112205").replace("**4821", "**9999") + " Also available on account **4821.",
    );
    let calls = 0;
    yield* takeOne(message).pipe(
      Effect.provideService(BankAlertReader.BankAlertReader, {
        read: (input) =>
          Effect.sync(() => {
            calls++;
          }).pipe(Effect.andThen(fixtureBankAlertReader.read(input))),
      }),
    );
    assert.strictEqual(calls, 1);
    assert.deepStrictEqual(yield* entries, []);
    assert.deepStrictEqual(
      yield* sql`SELECT outcome, account, balance_minor FROM kin_bank_alerts`,
      [{ outcome: "other_account", account: null, balance_minor: null }],
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("revocation during reading wins over the in-flight model result", () =>
  Effect.gen(function* () {
    const sql = yield* senderSetup;
    yield* BankSenders.add(orgId, rhea, {
      address: harbor,
      bankName: "Harbor Bank",
      accounts: ["4821"],
    });
    const message = withSender(harbor, debit("632211112206"));
    const { recorded } = yield* takeOne(message).pipe(
      Effect.provideService(BankAlertReader.BankAlertReader, {
        read: () =>
          Effect.succeed({
            kind: "transaction" as const,
            direction: "debit" as const,
            amount: "1,250.00",
            currency: "Rs.",
            account: "4821",
            date_printed: "18-11-26",
            date: "2026-11-18",
            reference: "632211112206",
            counterparty: null,
            balance: null,
          }).pipe(
            Effect.tap(() =>
              BankSenders.remove(orgId, rhea, harbor).pipe(
                Effect.provideService(SqlClient.SqlClient, sql),
                Effect.orDie,
              ),
            ),
          ),
      }),
    );
    assert.strictEqual(recorded, 0);
    assert.deepStrictEqual(yield* entries, []);
    assert.deepStrictEqual(yield* sql`SELECT outcome FROM kin_bank_alerts`, [
      { outcome: "sender" },
    ]);
  }).pipe(Effect.provide(layer)),
);

it.effect("an address revoked after the activity lookup never reaches the model", () =>
  Effect.gen(function* () {
    const sql = yield* senderSetup;
    yield* BankSenders.add(orgId, rhea, {
      address: harbor,
      bankName: "Harbor Bank",
      accounts: ["4821"],
    });
    const senders = yield* BankSenders.sendersOf(orgId);
    yield* BankSenders.remove(orgId, rhea, harbor);
    yield* takeAlerts(orgId, {
      connectionId: "approved-inbox",
      threadId: "raced-sender",
      messages: [withSender(harbor, debit("632211112207"))],
      now: NOW,
      senders,
    }).pipe(
      Effect.provideService(BankAlertReader.BankAlertReader, {
        read: () => Effect.die("A revoked sender reached the reader"),
      }),
    );
    assert.deepStrictEqual(yield* entries, []);
    assert.deepStrictEqual(yield* sql`SELECT outcome FROM kin_bank_alerts`, [
      { outcome: "sender" },
    ]);
  }).pipe(Effect.provide(layer)),
);
