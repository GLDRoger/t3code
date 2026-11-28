import "../../chat/KinChatService.ts";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  KinAgentId,
  KinOrgId,
  KinPersonId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import type { McpInvocationScope } from "../../../mcp/McpInvocationContext.ts";
import * as KinChatHub from "../../chat/KinChatHub.ts";
import * as KinChatRepository from "../../chat/KinChatRepository.ts";
import { KinIdentity } from "../../chat/KinIdentity.ts";
import { makeMigratedSqliteLayer } from "../../persistence/migratedSqlite.testkit.ts";
import { homeCurrency, newCompanyProfileJson } from "../companyProfile.ts";
import { ensureBankList } from "./bankList.ts";
import { approveFixtureAlertSender, seedFixtureAlertMailbox } from "./bankAlerts.testkit.ts";
import * as Schema from "effect/Schema";
import { checkMoneyIn, MoneyInCheckInput, moneyInCheck } from "./moneyInCheck.ts";

const org = KinOrgId.make("tidewater");
const owner = KinPersonId.make("rhea");
const agent = KinAgentId.make("finance");
const thread = ThreadId.make("finance-thread");
const at = "2026-11-01T02:00:00.000Z";
const now = Date.parse("2026-11-28T12:00:00Z");
const on = (day: number) => `2026-11-${String(day).padStart(2, "0")}`;
const ms = (day: number) => Date.parse(`${on(day)}T12:00:00Z`);
const range = { from: on(1), through: on(28) };
const marker = "OUTSIDE PRINTED TEXT MARKER";
const isCheckInput = Schema.is(MoneyInCheckInput);
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("fixture"),
  requestNamespace: "fixture",
  issuedAt: 0,
  capabilities: new Set(),
  client: undefined,
  thread: {
    threadId: thread,
    providerSessionId: "fixture",
    providerInstanceId: ProviderInstanceId.make("claude"),
  },
};
const layer = Layer.mergeAll(
  KinChatHub.layer.pipe(Layer.provideMerge(KinChatRepository.layer)),
  Layer.mock(KinIdentity)({
    owner: { _tag: "person", orgId: org, personId: owner },
    isLeadThread: () => true,
    isAgentThread: () => true,
    resolveAgent: () =>
      Effect.succeed({
        _tag: "agent",
        orgId: org,
        agentId: agent,
        ownerPersonId: owner,
        threadId: thread,
      }),
  }),
).pipe(Layer.provideMerge(makeMigratedSqliteLayer()));

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* TestClock.setTime(now);
  yield* sql`INSERT INTO kin_orgs VALUES (${org}, 'Tidewater Freight', ${at})`;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
    VALUES (${owner}, ${org}, 'rhea', 'Rhea', ${at}, 'owner'),
      ('meera', ${org}, 'meera', 'Meera', ${at}, 'co_owner'),
      ('zoya', ${org}, 'zoya', 'Zoya', ${at}, 'member')`;
  yield* sql`INSERT INTO kin_trigger_settings (org_id, time_zone, morning_brief, evening_summary, dream, full_rebuild_weekday, owner_check_weekday, owner_check, quiet_hours_json) VALUES (${org}, 'Asia/Kolkata', '08:00', '18:00', '02:00', 0, 1, '09:00', '[]')`;
  yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in, created_at)
    VALUES (${org}, 'clients', 'Clients', 'C', 1, 0), (${org}, 'invoices', 'Invoices', 'INV', 1, 0),
      (${org}, 'receipts', 'Receipts', 'RCT', 1, 0)`;
  yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, state,
      owner_kind, owner_id, confirmed, created_by_kind, origin_key, created_at, updated_at, fields_json)
    VALUES (${org}, 'c3', 'clients', 'C-3', 'Juniper Cold Chain', 'open', 'person', ${owner}, 1, 'person', 'c3', 0, 0, '{}'),
      (${org}, 'c4', 'clients', 'C-4', 'Tidewater Freight', 'open', 'person', ${owner}, 1, 'person', 'c4', 0, 0, '{}')`;
  return sql;
});

const payment = Effect.fn("MoneyInCheck.testPayment")(function* (
  id: number,
  opts: {
    day?: number;
    minor?: number;
    currency?: string;
    received?: number;
    receivedCurrency?: string;
    origin?: string;
    entryOrigin?: string;
    client?: string;
    withheld?: boolean;
    voided?: boolean;
  } = {},
) {
  const sql = yield* SqlClient.SqlClient;
  const recordId = `inv-${id}`;
  const paidOn = on(opts.day ?? 9);
  const receipt = opts.entryOrigin !== undefined;
  const currency = opts.currency ?? "INR";
  yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, state, owner_kind,
      owner_id, party_id, date_at, amount_minor, currency, confirmed, created_by_kind, origin_key,
      created_at, updated_at, fields_json)
    VALUES (${org}, ${recordId}, ${receipt ? "receipts" : "invoices"}, ${`${receipt ? "RCT" : "INV"}-${id}`},
      'Invented work', 'done', 'person', ${owner}, ${opts.client ?? "c3"}, ${ms(1)},
      ${opts.minor ?? 12_000}, ${currency}, 1, 'person', ${opts.entryOrigin ?? recordId}, 0, 0,
      ${JSON.stringify({ number: `JUN-2026-${id}` })}) ON CONFLICT DO NOTHING`;
  yield* sql`INSERT INTO kin_record_payments (org_id, record_id, payment_id, amount_minor, currency,
      paid_on, note, origin_key, created_at, created_by_kind, withheld, received_minor, received_currency, voided_at)
    VALUES (${org}, ${recordId}, ${`p${id}`}, ${opts.minor ?? 12_000}, ${currency}, ${paidOn}, '',
      ${opts.origin ?? `payment:${id}`}, 0, 'person', ${opts.withheld ? 1 : 0}, ${opts.received ?? null},
      ${opts.receivedCurrency ?? null}, ${opts.voided ? now : null})`;
});

