import "../../chat/KinChatService.ts";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { KinAgentId, KinChatError, KinOrgId, KinPersonId } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as KinChatHub from "../../chat/KinChatHub.ts";
import * as KinChatRepository from "../../chat/KinChatRepository.ts";
import type { KinAlertMessage } from "../../connections/ConnectionsService.ts";
import * as KinFloor from "../../floor/KinFloor.ts";
import * as KinEventQueue from "../../lead/KinEventQueue.ts";
import * as KinPersistence from "../../persistence/KinPersistence.ts";
import * as KinRecords from "../KinRecords.ts";
import { defineList, PRESETS, presetDefinition } from "../registers.ts";
import { PAY_CARD, SENDER_CARD } from "./alertCards.ts";
import {
  type AlertCandidate,
  answerAlertCard,
  KinAlertReader,
  noticeAlerts,
} from "./bankAlerts.ts";
import { bankKnown } from "./bankKnown.ts";

// Ambermill, an invented company in Auckland, with an invented bank's alerts in its mailbox.
const orgId = KinOrgId.make("ambermill");
const rhea = KinPersonId.make("rhea");
const meera = KinPersonId.make("meera");
const dev = KinPersonId.make("dev");
const finance = KinAgentId.make("finance");
const at = "2026-11-01T00:00:00.000Z";
// 09:00 on 18 Nov in Auckland: still 17 Nov in UTC and in Los Angeles.
const NOW = Date.parse("2026-11-17T20:00:00.000Z");
const MAILBOX = "rhea@ambermill.example";
const BANK = "alerts@harbourtrust.example";
const PASSED = [
  "mx.mail.example; dkim=pass header.d=harbourtrust.example; dmarc=pass header.from=harbourtrust.example",
];
const owner = {
  actor: { _tag: "person" as const, personId: rhea },
  via: "owner" as const,
  askedBy: rhea,
};

const isChatError = Schema.is(KinChatError);
const refusedFor = (error: unknown) => (isChatError(error) ? error.reason : undefined);

