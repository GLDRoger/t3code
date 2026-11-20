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
import type { SqlError } from "effect/sql/SqlError";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as KinChatHub from "../../chat/KinChatHub.ts";
import * as KinChatRepository from "../../chat/KinChatRepository.ts";
import type { KinAlertMessage } from "../../connections/ConnectionsService.ts";
import type { SenderVerdict } from "../../connections/MailAuth.ts";
import * as KinFloor from "../../floor/KinFloor.ts";
import * as KinEventQueue from "../../lead/KinEventQueue.ts";
import * as KinPersistence from "../../persistence/KinPersistence.ts";
import * as KinRecords from "../KinRecords.ts";
import { defineList, PRESETS, presetDefinition } from "../registers.ts";
import { PAY_CARD, SENDER_CARD } from "./alertCards.ts";
import { settleAlerts } from "./alertLines.ts";
import { setAlertSender } from "./alertSenders.ts";
import {
  type AlertCandidate,
  type AlertMailbox,
  answerAlertCard,
  bindApprovals,
  LOOKBACK_MS,
  noticeAlerts,
  settleReading,
} from "./bankAlerts.ts";
import { bankKnown } from "./bankKnown.ts";
import type { Statement } from "./statementTable.ts";

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
  // Rhea's mailbox, signed in and allowed to read a thread: the alerts' mailbox.
  yield* sql`INSERT INTO kin_connections (org_id, connection_id, preset, label, kind, url_host,
      auth, reach, state, account_label, created_at, updated_at)
    VALUES (${orgId}, 'mailbox-1', 'google', 'Gmail', 'builtin', 'gmail.googleapis.com', 'oauth',
      'open', 'active', ${MAILBOX}, 0, 0)`;
  yield* sql`INSERT INTO kin_connection_tools (org_id, connection_id, tool_name, definition_json,
      pin_digest, mode, suggested_mode, open_world, first_seen_at)
    VALUES (${orgId}, 'mailbox-1', 'mail_read_thread', '{}', 'pin', 'read', 'read', 0, 0)`;
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
type Mail = { readonly candidate: AlertCandidate; readonly message: KinAlertMessage };
/** One mail in Rhea's mailbox: the poll's summary of its thread, and the message itself. */
const mail = (input: {
  readonly text: string;
  readonly subject?: string;
  readonly from?: string;
  readonly verdict?: SenderVerdict;
  readonly at?: number;
  readonly inReplyTo?: string;
}): Mail => {
  mails += 1;
  const at = input.at ?? NOW - 60_000 + mails;
  const from = input.from ?? `Harbour Trust Bank <${BANK}>`;
  const address = (/<([^>]+)>/.exec(from)?.[1] ?? from).toLowerCase();
  return {
    candidate: {
      connectionId: "mailbox-1",
      mailbox: MAILBOX,
      threadId: `thread-${mails}`,
      from,
      subject: input.subject ?? "Account alert",
      preview: input.text.slice(0, 100),
      date: DateTime.formatIso(DateTime.makeUnsafe(at)),
    },
    message: {
      messageId: `m${mails}`,
      receivedAt: at,
      subject: input.subject ?? "Account alert",
      text: input.text,
      inReplyTo: input.inReplyTo ?? null,
      references: null,
      sender: { verdict: input.verdict ?? "passed", address },
    },
  };
};

/**
 * Rhea's mailbox as the alert read sees it: a sender's own messages from a time, oldest first,
 * a page at a time. It logs each body it hands out; `during` runs while a read is in flight.
 */
const mailbox =
  (
    box: ReadonlyArray<Mail>,
    log: Array<string> = [],
    options: {
      fail?: boolean;
      during?: Effect.Effect<void, KinChatError | SqlError, SqlClient.SqlClient>;
    } = {},
  ): AlertMailbox =>
  (_org, _connection, query) =>
    Effect.gen(function* () {
      if (options.fail === true)
        return yield* new KinChatError({ reason: "unavailable", message: "Gmail is down." });
      if (options.during !== undefined) yield* Effect.orDie(options.during);
      const theirs = box
        .filter(
          (one) =>
            one.message.sender.address === query.address && one.message.receivedAt! >= query.since,
        )
        .toSorted((a, b) => a.message.receivedAt! - b.message.receivedAt!);
      const page = theirs.slice(0, query.max);
      log.push(...page.map((one) => one.message.messageId));
      return {
        messages: page.map((one) => one.message),
        through: page.at(-1)?.message.receivedAt ?? null,
        more: theirs.length > query.max,
      };
    }).pipe(Effect.provideService(SqlClient.SqlClient, sqlOf.value!));