const bank = Effect.fn("MoneyInCheck.testBank")(function* (
  id: number,
  opts: {
    day?: number;
    dateAt?: number;
    minor?: number;
    currency?: string;
    account?: string;
    printed?: string;
    category?: string;
    state?: string;
    source?: "statement" | "alert" | "manual";
    actor?: "system" | "agent";
  } = {},
) {
  const sql = yield* SqlClient.SqlClient;
  const def = yield* ensureBankList(org, now);
  const key = `BNK-${id}`;
  const record = `bank-${id}`;
  const account = opts.account ?? "4821";
  const source = opts.source ?? "statement";
  yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, state, owner_kind,
      owner_id, date_at, amount_minor, currency, category, confirmed, created_by_kind, origin_key,
      created_at, updated_at, fields_json)
    VALUES (${org}, ${record}, ${def.id}, ${key}, ${opts.printed ?? "Juniper Cold Chain"},
      ${opts.state ?? "open"}, 'person', ${owner}, ${opts.dateAt ?? ms(opts.day ?? 9)}, ${opts.minor ?? 12_000},
      ${opts.currency ?? "INR"}, ${opts.category ?? null}, 1, ${opts.actor ?? "system"}, ${`${source === "statement" ? "bank" : source}:${id}`}, 0, 0,
      ${JSON.stringify({ account: `Harbor Bank ••${account}`, direction: "credit" })})`;
  if (source === "alert") yield* alert(`bank-${id}`, opts.day ?? 9, "recorded", account, record);
});

const statement = Effect.fn("MoneyInCheck.testStatement")(function* (
  id = 1,
  { from = 1, through = 12, currency = "INR", account = "4821" } = {},
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_bank_statements (org_id, statement_id, attachment_id, file_name, chat_id,
      agent_id, wakeup_id, status, review_json, created_at, applied_at)
    VALUES (${org}, ${`s${id}`}, 'fixture', 'statement.csv', 'finance-chat', ${agent}, 'wake', 'read',
      ${JSON.stringify({ statement: { kind: "account", bank: "Harbor Bank", account, currency, from: on(from), to: on(through), rows: [] } })},
      0, ${now})`;
});