const layer = Layer.mergeAll(KinRecords.layer, KinChatHub.layer, KinFloor.layer).pipe(
  Layer.provideMerge(KinChatRepository.layer),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(KinEventQueue.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-bank-alerts-" })),
  Layer.provideMerge(KinPersistence.layer),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(
    Layer.succeed(
      SecureRandom.SecureRandom,
      SecureRandom.make((size) => new Uint8Array(size).fill(7)),
    ),
  ),
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
);

/** Rhea, co-owner Meera and teammate Dev; Finance and its chat with Rhea; two clients, a vendor. */
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const records = yield* KinRecords.KinRecords;
  yield* TestClock.setTime(NOW);
  yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Ambermill', ${at})`;
  yield* sql`INSERT INTO kin_trigger_settings (org_id, time_zone, morning_brief, evening_summary,
      dream, full_rebuild_weekday, owner_check_weekday, owner_check, quiet_hours_json)
    VALUES (${orgId}, 'Pacific/Auckland', '08:00', '18:00', '02:00', 0, 1, '09:00', '[]')`;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
    VALUES (${rhea}, ${orgId}, 'rhea', 'Rhea', ${at}, 'owner'),
      (${meera}, ${orgId}, 'meera', 'Meera', ${at}, 'co_owner'),
      (${dev}, ${orgId}, 'dev', 'Dev', ${at}, 'member')`;
  yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
    VALUES (${finance}, ${orgId}, 'Finance', 'lead', ${rhea}, ${at})`;
  yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
    VALUES ('fin-rhea', ${orgId}, 'direct', ${`${rhea}:${finance}`}, 0, ${at})`;
  yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id,
      agent_id, role, joined_at)
    VALUES ('fin-rhea-person', ${orgId}, 'fin-rhea', 'person', ${rhea}, NULL, 'owner', ${at}),
      ('fin-rhea-lead', ${orgId}, 'fin-rhea', 'agent', NULL, ${finance}, 'member', ${at})`;
  yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, thread_id, models_json,
      worker_projects_json, owner_chat_id, domain)
    VALUES (${finance}, ${orgId}, 'Finance', 0, 'fin-thread', '{}', '[]', 'fin-rhea', 'finance')`;
  for (const id of ["invoices", "expenses"] as const)
    yield* defineList(
      orgId,
      { _tag: "new", id, ...PRESETS[id], definition: presetDefinition(id, "NZD") },
      NOW,
    );
  const create = (input: Parameters<typeof records.create>[2]) =>
    records.create(orgId, owner, input).pipe(Effect.map(({ row }) => row));
  const client = (title: string) =>
    create({
      list: "clients",
      originKey: `client:${title}`,
      title,
      owner: { _tag: "person", personId: rhea },
      category: "client",
    });
  const brightwell = yield* client("Brightwell Ltd");
  const corvid = yield* client("Corvid Labs");
  const invoice = (key: string, partyId: string, minor: number) =>
    create({
      list: "invoices",
      originKey: `invoice:${key}`,
      title: `${key} retainer`,
      owner: { _tag: "person", personId: rhea },
      state: "waiting",
      partyId,
      amount: { minor, currency: "NZD" },
      dateAt: Date.parse("2026-10-31T10:00:00Z"),
      dateAllDay: true,
    });
  const october = yield* invoice("October", brightwell.recordId, 950_000);
  const design = yield* invoice("Design", brightwell.recordId, 420_000);
  const logo = yield* invoice("Logo", brightwell.recordId, 420_000);
  const sprint = yield* invoice("Sprint", corvid.recordId, 420_000);
  yield* create({
    list: "expenses",
    originKey: "expense:northgate",
    title: "Office chairs",
    owner: { _tag: "person", personId: rhea },
    state: "done",
    amount: { minor: 420_000, currency: "NZD" },
    dateAt: Date.parse("2026-11-02T10:00:00Z"),
    dateAllDay: true,
    fields: { vendor: "Northgate Supplies" },
  });
  return { october: october.key, design: design.key, logo: logo.key, sprint: sprint.key };
});

let mails = 0;
/** One alert mail in the mailbox: the poll's line, and the message a counted sender's read gets. */
const alert = (input: {
  readonly text: string;
  readonly subject?: string;
  readonly from?: string;
  readonly authResults?: ReadonlyArray<string>;
  readonly at?: number;
  readonly key?: string;
}) => {
  mails += 1;
  const date = DateTime.formatIso(DateTime.makeUnsafe(input.at ?? NOW - 60_000));
  const from = input.from ?? `Harbour Trust Bank <${BANK}>`;
  const address = (/<([^>]+)>/.exec(from)?.[1] ?? from).toLowerCase();
  const candidate: AlertCandidate = {
    connectionId: "mailbox-1",
    mailbox: MAILBOX,
    threadId: `thread-${mails}`,
    from,
    subject: input.subject ?? "Account alert",
    preview: input.text.slice(0, 100),
    date,
  };
  const message: KinAlertMessage = {
    key: input.key ?? `<m${mails}@harbourtrust.example>`,
    threadId: candidate.threadId,
    fromAddress: address,
    date,
    subject: candidate.subject,
    text: input.text,
    authResults: input.authResults ?? PASSED,
  };
  return { candidate, message };
};
type Mail = ReturnType<typeof alert>;

/** The poll, over a fake mailbox that counts every body it hands out. */
const poll = (mail: ReadonlyArray<Mail>, reads: Array<string> = []) =>
  noticeAlerts(
    orgId,
    mail.map((one) => one.candidate),
    NOW,
    (_org, _connection, threadId, address) =>
      Effect.sync(() => {
        reads.push(threadId);
        return mail
          .filter((one) => one.message.threadId === threadId && one.message.fromAddress === address)
          .map((one) => one.message);
      }),
  );

const credit = (amount: string, extra = "") =>
  `NZD ${amount} credited to your account ••4821${extra}. Avl bal NZD 18,250.00`;

const cards = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return (yield* sql<{ widgetId: string; state: string; chatId: string; awaiting: string }>`
    SELECT widget_id AS "widgetId", state_json AS state, chat_id AS "chatId",
      awaiting_json AS awaiting
    FROM kin_widgets ORDER BY rowid`).map((row) => ({
    ...row,
    state: JSON.parse(row.state) as {
      question: string;
      detail: string;
      options: ReadonlyArray<{ label: string }>;
    },
  }));
});
const alerts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    state: string;
    reason: string | null;
    day: string | null;
    amountMinor: number | null;
    payState: string | null;
  }>`SELECT state, reason, day, amount_minor AS "amountMinor", pay_state AS "payState"
    FROM kin_bank_alerts ORDER BY received_at, alert_id`;
});
const tap = (widgetId: string, label: string, personId: KinPersonId = rhea) =>
  Effect.gen(function* () {
    return yield* answerAlertCard(
      { orgId, widgetId, personId, label, via: "tap", now: NOW },
      yield* KinRecords.KinRecords,
    );
  });
/** Rhea's Yes on the card asking about the bank's alert address. */
const countBank = Effect.gen(function* () {
  yield* poll([alert({ text: credit("5.00") })]);
  const asked = (yield* cards).find((one) => one.widgetId.startsWith(SENDER_CARD))!;
  yield* tap(asked.widgetId, "Yes, count these");
});

describe("bank alerts by mail", () => {
  it.effect("asks once about a sender, reads nothing before the Yes, and counts after it", () =>
    Effect.gen(function* () {
      yield* seed;
      const reads: Array<string> = [];
      const first = alert({ text: credit("950.00", " from BRIGHTWELL LTD") });
      yield* poll([first], reads);
      yield* poll([first], reads);
      const [asked, ...more] = yield* cards;
      assert.lengthOf(more, 0);
      assert.strictEqual(
        asked!.state.question,
        `Is ${BANK} your bank's alerts for account ••4821?`,
      );
      assert.deepStrictEqual(
        asked!.state.options.map((one) => one.label),
        ["Yes, count these", "No"],
      );
      assert.strictEqual(asked!.chatId, "fin-rhea");
      assert.deepStrictEqual(reads, []);
      assert.deepStrictEqual(yield* alerts, []);
      // A teammate's tap is refused; Rhea's counts the sender.
      const refused = yield* tap(asked!.widgetId, "Yes, count these", dev).pipe(Effect.flip);
      assert.strictEqual(refusedFor(refused), "not_allowed");
      const outcome = yield* tap(asked!.widgetId, "Yes, count these");
      assert.strictEqual(outcome?.title, "Counting these alerts");
      yield* poll([first], reads);
      assert.deepStrictEqual(reads, [first.candidate.threadId]);
      const [counted] = yield* alerts;
      // Arrived 09:00 on 18 Nov in Auckland, the company's day, whatever the server's clock says.
      assert.deepInclude(counted, { state: "counted", day: "2026-11-18", amountMinor: 95_000 });
      // Read once: the next poll sees nothing newer in the thread and fetches nothing.
      yield* poll([first], reads);
      assert.lengthOf(reads, 1);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("never counts a sender someone said No to, and never asks again", () =>
    Effect.gen(function* () {
      yield* seed;
      const reads: Array<string> = [];
      yield* poll([alert({ text: credit("5.00") })], reads);
      const [asked] = yield* cards;
      assert.strictEqual((yield* tap(asked!.widgetId, "No"))?.title, "Not counted");
      yield* poll([alert({ text: credit("6.00") })], reads);
      assert.lengthOf(yield* cards, 1);
      assert.deepStrictEqual(reads, []);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps mail that fails or lacks the sender checks, counted nowhere", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* countBank;
      yield* poll([
        alert({
          text: credit("700.00"),
          authResults: ["mx.mail.example; spf=fail; dmarc=fail header.from=harbourtrust.example"],
          at: NOW - 2000,
        }),
        alert({ text: credit("800.00"), authResults: [], at: NOW - 1000 }),
      ]);
      const kept = (yield* alerts).filter((one) => one.amountMinor === null);
      assert.deepStrictEqual(
        kept.map((one) => [one.state, one.reason]),
        [
          ["unchecked", "failed_check"],
          ["unchecked", "not_checked"],
        ],
      );
      assert.deepStrictEqual((yield* bankKnown(orgId)).alerts, []);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("asks about the address a mail is from, never the name it shows", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* countBank;
      const reads: Array<string> = [];
      yield* poll(
        [alert({ text: credit("900.00"), from: `"${BANK}" <payouts@elsewhere.example>` })],
        reads,
      );
      assert.deepStrictEqual(reads, []);
      const asked = (yield* cards).filter((one) => one.widgetId.startsWith(SENDER_CARD));
      assert.strictEqual(
        asked.at(-1)!.state.question,
        "Is payouts@elsewhere.example your bank's alerts for account ••4821?",
      );
      assert.deepStrictEqual(yield* alerts, []);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("counts only the confirmed account, the account's currency and a day that came", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* countBank;
      yield* poll([
        alert({ text: "NZD 300.00 debited from your account ••9050", at: NOW - 3000 }),
        alert({ text: "AUD 300.00 debited from your account ••4821", at: NOW - 2000 }),
        alert({
          text: "NZD 300.00 debited from your account ••4821 on 2026-11-25",
          at: NOW - 1000,
        }),
      ]);
      assert.deepStrictEqual(
        (yield* alerts).map((one) => [one.state, one.reason]),
        [
          ["unread", "other_account"],
          ["unread", "other_currency"],
          ["unread", "future"],
        ],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("asks nothing for a forwarded or a replied alert, or one from the company itself", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* poll([
        alert({
          text: credit("950.00"),
          subject: "Fwd: Account alert",
          from: "Zoya <zoya@friends.example>",
        }),
        alert({ text: credit("950.00"), subject: "Account alert", from: `Rhea <${MAILBOX}>` }),
        alert({
          text: credit("950.00"),
          subject: "RE: Account alert",
          from: "Arjun <arjun@friends.example>",
        }),
      ]);
      assert.deepStrictEqual(yield* cards, []);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("counts the same alert once, from a second mailbox or with the same reference", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* countBank;
      const once = alert({ text: credit("120.00", " ref TX99001234") });
      yield* poll([once]);
      yield* poll([{ ...once, candidate: { ...once.candidate, threadId: "another-thread" } }]);
      yield* poll([alert({ text: credit("120.00", " ref TX99001234") })]);
      const shown = (yield* alerts).filter((one) => one.amountMinor === 12_000);
      assert.deepStrictEqual(
        shown.map((one) => [one.state, one.reason]),
        [
          ["counted", null],
          ["unread", "repeat"],
        ],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("checks a reader's fields like the plain reader's", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* countBank;
      yield* poll([alert({ text: credit("40.00") })]).pipe(
        Effect.provideService(KinAlertReader, {
          read: () => Effect.succeed({ amountMinor: -1, currency: "NZD", direction: "credit" }),
        }),
      );
      assert.deepInclude((yield* alerts).at(-1), { state: "unread", reason: "unreadable" });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("asks whether a client paid, records it on a Yes, and only then", () =>
    Effect.gen(function* () {
      const keys = yield* seed;
      const records = yield* KinRecords.KinRecords;
      yield* countBank;
      yield* poll([alert({ text: credit("9,500.00", " from BRIGHTWELL LTD") })]);
      const asked = (yield* cards).find((one) => one.widgetId.startsWith(PAY_CARD))!;
      assert.strictEqual(asked.state.question, `Did Brightwell Ltd pay ${keys.october}?`);
      assert.strictEqual(
        asked.state.detail,
        "A bank alert on 18 Nov shows NZ$9,500.00 from BRIGHTWELL LTD.",
      );
      assert.deepStrictEqual(
        asked.state.options.map((one) => one.label),
        ["Yes, record it", "No, it's something else", "Not sure yet"],
      );
      assert.strictEqual((yield* records.get(orgId, keys.october))!.paid, 0);
      const refused = yield* tap(asked.widgetId, "Yes, record it", dev).pipe(Effect.flip);
      assert.strictEqual(refusedFor(refused), "not_allowed");
      assert.strictEqual((yield* tap(asked.widgetId, "Yes, record it"))?.title, "Money recorded");
      const detail = yield* records.detail((yield* records.get(orgId, keys.october))!);
      assert.deepStrictEqual(
        detail.payments?.map((one) => [one.paidOn, one.amount.minor, one.source]),
        [["2026-11-18", 950_000, { _tag: "person", personId: rhea, bankAlert: true }]],
      );
      const again = yield* tap(asked.widgetId, "Yes, record it").pipe(Effect.flip);
      assert.strictEqual(refusedFor(again), "widget_changed");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("No leaves it unexplained, Not sure records nothing; one card per alert", () =>
    Effect.gen(function* () {
      const keys = yield* seed;
      const records = yield* KinRecords.KinRecords;
      yield* countBank;
      yield* poll([alert({ text: credit("9,500.00", " from BRIGHTWELL LTD") })]);
      const pay = () =>
        Effect.map(cards, (all) => all.filter((one) => one.widgetId.startsWith(PAY_CARD)));
      const [first] = yield* pay();
      yield* tap(first!.widgetId, "Not sure yet");
      yield* poll([
        alert({ text: credit("9,500.00", " from BRIGHTWELL LTD"), key: "<m-other@x>" }),
      ]);
      const [, second] = yield* pay();
      yield* tap(second!.widgetId, "No, it's something else");
      assert.deepStrictEqual(
        (yield* alerts).filter((one) => one.payState !== null).map((one) => one.payState),
        ["unsure", "other"],
      );
      assert.strictEqual((yield* records.get(orgId, keys.october))!.paid, 0);
      assert.lengthOf(yield* pay(), 2);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "lists two invoices of one client's amount to pick from, and asks of two clients' none",
    () =>
      Effect.gen(function* () {
        const keys = yield* seed;
        const records = yield* KinRecords.KinRecords;
        yield* countBank;
        yield* poll([alert({ text: credit("4,200.00", " from BRIGHTWELL LTD") })]);
        yield* poll([alert({ text: credit("4,200.00") })]);
        const pay = (yield* cards).filter((one) => one.widgetId.startsWith(PAY_CARD));
        assert.lengthOf(pay, 1);
        assert.deepStrictEqual(
          pay[0]!.state.options.map((one) => one.label),
          [`Yes, ${keys.design}`, `Yes, ${keys.logo}`, "No, it's something else", "Not sure yet"],
        );
        yield* tap(pay[0]!.widgetId, `Yes, ${keys.design}`);
        assert.strictEqual((yield* records.get(orgId, keys.design))!.paid, 420_000);
        assert.strictEqual((yield* records.get(orgId, keys.logo))!.paid, 0);
        assert.strictEqual((yield* records.get(orgId, keys.sprint))!.paid, 0);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("asks nothing of a vendor's refund", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* countBank;
      // Only one owed invoice is 9,500, but the money is from a vendor.
      yield* poll([alert({ text: credit("9,500.00", " from NORTHGATE SUPPLIES") })]);
      assert.lengthOf(
        (yield* cards).filter((one) => one.widgetId.startsWith(PAY_CARD)),
        0,
      );
      assert.deepInclude((yield* alerts).at(-1), { state: "counted", payState: null });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("adds a reach and a balance beside the statements' day, never moving it", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const review = {
        statement: {
          kind: "account",
          bank: "Harbour Trust",
          account: "4821",
          currency: "NZD",
          from: "2026-10-01",
          to: "2026-10-31",
          openingMinor: 0,
          closingMinor: 1_000_000,
          rows: [],
          check: { status: "adds_up", line: "" },
        },
        format: "csv",
        source: "file",
        known: [],
        matches: [],
      };
      yield* sql`INSERT INTO kin_bank_statements (org_id, statement_id, attachment_id, file_name,
          chat_id, agent_id, wakeup_id, status, review_json, created_at, read_at, applied_at)
        VALUES (${orgId}, 'st-oct', 'att', 'invented.csv', 'fin-rhea', ${finance}, 'w', 'read',
          ${JSON.stringify(review)}, 0, 1, 1)`;
      yield* countBank;
      yield* poll([
        alert({
          text: "NZD 200.00 debited from your account ••4821 at CORNER CAFE",
          at: NOW - 30_000,
        }),
        alert({
          text: "NZD 50.00 credited to your account ••4821 on 2026-10-30",
          at: NOW - 20_000,
        }),
      ]);
      const known = yield* bankKnown(orgId);
      assert.strictEqual(known.through, "2026-10-31");
      assert.deepStrictEqual(known.alerts, [
        {
          account: "Harbour Trust Account ••4821",
          digits: "4821",
          currency: "NZD",
          since: "2026-10-31",
          seenThrough: "2026-11-18",
          in: 0,
          out: 1,
          // No balance in the newest: the closing balance less the 200.00 out since.
          balance: { minor: 1_000_000 - 20_000, on: "2026-11-18", estimate: true },
        },
      ]);
      assert.deepInclude((yield* alerts).at(-1), { state: "unread", reason: "covered" });
      yield* poll([alert({ text: credit("10.00"), at: NOW - 10_000 })]);
      assert.deepStrictEqual((yield* bankKnown(orgId)).alerts[0]!.balance, {
        minor: 1_825_000,
        on: "2026-11-18",
        estimate: false,
      });
    }).pipe(Effect.provide(layer)),
  );
});