const sqlOf: { value?: SqlClient.SqlClient } = {};
/** The poll: the summaries it holds, and the mailbox the alert read fetches from. */
const poll = (
  summaries: ReadonlyArray<Mail>,
  box: ReadonlyArray<Mail> = summaries,
  log: Array<string> = [],
  options: Parameters<typeof mailbox>[2] & { readonly at?: number } = {},
) =>
  Effect.gen(function* () {
    sqlOf.value = yield* SqlClient.SqlClient;
    yield* noticeAlerts(
      orgId,
      summaries.map((one) => one.candidate),
      options.at ?? NOW,
      mailbox(box, log, options),
    );
  });

const credit = (amount: string, extra = "") =>
  `NZD ${amount} credited to your account ••4821${extra}. Avl bal NZD 18,250.00`;

const cards = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return (yield* sql<{ widgetId: string; state: string; chatId: string; closedAt: string | null }>`
    SELECT widget_id AS "widgetId", state_json AS state, chat_id AS "chatId",
      closed_at AS "closedAt"
    FROM kin_widgets ORDER BY rowid`).map((row) => ({
    ...row,
    state: JSON.parse(row.state) as {
      question: string;
      detail: string;
      options: ReadonlyArray<{ label: string; optionId: string }>;
      outcome?: { title: string; text: string };
    },
  }));
});
const payCards = Effect.map(cards, (all) => all.filter((one) => one.widgetId.startsWith(PAY_CARD)));
const senderCards = Effect.map(cards, (all) =>
  all.filter((one) => one.widgetId.startsWith(SENDER_CARD)),
);
const alerts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    alertId: string;
    state: string;
    reason: string | null;
    day: string | null;
    amountMinor: number | null;
    payState: string | null;
    statementLine: number | null;
  }>`SELECT alert_id AS "alertId", state, reason, day, amount_minor AS "amountMinor",
      pay_state AS "payState", statement_line AS "statementLine"
    FROM kin_bank_alerts ORDER BY received_at, alert_id`;
});
/** A tap on the card's option labelled `label`, by its option id as a client sends it. */
const tap = (widgetId: string, label: string, personId: KinPersonId = rhea) =>
  Effect.gen(function* () {
    const card = (yield* cards).find((one) => one.widgetId === widgetId)!;
    const option = card.state.options.find((one) => one.label === label)!;
    return yield* answerAlertCard(
      { orgId, widgetId, personId, optionId: option.optionId, via: "tap", now: NOW },
      yield* KinRecords.KinRecords,
    );
  });