const alert = Effect.fn("MoneyInCheck.testAlert")(function* (
  id: string,
  day: number,
  outcome: string,
  account: string | null,
  record: string | null = null,
  address = "alerts@harborbank.example",
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_bank_alerts (org_id, alert_id, connection_id, thread_id, sent_at,
      outcome, bank, account, record_id, sender_address, seen_at)
    VALUES (${org}, ${id}, 'work-mail', ${id}, ${ms(day)}, ${outcome}, 'Harbor Bank',
      ${account}, ${record}, ${address}, ${now})`;
});

const link = Effect.fn("MoneyInCheck.testLink")(function* (id: number, pay: number, prior = false) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_bank_statement_entries
      (org_id, statement_id, seq, row_index, bank_record_id, action, target_record_id, payment_id, prior_json)
    VALUES (${org}, 's1', ${pay}, ${id}, ${`bank-${id}`}, 'payment', ${`inv-${pay}`},
      ${prior ? null : `p${pay}`}, ${prior ? JSON.stringify({ matched: `p${pay}` }) : null})`;
});

const groups = [
  {
    label: "bank-card ties including a split's advance, but not withheld tax",
    group: "matched",
    setup: Effect.gen(function* () {
      yield* bank(1, { minor: 13_000 });
      yield* payment(1, { minor: 7_000, origin: "bank-credit:bank-1:w_1:split:inv-1" });
      yield* payment(2, { minor: 5_000, origin: "bank-credit:bank-1:w_1:split:inv-2" });
      yield* payment(3, { minor: 1_000, entryOrigin: "bank-credit:bank-1:w_1:left" });
      yield* payment(4, { minor: 500, withheld: true, origin: "bank-credit:bank-1:w_1:withheld" });
    }),
  },
  {
    label: "statement Confirm links a previous payment, even 19 days apart",
    group: "matched",
    setup: Effect.gen(function* () {
      yield* statement();
      yield* bank(1, { day: 3 });
      yield* payment(1, { day: 22 });
      yield* link(1, 1, true);
    }),
  },
  {
    label: "statement Confirm creates a foreign-currency payment at the received amount",
    group: "matched",
    setup: Effect.gen(function* () {
      yield* statement(1, { currency: "USD" });
      yield* bank(1, { currency: "USD", minor: 995 });
      yield* payment(1, { minor: 83_000, received: 995, receivedCurrency: "USD" });
      yield* link(1, 1);
    }),
  },
  { label: "unexplained credit with no payment", group: "bankOnly", setup: bank(1) },
  {
    label: "bank-only credit has one ranked invoice",
    group: "bankOnly",
    words: "looks like INV-1's payment from Juniper Cold Chain",
    setup: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* payment(1, { voided: true });
      yield* sql`UPDATE kin_records SET state = 'waiting' WHERE record_id = 'inv-1'`;
      yield* bank(1, { printed: "Juniper Cold Chain JUN-2026-1" });
    }),
  },
  {
    label: "bank-only credit has several of one client's open invoices",
    group: "bankOnly",
    words: "Kin can't tell which of Juniper Cold Chain's open invoices it pays",
    setup: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* payment(1, { minor: 7_000, voided: true });
      yield* payment(2, { minor: 9_000, voided: true });
      yield* sql`UPDATE kin_records SET state = 'waiting' WHERE register_id = 'invoices'`;
      yield* bank(1);
    }),
  },
  {
    label: "unpaired payment on a confirmed day",
    group: "kinOnly",
    setup: Effect.gen(function* () {
      yield* statement();
      yield* payment(1);
    }),
  },
  { label: "unpaired payment on an alert-only day", group: "notSeenYet", setup: payment(1) },
  {
    label: "difference in amount only",
    group: "differs",
    reason: "amount",
    setup: Effect.gen(function* () {
      yield* bank(1, { minor: 13_000 });
      yield* payment(1);
    }),
  },
  {
    label: "difference in tied payer",
    group: "differs",
    reason: "payer",
    setup: Effect.gen(function* () {
      yield* statement();
      yield* bank(1, { printed: "Tidewater Freight" });
      yield* payment(1);
      yield* link(1, 1);
    }),
  },
  {
    label: "difference in the sum after taking back a split part",
    group: "differs",
    reason: "sum",
    setup: Effect.gen(function* () {
      yield* bank(1, { minor: 13_000, state: "done", category: "payment received" });
      yield* payment(1, { minor: 7_000, origin: "bank-credit:bank-1:w_1:split:inv-1" });
      yield* payment(2, {
        minor: 6_000,
        voided: true,
        origin: "bank-credit:bank-1:w_1:split:inv-2",
      });
    }),
  },
  ...[-10, -4, -3, 3, 4, 10].map((gap) => ({
    label: `an untied pair ${gap} days apart`,
    group: Math.abs(gap) <= 3 ? ("matched" as const) : ("differs" as const),
    ...(Math.abs(gap) <= 3 ? {} : { reason: "day" as const }),
    setup: Effect.gen(function* () {
      yield* bank(1, { day: 15 + gap });
      yield* payment(1, { day: 15 });
    }),
  })),
] as const;