/** Rhea's Yes on the card asking about the bank's alert address. */
const countBank = Effect.gen(function* () {
  yield* poll([mail({ text: credit("5.00"), at: NOW - LOOKBACK_MS - 60_000 })], []);
  const asked = (yield* senderCards).at(-1)!;
  yield* tap(asked.widgetId, asked.state.options[0]!.label);
});
/** A statement the owner confirmed, of an account of `bank`, ••4821, in NZD, bound as its Confirm binds. */
const confirmed = (id: string, bank: string, from: string, to: string, closingMinor = 1_000_000) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const review = {
      statement: {
        kind: "account",
        bank,
        account: "4821",
        currency: "NZD",
        from,
        to,
        openingMinor: 0,
        closingMinor,
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
      VALUES (${orgId}, ${id}, 'att', 'invented.csv', 'fin-rhea', ${finance}, 'w', 'read',
        ${JSON.stringify(review)}, 0, 1, 1)`;
    yield* bindApprovals(orgId);
  });
const statementOf = (
  bank: string,
  from: string,
  to: string,
  rows: Statement["rows"] = [],
): Statement => ({
  kind: "account",
  bank,
  account: "4821",
  currency: "NZD",
  from,
  to,
  openingMinor: null,
  closingMinor: null,
  rows,
  check: { status: "unchecked", line: "" },
});

describe("bank alerts by mail", () => {
  it.effect(
    "asks once from the poll's summary, reads nothing before the Yes, then reads back seven days",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const log: Array<string> = [];
        const early = mail({
          text: credit("950.00", " from BRIGHTWELL LTD"),
          at: NOW - 3 * 86_400_000,
        });
        yield* poll([early], [early], log);
        yield* poll([early], [early], log);
        const [asked, ...more] = yield* cards;
        assert.lengthOf(more, 0);
        assert.strictEqual(
          asked!.state.question,
          `Is ${BANK} your bank's alerts for your account ••4821?`,
        );
        assert.include(
          asked!.state.detail,
          `${MAILBOX} gets mail from ${BANK} for NZD account ••4821.`,
        );
        assert.deepStrictEqual(
          asked!.state.options.map((one) => one.label),
          ["Yes, count these", "No"],
        );
        assert.strictEqual(asked!.chatId, "fin-rhea");
        assert.deepStrictEqual(log, []);
        assert.deepStrictEqual(yield* alerts, []);
        const refused = yield* tap(asked!.widgetId, "Yes, count these", dev).pipe(Effect.flip);
        assert.strictEqual(refusedFor(refused), "not_allowed");
        assert.strictEqual(
          (yield* tap(asked!.widgetId, "Yes, count these"))?.title,
          "Counting these alerts",
        );
        // The Yes reads the sender's own mail from seven days back, the alert that asked included.
        yield* poll([], [early], log);
        assert.deepStrictEqual(log, [early.message.messageId]);
        assert.deepInclude((yield* alerts)[0], {
          state: "counted",
          day: "2026-11-15",
          amountMinor: 95_000,
        });
        yield* poll([], [early], log);
        assert.lengthOf(log, 1);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("reads a counted bank's alert whatever came after it in the thread", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* countBank;
      // The poll's summary of the thread names the client's reply, its latest message.
      const bank = mail({ text: credit("120.00") });
      const reply = mail({ text: "Did this arrive?", from: "Brightwell <ap@brightwell.example>" });
      const log: Array<string> = [];
      yield* poll([reply], [bank, reply], log);
      assert.deepStrictEqual(log, [bank.message.messageId]);
      assert.deepInclude((yield* alerts).at(-1), { state: "counted", amountMinor: 12_000 });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads more than a page over polls, and a provider error loses nothing", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* countBank;
      const box = Array.from({ length: 25 }, (_, at) =>
        mail({ text: `NZD ${at + 1}.00 debited from your account ••4821`, at: NOW - 50_000 + at }),
      );
      yield* poll([], box, [], { fail: true });
      assert.lengthOf(yield* alerts, 0);
      const log: Array<string> = [];
      yield* poll([], box, log);
      assert.lengthOf(log, 20);
      yield* poll([], box, log);
      assert.lengthOf(new Set(log), 25);
      assert.lengthOf(
        (yield* alerts).filter((one) => one.state === "counted"),
        25,
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps unvouched mail, replies and forwards out of every count", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* countBank;
      yield* poll(
        [],
        [
          mail({ text: credit("700.00"), verdict: "failed" }),
          mail({ text: credit("800.00"), verdict: "not_checked" }),
          mail({ text: credit("900.00"), inReplyTo: "<earlier@harbourtrust.example>" }),
          mail({ text: credit("950.00"), subject: "Fwd: Account alert" }),
        ],
      );
      assert.deepStrictEqual(
        (yield* alerts).map((one) => [one.state, one.reason]),
        [
          ["not_counted", "failed_check"],
          ["not_counted", "not_checked"],
          ["not_counted", "reply"],
          ["not_counted", "reply"],
        ],
      );
      assert.deepStrictEqual((yield* bankKnown(orgId)).alerts, []);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("leaves a declined debit unread for a reader, never a guess", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* countBank;
      yield* poll(
        [],
        [mail({ text: "Debit declined: NZD 50.00 from account ••4821 at CORNER CAFE" })],
      );
      assert.deepInclude((yield* alerts).at(-1), { state: "unread", amountMinor: null });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("checks every reading against the mail and the approval as it stands", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* countBank;
      const sql = yield* SqlClient.SqlClient;
      const text = "Debit declined: NZD 50.00 from account ••4821 at CORNER CAFE";
      yield* poll([], [mail({ text }), mail({ text })]);
      const unread = (yield* alerts).filter((one) => one.state === "unread");
      const row = (alertId: string) =>
        Effect.map(
          sql<{ messageId: string; receivedAt: number }>`SELECT message_id AS "messageId",
            received_at AS "receivedAt" FROM kin_bank_alerts WHERE alert_id = ${alertId}`,
          ([one]) => ({
            alertId,
            connectionId: "mailbox-1",
            messageId: one!.messageId,
            address: BANK,
            subject: "Account alert",
            receivedAt: one!.receivedAt,
          }),
        );
      const reading = {
        amountMinor: 5_500,
        currency: "NZD",
        direction: "debit" as const,
        day: "2026-11-18",
        account: "4821",
        party: null,
        balanceMinor: null,
        reference: null,
      };
      // A reader's amount the mail doesn't print is not counted.
      yield* settleReading(orgId, yield* row(unread[0]!.alertId), reading, text, NOW, { count: 0 });
      // Once the sender is stopped, a reading of its mail counts nothing.
      yield* setAlertSender({
        orgId,
        connectionId: "mailbox-1",
        address: BANK,
        account: "4821",
        currency: "NZD",
        to: "stopped",
        personId: rhea,
        now: NOW,
      });
      yield* settleReading(
        orgId,
        yield* row(unread[1]!.alertId),
        { ...reading, amountMinor: 5_000 },
        text,
        NOW,
        { count: 0 },
      );
      assert.deepStrictEqual(
        (yield* alerts).map((one) => [one.state, one.reason]),
        [
          ["not_counted", "not_in_text"],
          ["not_counted", "stopped"],
        ],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a Stop that lands while a read is in flight is seen by its write", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* countBank;
      const stop = setAlertSender({
        orgId,
        connectionId: "mailbox-1",
        address: BANK,
        account: "4821",
        currency: "NZD",
        to: "stopped",
        personId: rhea,
        now: NOW,
      }).pipe(Effect.asVoid);
      yield* poll([], [mail({ text: credit("300.00") })], [], { during: stop });
      assert.deepInclude((yield* alerts).at(-1), { state: "not_counted", reason: "stopped" });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("names the account a statement holds, asks which of several, and binds to it", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* confirmed("st-a", "Harbour Trust", "2026-10-01", "2026-10-31");
      yield* poll([mail({ text: credit("5.00") })], []);
      assert.strictEqual(
        (yield* senderCards)[0]!.state.question,
        `Is ${BANK} your bank's alerts for your Harbour Trust account ••4821?`,
      );
      yield* confirmed("st-b", "Kowhai Bank", "2026-10-01", "2026-10-31");
      yield* poll([mail({ text: credit("5.00"), from: "Kowhai <notify@kowhai.example>" })], []);
      const several = (yield* senderCards)[1]!;
      assert.deepStrictEqual(
        several.state.options.map((one) => one.label),
        ["Yes, Harbour Trust ••4821", "Yes, Kowhai Bank ••4821", "None of these", "No"],
      );
      yield* tap(several.widgetId, "Yes, Kowhai Bank ••4821");
      const sql = yield* SqlClient.SqlClient;
      assert.deepStrictEqual(
        yield* sql`SELECT address, bound, bound_bank AS bank FROM kin_bank_alert_senders
          WHERE state = 'counted' ORDER BY address`,
        [{ address: "notify@kowhai.example", bound: "bound", bank: "kowhaibank" }],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("gives a counted address's other account its own card", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* countBank;
      yield* poll([], [mail({ text: "NZD 300.00 debited from your account ••9050" })]);
      assert.deepInclude((yield* alerts).at(-1), { state: "not_counted", reason: "other_account" });
      assert.strictEqual(
        (yield* senderCards).at(-1)!.state.question,
        `Is ${BANK} your bank's alerts for your account ••9050?`,
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a statement settles only its own account's alerts, a stopped sender's too", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* confirmed("st-a", "Harbour Trust", "2026-09-01", "2026-09-30");
      yield* countBank;
      yield* poll([], [mail({ text: "NZD 40.00 debited from your account ••4821 on 2026-11-16" })]);
      yield* setAlertSender({
        orgId,
        connectionId: "mailbox-1",
        address: BANK,
        account: "4821",
        currency: "NZD",
        to: "stopped",
        personId: rhea,
        now: NOW,
      });
      const row = {
        index: 3,
        date: "2026-11-16",
        description: "CORNER CAFE",
        reference: null,
        amountMinor: 4_000,
        direction: "debit" as const,
        balanceMinor: null,
        foreign: null,
      };
      // Another bank's account with the same digits leaves these alerts alone.
      const other = yield* settleAlerts(
        orgId,
        "st-k",
        statementOf("Kowhai Bank", "2026-11-01", "2026-11-17", [row]),
      );
      assert.deepStrictEqual(other.replaced, []);
      const own = yield* settleAlerts(
        orgId,
        "st-h",
        statementOf("Harbour Trust", "2026-11-01", "2026-11-17", [row]),
      );
      assert.lengthOf(own.replaced, 1);
      assert.deepInclude((yield* alerts).at(-1), { state: "replaced", statementLine: 3 });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("records a payment only on a tap, by the invoice it offered, never the label", () =>
    Effect.gen(function* () {
      const keys = yield* seed;
      const records = yield* KinRecords.KinRecords;
      yield* countBank;
      yield* poll([], [mail({ text: credit("9,500.00", " from BRIGHTWELL LTD") })]);
      const asked = (yield* payCards)[0]!;
      assert.strictEqual(asked.state.question, `Did Brightwell Ltd pay ${keys.october}?`);
      assert.strictEqual(
        asked.state.detail,
        "A bank alert on 18 Nov shows NZ$9,500.00 from BRIGHTWELL LTD.",
      );
      assert.deepStrictEqual(
        asked.state.options.map((one) => one.label),
        [
          `Brightwell Ltd · ${keys.october} · NZ$9,500.00`,
          "No, it's something else",
          "Not sure yet",
        ],
      );
      assert.strictEqual((yield* records.get(orgId, keys.october))!.paid, 0);
      const refused = yield* tap(asked.widgetId, asked.state.options[0]!.label, dev).pipe(
        Effect.flip,
      );
      assert.strictEqual(refusedFor(refused), "not_allowed");
      assert.strictEqual(
        (yield* tap(asked.widgetId, asked.state.options[0]!.label))?.title,
        "Money recorded",
      );
      const detail = yield* records.detail((yield* records.get(orgId, keys.october))!);
      assert.deepStrictEqual(
        detail.payments?.map((one) => [one.paidOn, one.amount.minor, one.source]),
        [["2026-11-18", 950_000, { _tag: "person", personId: rhea, bankAlert: true }]],
      );
      const again = yield* tap(asked.widgetId, asked.state.options[0]!.label).pipe(Effect.flip);
      assert.strictEqual(refusedFor(again), "widget_changed");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("records nothing once the invoice moved, and asks again once from a fresh match", () =>
    Effect.gen(function* () {
      const keys = yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const records = yield* KinRecords.KinRecords;
      yield* countBank;
      yield* poll([], [mail({ text: credit("9,500.00", " from BRIGHTWELL LTD") })]);
      const asked = (yield* payCards)[0]!;
      // The invoice moved to another client while the card was open.
      yield* sql`UPDATE kin_records SET party_id = (SELECT record_id FROM kin_records
          WHERE title = 'Corvid Labs') WHERE key = ${keys.october}`;
      const outcome = yield* tap(asked.widgetId, asked.state.options[0]!.label);
      assert.strictEqual(outcome?.title, "Nothing recorded");
      assert.strictEqual((yield* records.get(orgId, keys.october))!.paid, 0);
      // The fresh match names no Brightwell invoice of that amount, so no card is drawn again.
      assert.lengthOf(yield* payCards, 1);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("offers invoices across clients by name, and none from a vendor's refund", () =>
    Effect.gen(function* () {
      const keys = yield* seed;
      yield* countBank;
      // No payer named: the three owed 4,200 invoices, each with its client.
      yield* poll([], [mail({ text: "NZD 4,200.00 credited to your account ••4821" })]);
      assert.deepStrictEqual(
        (yield* payCards)[0]!.state.options.map((one) => one.label).slice(0, 3),
        [
          `Brightwell Ltd · ${keys.design} · NZ$4,200.00`,
          `Brightwell Ltd · ${keys.logo} · NZ$4,200.00`,
          `Corvid Labs · ${keys.sprint} · NZ$4,200.00`,
        ],
      );
      // A payer named like a vendor is a refund, never a client's payment.
      yield* poll([], [mail({ text: credit("9,500.00", " from NORTHGATE SUPPLIES") })]);
      assert.lengthOf(yield* payCards, 1);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "a Stop closes the waiting card, and a tap on a card no longer usable records nothing",
    () =>
      Effect.gen(function* () {
        const keys = yield* seed;
        const records = yield* KinRecords.KinRecords;
        yield* countBank;
        yield* poll([], [mail({ text: credit("9,500.00", " from BRIGHTWELL LTD") })]);
        const asked = (yield* payCards)[0]!;
        yield* setAlertSender({
          orgId,
          connectionId: "mailbox-1",
          address: BANK,
          account: "4821",
          currency: "NZD",
          to: "stopped",
          personId: rhea,
          now: NOW,
        });
        // The tap that races the Stop's card closing.
        const outcome = yield* tap(asked.widgetId, asked.state.options[0]!.label);
        assert.deepStrictEqual(outcome, {
          title: "Nothing recorded",
          text: "Kin stopped counting this sender's alerts, so nothing can be recorded from this card.",
        });
        assert.strictEqual((yield* records.get(orgId, keys.october))!.paid, 0);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("a statement that covers the day closes the card, and Not sure asks nothing more", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* countBank;
      yield* poll(
        [],
        [
          mail({ text: credit("9,500.00", " from BRIGHTWELL LTD") }),
          mail({ text: "NZD 4,200.00 credited to your account ••4821" }),
        ],
      );
      const [first, second] = yield* payCards;
      assert.strictEqual((yield* tap(second!.widgetId, "Not sure yet"))?.title, "Left for now");
      yield* confirmed("st-nov", "", "2026-11-01", "2026-11-18");
      const why = yield* tap(first!.widgetId, first!.state.options[0]!.label);
      assert.strictEqual(
        why?.text,
        "A confirmed bank statement covers this day now, so its review answers for this money instead.",
      );
      assert.lengthOf(yield* payCards, 2);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("takes back a No only on Ask me again, and then only asks", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* poll([mail({ text: credit("5.00") })], []);
      const [asked] = yield* senderCards;
      assert.strictEqual((yield* tap(asked!.widgetId, "No"))?.title, "Not counted");
      const log: Array<string> = [];
      yield* poll([mail({ text: credit("6.00") })], [], log);
      assert.lengthOf(yield* senderCards, 1);
      yield* setAlertSender({
        orgId,
        connectionId: "mailbox-1",
        address: BANK,
        account: "4821",
        currency: "NZD",
        to: "ask_again",
        personId: rhea,
        now: NOW,
      });
      yield* poll([mail({ text: credit("7.00") })], [], log, { at: NOW + 60_000 });
      assert.lengthOf(yield* senderCards, 2);
      assert.deepStrictEqual(log, []);
      assert.deepStrictEqual(yield* alerts, []);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("counts a repeat once per approval, and a not-counted copy blocks no later count", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* countBank;
      const box = [
        mail({ text: credit("120.00", " ref TX99001234") }),
        mail({ text: credit("120.00", " ref TX99001234") }),
      ];
      yield* poll([], box);
      assert.deepStrictEqual(
        (yield* alerts).map((one) => [one.state, one.reason]),
        [
          ["counted", null],
          ["not_counted", "repeat"],
        ],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "reaches past the account's own statements, and stops counting a disconnected mailbox",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        yield* confirmed("st-oct", "Harbour Trust", "2026-10-01", "2026-11-12");
        yield* countBank;
        yield* poll(
          [],
          [
            mail({ text: "NZD 200.00 debited from your account ••4821 at CORNER CAFE" }),
            mail({ text: "NZD 50.00 credited to your account ••4821 on 2026-11-12" }),
          ],
        );
        const known = yield* bankKnown(orgId);
        assert.strictEqual(known.through, "2026-11-12");
        assert.deepStrictEqual(known.alerts, [
          {
            account: "Harbour Trust Account ••4821",
            digits: "4821",
            currency: "NZD",
            since: "2026-11-12",
            seenThrough: "2026-11-18",
            in: 0,
            out: 1,
            // No balance in the newest: the closing balance less the 200.00 out since.
            balance: { minor: 1_000_000 - 20_000, on: "2026-11-18", estimate: true },
          },
        ]);
        assert.deepInclude((yield* alerts).at(-1), { state: "not_counted", reason: "covered" });
        yield* sql`UPDATE kin_connections SET paused_at = ${NOW}`;
        const off = yield* bankKnown(orgId);
        assert.deepStrictEqual(off.alerts, []);
        assert.deepStrictEqual(off.alertsStopped, [{ mailbox: MAILBOX, on: "2026-11-18" }]);
      }).pipe(Effect.provide(layer)),
  );
});