it.effect.each(groups)("$label", (example) =>
  Effect.gen(function* () {
    yield* seed;
    yield* example.setup;
    const { lines, counts } = yield* checkMoneyIn(org, range, now);
    assert.lengthOf(lines, 1);
    assert.include(lines[0], {
      group: example.group,
      ...("reason" in example ? { difference: example.reason } : {}),
    });
    assert.strictEqual(counts[example.group], 1);
    if ("words" in example) assert.include(lines[0]?.text, example.words);
  }).pipe(Effect.provide(layer)),
);

it.effect("an exact pair Kin can't settle is a difference, never missing from either side", () =>
  Effect.gen(function* () {
    yield* seed;
    yield* statement(1, { through: 28 });
    yield* bank(1, { day: 20, minor: 5_000 });
    yield* bank(2, { day: 20, minor: 5_000 });
    yield* payment(1, { day: 20, minor: 5_000 });
    yield* bank(3, { day: 10 });
    yield* payment(2, { day: 9 });
    yield* payment(3, { day: 11 });
    const { lines, text } = yield* checkMoneyIn(org, range, now);
    assert.deepStrictEqual(
      lines.map((line) => [line.group, line.bank ?? line.payments[0]?.key]),
      [
        ["differs", "INV-2"],
        ["differs", "BNK-3"],
        ["differs", "INV-3"],
        ["differs", "BNK-1"],
        ["differs", "BNK-2"],
        ["differs", "INV-1"],
      ],
    );
    assert.notInclude(text, "has no credit like it");
    assert.notInclude(text, "Kin can't tell what it is");
    assert.include(
      text,
      "INV-1: ₹50.00 recorded as received 20 Nov from Juniper Cold Chain; BNK-1, BNK-2 at the bank are like it, and Kin can't tell which goes with which.",
    );
    assert.include(
      text,
      "BNK-3, ₹120.00 received 10 Nov, is like the payments recorded on INV-2, INV-3, and Kin can't tell which goes with which.",
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("an explained transfer counts, but is not a listed payment", () =>
  Effect.gen(function* () {
    yield* seed;
    yield* bank(1, { state: "done", category: "transfer" });
    const { lines, counts, text } = yield* checkMoneyIn(org, range, now);
    assert.deepStrictEqual(lines, []);
    assert.strictEqual(counts.matched, 1);
    assert.include(
      text,
      "1 more credit was explained by a person as transfer, interest, refund or other money.",
    );
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "code describes statement, alert-only, approval, empty, unread, mailbox, held and agent coverage separately",
  () =>
    Effect.gen(function* () {
      const sql = yield* seed;
      yield* seedFixtureAlertMailbox(org, "work-mail");
      yield* approveFixtureAlertSender(org, owner);
      yield* sql`UPDATE kin_bank_senders SET decided_at = ${ms(3)}, accounts_json = '["4821","7310","9119"]' WHERE org_id = ${org}`;
      yield* sql`INSERT INTO kin_bank_senders (org_id, address, bank_key, bank_name, state, created_at)
    VALUES (${org}, 'candidate@harborbank.example', 'harbor', 'Harbor Bank', 'candidate', 0),
      (${org}, 'removed@harborbank.example', 'harbor', 'Harbor Bank', 'removed', 0)`;
      yield* statement(1, { through: 28 });
      yield* bank(1, { day: 3, source: "alert", account: "7310" });
      yield* alert("duplicate", 28, "duplicate", "7310");
      yield* alert("unparsed", 10, "unparsed", null);
      yield* alert("unverified", 12, "unverified", null);
      yield* alert("held-1", 15, "held", null, null, "candidate@harborbank.example");
      yield* alert("held-2", 16, "held", null, null, "candidate@harborbank.example");
      yield* alert("held-3", 16, "held", null, null, "candidate@harborbank.example");
      yield* bank(2, { source: "manual" });
      yield* alert("removed", 11, "recorded", "4821", "bank-2", "removed@harborbank.example");
      yield* bank(3, { actor: "agent" });
      yield* bank(4, { state: "dropped" });
      yield* bank(5);
      yield* sql`INSERT INTO kin_record_changes (org_id, record_id, rev, at, actor_kind, via, kind, fields_json)
        VALUES (${org}, 'bank-5', 2, ${ms(12)}, 'agent', 'lead', 'updated', '{}')`;
      yield* sql`INSERT INTO kin_arrivals (org_id, arrival_id, connection_id, message_id, received_at,
      noticed_at, class, state, settled_at)
    VALUES (${org}, 'gap', 'work-mail', 'missing', ${ms(14)}, ${ms(15)}, 'gap', 'settled', ${ms(15)})`;
      const { lines, covered } = yield* checkMoneyIn(org, range, now);
      assert.deepStrictEqual(
        lines.map((line) => line.bank),
        ["BNK-1"],
      );
      assert.deepStrictEqual(covered, [
        "Harbor Bank ••4821: statement confirmed for 1 Nov to 28 Nov, so every credit on those days is checked.",
        "Harbor Bank ••7310: no statement for 1 Nov to 28 Nov. Alert mails from 3 Nov to 28 Nov are checked, and they show only what the bank mailed about.",
        "••9119: nothing from the bank for these days, so payments into it are not checked.",
        "Kin reads Harbor Bank's alerts only from 3 Nov, when they were approved; earlier days are not checked.",
        "2 alert mails from Harbor Bank sent between 10 Nov and 12 Nov could not be read; any money in them is not checked.",
        "Kin couldn't read the company mailbox between 14 Nov and 15 Nov; alerts sent then haven't been looked at.",
        "Kin is holding 3 mails from candidate@harborbank.example until you say whether it is Harbor Bank's alert address.",
        "2 Bank transactions entries that an agent wrote or changed are not counted as the bank's word.",
      ]);
      yield* alert("earlier-held-replay", 2, "duplicate", "7310");
      const replay = yield* checkMoneyIn(org, range, now);
      assert.include(replay.covered.join("\n"), "Alert mails from 2 Nov to 28 Nov are checked");
      assert.notInclude(replay.covered.join("\n"), "earlier days are not checked");
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "filters on the bank account and client without inventing the account of a hand-entered payment",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* statement();
      yield* bank(1, { account: "7310" });
      yield* payment(1, { origin: "bank-credit:bank-1:w:received" });
      yield* bank(2, { printed: "Tidewater Freight", minor: 6_000 });
      yield* payment(2, { client: "c4", minor: 6_000 });
      yield* payment(3, { minor: 4_000 });
      const account = yield* checkMoneyIn(org, { ...range, account: "4821" }, now);
      assert.notInclude(account.text, "INV-1");
      assert.include(
        account.text,
        "Kin does not know which account an unpaired payment went into.",
      );
      const client = yield* checkMoneyIn(org, { ...range, client: "C-3" }, now);
      assert.deepStrictEqual(
        client.lines.map(({ group, bank, payments }) => [group, bank, payments.map((p) => p.key)]),
        [
          ["matched", "BNK-1", ["INV-1"]],
          ["kinOnly", undefined, ["INV-3"]],
        ],
      );
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "uses the owner's month, pairs across its edge, and refuses future, reversed, long and unknown scopes",
  () =>
    Effect.gen(function* () {
      const sql = yield* seed;
      const profile = yield* newCompanyProfileJson;
      yield* sql`INSERT INTO kin_company_profile (org_id, profile_json, rev, updated_at, updated_by_kind, updated_by_id)
      VALUES (${org}, json_set(json_remove(${profile}, '$.countryPending'), '$.homeCurrency', 'USD', '$.country', 'US'),
        1, ${now}, 'person', ${owner})`;
      assert.strictEqual(yield* homeCurrency(org), "USD");
      yield* bank(1, { dateAt: Date.parse("2026-10-31T20:00:00Z"), currency: "USD" });
      yield* bank(2, { dateAt: Date.parse("2026-10-31T18:00:00Z"), minor: 9_000, currency: "USD" });
      yield* payment(1, { day: 1, minor: 9_000, currency: "USD" });
      const result = yield* checkMoneyIn(org, range, now);
      assert.strictEqual(result.counts.matched, 1);
      assert.strictEqual(result.counts.bankOnly, 1);
      assert.include(result.text, "BNK-1, $120.00 received 1 Nov");
      assert.include(result.text, "BNK-2, $90.00 received 31 Oct");
      for (const [input, message] of [
        [
          { from: "2026-11-29", through: "2026-11-28" },
          "from must be on or before through, and through no later than today.",
        ],
        [
          { ...range, through: "2026-11-29" },
          "from must be on or before through, and through no later than today.",
        ],
        [{ ...range, from: "2024-11-01" }, "Check at most a year at a time."],
        [
          { ...range, account: "9999" },
          "No bank account ending 9999 in Bank transactions or the confirmed statements.",
        ],
        [{ ...range, client: "C-999" }, 'No client "C-999": give the client\'s key, like C-3.'],
        [{ ...range, client: "Juniper" }, 'No client "Juniper": give the client\'s key, like C-3.'],
      ] as const)
        assert.strictEqual((yield* Effect.flip(checkMoneyIn(org, input, now))).message, message);
      // A name, not a key, still reaches the refusal that says what to pass.
      assert.isTrue(isCheckInput({ ...range, client: "Juniper" }));
    }).pipe(Effect.provide(layer)),
);

const turn = Effect.fn("MoneyInCheck.testTurn")(function* (
  asker: string,
  audience: "owner_only" | "shared",
  n: number,
  key = false,
) {
  const sql = yield* SqlClient.SqlClient;
  if (n === 1) {
    yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
      VALUES (${agent}, ${org}, 'Finance', 'lead', ${owner}, ${at})`;
    yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
      VALUES ('finance-chat', ${org}, 'direct', 'owner:finance', 0, ${at})`;
    yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, thread_id, models_json,
        worker_projects_json, owner_chat_id)
      VALUES (${agent}, ${org}, 'Finance', 0, ${thread}, '{}', '[]', 'finance-chat')`;
    yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
      VALUES ('rhea-member', ${org}, 'finance-chat', 'person', ${owner}, 'owner', ${at}),
        ('meera-member', ${org}, 'finance-chat', 'person', 'meera', 'member', ${at})`;
  }
  if (audience === "shared" || asker === "zoya")
    yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
      VALUES ('zoya-member', ${org}, 'finance-chat', 'person', 'zoya', 'member', ${at})`;
  yield* sql`UPDATE kin_wakeups SET status = 'completed'`;
  const message = `msg-${n}`;
  const event = `event-${n}`;
  const wake = `wake-${n}`;
  yield* sql`UPDATE kin_chats SET last_seq = last_seq + 1 WHERE chat_id = 'finance-chat'`;
  yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind, author_person_id,
      author_member_id, author_role, kind, body, mentions_json, status, created_at, client_message_id)
    SELECT ${message}, ${org}, 'finance-chat', last_seq, 'human', ${asker}, ${asker + "-member"},
      ${asker === owner ? "owner" : "member"}, 'text', 'Does the money match the bank?', '[]', 'posted', ${at},
      ${key ? `send:key:${message}` : null} FROM kin_chats WHERE chat_id = 'finance-chat'`;
  yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, model, started_at, status, event_ids, audience)
    VALUES (${wake}, ${org}, ${agent}, ${thread}, 'fixture', ${now}, 'running', ${JSON.stringify([event])}, ${audience})`;
  yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json, received_at, queued_at, state, wakeup_id)
    VALUES (${event}, ${org}, ${agent}, 'chat.message', 'P0', ${JSON.stringify({
      _tag: "chat.message",
      orgId: org,
      agentId: agent,
      eventId: event,
      receivedAt: at,
      provenance: { _tag: "human", personId: asker, memberId: asker + "-member" },
      chatId: "finance-chat",
      messageId: message,
      dedupeKey: null,
    })}, 0, 0, 'claimed', ${wake})`;
});

it.effect(
  "posts one owner-audience card; narration stays off its text and answer; asks again against the prior range",
  () =>
    Effect.gen(function* () {
      const sql = yield* seed;
      yield* turn(owner, "owner_only", 1);
      yield* bank(1, { printed: `Juniper Cold Chain ${marker}` });
      yield* TestClock.setTime(ms(21));
      const first = yield* moneyInCheck(scope, { ...range, through: on(21) });
      assert.strictEqual(first.counts.bankOnly, 1);
      const widgets = sql<{
        widgetId: string;
        state: string;
        author: string;
        closedAt: string | null;
      }>`SELECT
    w.widget_id AS widgetId, w.state_json AS state, m.author_kind AS author, w.closed_at AS closedAt
    FROM kin_widgets w JOIN kin_messages m ON m.org_id = w.org_id AND m.message_id = w.message_id WHERE w.type = 'money_in_check' ORDER BY m.seq`;
      const [one] = yield* widgets;
      assert.strictEqual(one?.widgetId, first.card);
      assert.strictEqual(one?.author, "system");
      const firstState = JSON.parse(one!.state);
      assert.notInclude(JSON.stringify(first), marker);
      assert.notInclude(JSON.stringify(first), "₹");
      assert.notInclude(JSON.stringify(first), "Juniper Cold Chain");
      assert.notInclude(firstState.text, marker);
      assert.include(firstState.lines[0].printed, marker);
      yield* turn("meera", "owner_only", 2);
      yield* TestClock.setTime(now);
      yield* payment(1);
      yield* bank(2, { day: 27, minor: 15_000 });
      yield* payment(2, { day: 27, minor: 15_000 });
      const next = yield* moneyInCheck(scope, range);
      assert.strictEqual(next.counts.matched, 2);
      const rows = yield* widgets;
      assert.lengthOf(rows, 2);
      assert.isNotNull(rows[0]!.closedAt);
      assert.include(JSON.parse(rows[0]!.state).text, "A newer check is below.");
      assert.match(
        JSON.parse(rows[1]!.state).text,
        /^Since the check on 21 Nov: 2 new matches, 1 fixed\./,
      );
      const same = yield* moneyInCheck(scope, range);
      assert.notStrictEqual(same.card, next.card);
      assert.match(
        JSON.parse((yield* widgets)[2]!.state).text,
        /^Nothing changed since the check on 28 Nov\./,
      );
    }).pipe(Effect.provide(layer)),
);

it.effect.each([
  ["zoya", "owner_only", false],
  [owner, "shared", false],
  [owner, "owner_only", true],
] as const)("refuses %s in %s (key: %s)", ([asker, audience, key]) =>
  Effect.gen(function* () {
    const sql = yield* seed;
    yield* turn(asker, audience, 1, key);
    const failure = yield* Effect.flip(moneyInCheck(scope, range));
    assert.strictEqual(
      failure.message,
      "Only the owner or a co-owner can check money received against the bank, in their own chat with you.",
    );
    assert.isEmpty(yield* sql`SELECT 1 FROM kin_widgets`);
  }).pipe(Effect.provide(layer)),
);

it.effect("with no Bank transactions list yet, still posts the card with the way to start", () =>
  Effect.gen(function* () {
    const sql = yield* seed;
    yield* turn(owner, "owner_only", 1);
    yield* moneyInCheck(scope, range);
    const [widget] = yield* sql<{ state: string }>`SELECT state_json AS state FROM kin_widgets`;
    assert.include(
      JSON.parse(widget!.state).text,
      "Kin has no bank lines yet: approve a bank's alert address in Settings → Connections, or add a statement here.",
    );
    assert.isEmpty(yield* sql`SELECT 1 FROM kin_registers WHERE register_id = 'bank_transactions'`);
  }).pipe(Effect.provide(layer)),
);
