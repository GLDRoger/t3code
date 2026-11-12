// Loaded first: the chat and trigger modules import each other.
import "../../chat/KinChatService.ts";
// @effect-diagnostics nodeBuiltinImport:off -- fixtures are committed files copied into the test's attachments directory.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  KinAgentId,
  KinChatError,
  KinOrgId,
  KinPersonId,
  KIN_STATEMENT_CARD_ROWS,
  KinStatementReviewCard,
  type KinStatementSelectChange,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../../config.ts";
import type { McpInvocationScope } from "../../../mcp/McpInvocationContext.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as KinChatHub from "../../chat/KinChatHub.ts";
import * as KinChatRepository from "../../chat/KinChatRepository.ts";
import { KinIdentity } from "../../chat/KinIdentity.ts";
import * as KinEventQueue from "../../lead/KinEventQueue.ts";
import { sharedToolAllowed } from "../../lead/SharedTools.ts";
import * as KinPersistence from "../../persistence/KinPersistence.ts";
import * as KinRecords from "../KinRecords.ts";
import * as LeadStatements from "../leadStatements.ts";
import { moneySummary } from "../moneyViews.ts";
import * as OwnerStatements from "../ownerStatements.ts";
import { defineList, PRESETS } from "../registers.ts";
import { readStatementFile } from "./statementFiles.ts";

// An invented company, Lakeview Studio, with invented clients, invoices and statements.
const orgId = KinOrgId.make("org");
const ownerId = KinPersonId.make("owner");
const lead = KinAgentId.make("lead");
const at = "2026-11-11T00:00:00.000Z";
const NOW = Date.parse("2026-11-12T06:00:00.000Z");
const PASSWORD = "lake4821";
const people = [{ _tag: "person" as const, orgId, personId: ownerId }];
const owner = {
  actor: { _tag: "person" as const, personId: ownerId },
  via: "owner" as const,
  askedBy: ownerId,
};

const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("fixture"),
  requestNamespace: "fixture",
  issuedAt: 0,
  capabilities: new Set(),
  client: undefined,
  thread: {
    threadId: ThreadId.make("lead-thread"),
    providerSessionId: "fixture",
    providerInstanceId: ProviderInstanceId.make("claude"),
  },
};
const identity = Layer.mock(KinIdentity)({
  owner: { _tag: "person" as const, orgId, personId: ownerId },
  isAgentThread: () => true,
  isLeadThread: () => true,
  resolveAgent: () =>
    Effect.succeed({
      _tag: "agent" as const,
      orgId,
      agentId: lead,
      ownerPersonId: ownerId,
      threadId: ThreadId.make("lead-thread"),
    }),
});
const logged: Array<string> = [];
const logger = Logger.make(({ message, cause }) => {
  logged.push(JSON.stringify(message), String(cause));
});
const layer = Layer.mergeAll(KinRecords.layer, identity, KinChatHub.layer).pipe(
  Layer.provideMerge(KinChatRepository.layer),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(KinEventQueue.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-statements-" })),
  Layer.provideMerge(KinPersistence.layer),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(
    Layer.succeed(
      SecureRandom.SecureRandom,
      SecureRandom.make((size) => new Uint8Array(size).fill(7)),
    ),
  ),
  Layer.provideMerge(Logger.layer([logger])),
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
);

const fixture = (name: string) =>
  NodeFS.readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
let files = 0;
/** A file the owner sends, kept in the attachments directory as Kin keeps one. */
const keep = (bytes: Uint8Array, extension: string) =>
  Effect.gen(function* () {
    const { attachmentsDir } = yield* ServerConfig.ServerConfig;
    files += 1;
    const id = `kin-00000000-0000-4000-8000-${String(files).padStart(12, "0")}-${extension}`;
    NodeFS.mkdirSync(attachmentsDir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(attachmentsDir, `${id}.${extension}`), bytes);
    return id;
  });

/** A turn the owner woke with a message carrying `file`; the turn before it ends. */
const turn = (
  n: number,
  file?: { readonly id: string; readonly name: string },
  audience = "owner_only",
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const attachments =
      file === undefined
        ? []
        : [
            {
              type: "file",
              id: file.id,
              name: file.name,
              mimeType: "application/pdf",
              sizeBytes: 1000,
            },
          ];
    yield* sql`UPDATE kin_wakeups SET status = 'completed' WHERE status = 'running'`;
    const [chat] = yield* sql<{
      seq: number;
    }>`SELECT last_seq + 1 AS seq FROM kin_chats WHERE chat_id = 'lead-chat'`;
    const seq = chat!.seq;
    yield* sql`UPDATE kin_chats SET last_seq = ${seq} WHERE chat_id = 'lead-chat'`;
    yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind,
        author_person_id, author_member_id, author_role, kind, body, mentions_json, status,
        created_at, attachments_json)
      VALUES (${`msg-${n}`}, ${orgId}, 'lead-chat', ${seq}, 'human', ${ownerId}, 'lead-chat-owner',
        'owner', 'text', 'Here is the statement', '[]', 'posted', ${at}, ${JSON.stringify(attachments)})`;
    yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, model, started_at,
        status, event_ids, audience)
      VALUES (${`wake-${n}`}, ${orgId}, ${lead}, 'lead-thread', 'test', 0, 'running',
        ${JSON.stringify([`event-${n}`])}, ${audience})`;
    const event = {
      _tag: "chat.message",
      orgId,
      agentId: lead,
      eventId: `event-${n}`,
      receivedAt: at,
      dedupeKey: null,
      provenance: { _tag: "human", personId: ownerId, memberId: "lead-chat-owner" },
      chatId: "lead-chat",
      messageId: `msg-${n}`,
    };
    yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json,
        received_at, queued_at, state, wakeup_id)
      VALUES (${`event-${n}`}, ${orgId}, ${lead}, 'chat.message', 'P0', ${JSON.stringify(event)},
        0, 0, 'claimed', ${`wake-${n}`})`;
    return `event-${n}`;
  });

/** The owner, one lead and its chat, the Invoices and Expenses lists, two clients and their invoices. */
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const records = yield* KinRecords.KinRecords;
  yield* TestClock.setTime(NOW);
  yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Lakeview Studio', ${at})`;
  yield* sql`INSERT INTO kin_trigger_settings (org_id, time_zone, morning_brief, evening_summary,
      dream, full_rebuild_weekday, owner_check_weekday, owner_check, quiet_hours_json)
    VALUES (${orgId}, 'Asia/Kolkata', '08:00', '18:00', '02:00', 0, 1, '09:00', '[]')`;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
    VALUES (${ownerId}, ${orgId}, 'owner', 'Owner', ${at})`;
  yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at, retired_at)
    VALUES (${lead}, ${orgId}, 'Chief of staff', 'lead', ${ownerId}, ${at}, NULL)`;
  yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
    VALUES ('lead-chat', ${orgId}, 'direct', 'owner:lead', 0, ${at})`;
  yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
    VALUES ('lead-chat-owner', ${orgId}, 'lead-chat', 'person', ${ownerId}, 'owner', ${at})`;
  yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, agent_id, role, joined_at)
    VALUES ('lead-chat-lead', ${orgId}, 'lead-chat', 'agent', ${lead}, 'member', ${at})`;
  yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, thread_id, models_json,
      worker_projects_json, owner_chat_id)
    VALUES (${lead}, ${orgId}, 'Chief of staff', 0, 'lead-thread', '{}', '[]', 'lead-chat')`;
  for (const id of ["invoices", "expenses"] as const)
    yield* defineList(orgId, { _tag: "new", id, ...PRESETS[id], definition: PRESETS[id] }, NOW);
  const client = (title: string) =>
    records
      .create(orgId, owner, {
        list: "clients",
        originKey: `client:${title}`,
        title,
        owner: { _tag: "person", personId: ownerId },
        category: "client",
      })
      .pipe(Effect.map(({ row }) => row.recordId));
  const brightline = yield* client("Brightline Media LLP");
  const northwind = yield* client("Northwind Retail Pvt Ltd");
  const day = (iso: string) => Date.parse(`${iso}T18:29:59.999Z`);
  const invoice = (key: string, partyId: string, minor: number) =>
    records.create(orgId, owner, {
      list: "invoices",
      originKey: `invoice:${key}`,
      title: `${key} retainer`,
      owner: { _tag: "person", personId: ownerId },
      state: "waiting",
      partyId,
      amount: { minor, currency: "INR" },
      dateAt: day("2026-09-30"),
      dateAllDay: true,
    });
  const exact = yield* invoice("September", brightline, 11_800_000);
  const tds = yield* invoice("Store design", northwind, 10_000_000);
  const aws = yield* records.create(orgId, owner, {
    list: "expenses",
    originKey: "expense:aws",
    title: "AWS hosting",
    owner: { _tag: "person", personId: ownerId },
    state: "open",
    amount: { minor: 413_000, currency: "INR" },
    dateAt: day("2026-10-03"),
    dateAllDay: true,
    fields: { vendor: "Amazon Web Services" },
  });
  return { exact: exact.row.key, tds: tds.row.key, aws: aws.row.key };
});

const read = (n: number, name: string, bytes: Uint8Array = fixture(name)) =>
  Effect.gen(function* () {
    const id = yield* keep(bytes, name.split(".").at(-1)!);
    const event = yield* turn(n, { id, name });
    return yield* LeadStatements.read(scope, { sourceEventId: event, attachment: name });
  });
/** A read that opened, with its figures. */
const opened = <A extends { readonly status: string }>(result: A) => {
  assert.oneOf(result.status, ["read", "applied"]);
  return result as Extract<A, { readonly rows: number }>;
};
const decodeCard = Schema.decodeUnknownSync(KinStatementReviewCard);
const isChatError = Schema.is(KinChatError);
const reviewCardOf = (statementId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{
      state: string;
      awaiting: string;
      type: string;
    }>`SELECT w.state_json AS state,
        w.awaiting_json AS awaiting, w.type FROM kin_widgets w JOIN kin_bank_statements s
        ON s.org_id = w.org_id AND s.review_widget_id = w.widget_id
      WHERE s.statement_id = ${statementId}`;
    return { ...row!, card: decodeCard(JSON.parse(row!.state)) };
  });
/** The owner's changes on a card, one tap each; the card as the server keeps it after them. */
const choose = (card: KinStatementReviewCard, changes: ReadonlyArray<KinStatementSelectChange>) =>
  Effect.gen(function* () {
    let latest = card;
    for (const change of changes)
      latest = (yield* OwnerStatements.select(people, {
        orgId,
        statementId: card.statementId,
        hash: card.hash,
        change,
      })).card;
    return latest;
  });
const confirmOf = (card: KinStatementReviewCard) => ({
  orgId,
  statementId: card.statementId,
  hash: card.hash,
  revision: card.selection!.revision,
});
/** The owner's confirm with everything the card proposes: matches ticked, first picks, suggestions taken. */
const confirmAll = (card: KinStatementReviewCard) =>
  choose(card, [
    { _tag: "tickAll", ticked: true },
    ...card.choose.map((one) => ({ _tag: "pick" as const, row: one.row, option: 0 })),
    { _tag: "suggestions" },
  ]).pipe(Effect.map(confirmOf));
const bankRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ state: string; registerId: string }>`SELECT state, register_id AS "registerId"
    FROM kin_records WHERE org_id = ${orgId} AND register_id IN
      (SELECT register_id FROM kin_registers WHERE lower(name) = 'bank transactions')
    ORDER BY key`;
});

describe("bank statements", () => {
  it.effect(
    "reads a statement in the owner's turn, marks it sensitive and posts one review card",
    () =>
      Effect.gen(function* () {
        const keys = yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const result = opened(yield* read(1, "hdfc-account.pdf"));
        assert.strictEqual(result.status, "read");
        assert.strictEqual(result.account, "HDFC Bank ••4821");
        assert.strictEqual(result.rows, 20);
        assert.include(result.balance, "It adds up");
        assert.deepStrictEqual(result.matched.map((one) => one.to).toSorted(), [
          keys.aws,
          keys.exact,
          `${keys.tds} (paid with ₹10,000.00 TDS deducted)`,
        ]);
        assert.lengthOf(
          yield* sql`SELECT 1 FROM kin_wakeup_sensitive_reads WHERE wakeup_id = 'wake-1'`,
          1,
        );
        const { card, awaiting, type } = yield* reviewCardOf(result.statement);
        assert.strictEqual(type, "statement_review");
        assert.deepStrictEqual(JSON.parse(awaiting), [ownerId]);
        assert.strictEqual(card.balance, "adds_up");
        assert.include(card.title, "HDFC Bank ••4821");
        // A second read of the same file is the same review, not a second card.
        const again = yield* LeadStatements.read(scope, {
          sourceEventId: "event-1",
          attachment: "hdfc-account.pdf",
        });
        assert.strictEqual(again.statement, result.statement);
        assert.lengthOf(yield* sql`SELECT 1 FROM kin_widgets WHERE type = 'statement_review'`, 1);
        // Every word the bank wrote reaches the lead quoted as untrusted, references masked.
        assert.isTrue(
          [...result.matched, ...result.unmatched].every((one) =>
            one.text.startsWith("> BEGIN QUOTE: bank statement text (untrusted)"),
          ),
        );
        const listed = yield* LeadStatements.rows(scope, { statement: result.statement });
        const referenced = listed.rows.find((one) => one.reference !== undefined)!;
        assert.include(referenced.description, "(untrusted)");
        assert.match(referenced.reference!, /"••\w{4}"/);
        const detail = yield* LeadStatements.rows(scope, {
          statement: result.statement,
          row: referenced.row,
        });
        assert.lengthOf(detail.rows, 1);
        assert.notMatch(detail.rows[0]!.reference!, /••/);
        // Nothing is recorded by reading.
        assert.lengthOf(yield* bankRows, 0);
        assert.lengthOf(yield* sql`SELECT 1 FROM kin_record_payments`, 0);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("is refused in a turn others read", () =>
    Effect.gen(function* () {
      yield* seed;
      const id = yield* keep(fixture("hdfc-account.pdf"), "pdf");
      const event = yield* turn(1, { id, name: "hdfc-account.pdf" }, "shared");
      const refused = yield* LeadStatements.read(scope, {
        sourceEventId: event,
        attachment: id,
      }).pipe(Effect.flip);
      if (!isChatError(refused)) return assert.fail(String(refused));
      assert.strictEqual(refused.reason, "not_allowed");
      for (const tool of ["statement_read", "statement_rows"])
        assert.isFalse(
          yield* sharedToolAllowed({ orgId, agentId: lead, wakeupId: "wake-1" }, tool, {}),
        );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("applies exactly the set the card showed, once, and Money sees it", () =>
    Effect.gen(function* () {
      const keys = yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const records = yield* KinRecords.KinRecords;
      const result = yield* read(1, "hdfc-account.pdf");
      const { card } = yield* reviewCardOf(result.statement);
      const all = yield* confirmAll(card);
      // A card made before something changed, or a selection the owner hasn't seen, applies nothing.
      for (const wrong of [
        { ...all, hash: "0".repeat(32) },
        { ...all, revision: all.revision - 1 },
      ]) {
        const refused = yield* OwnerStatements.apply(people, wrong).pipe(Effect.flip);
        assert.strictEqual(refused.reason, "conflict");
      }
      // A change to a row the card doesn't show that way is refused.
      for (const change of [
        { _tag: "tick", row: card.unmatched[0]!.row, ticked: true },
        { _tag: "pick", row: card.matched[0]!.row, option: 1 },
      ] as const) {
        const refused = yield* choose(card, [change]).pipe(Effect.flip);
        assert.strictEqual(refused.reason, "invalid_state");
      }
      assert.lengthOf(yield* sql`SELECT 1 FROM kin_record_payments`, 0);
      assert.lengthOf(yield* bankRows, 0);

      // The owner unticks nothing but leaves the tea for later.
      const tea = card.unmatched
        .filter((one) => one.text.startsWith("UPI-CHAI POINT"))
        .map((one) => one.row);
      const later = yield* choose(
        (yield* reviewCardOf(result.statement)).card,
        tea.map((row) => ({ _tag: "action" as const, row, action: "later" as const })),
      );
      const applied = yield* OwnerStatements.apply(people, confirmOf(later));
      assert.strictEqual(applied.card.status, "applied");
      assert.include(
        applied.card.result!.join(" "),
        "Recorded 2 payments on invoices, 1 with TDS deducted.",
      );
      const exact = (yield* records.get(orgId, keys.exact))!;
      const tds = (yield* records.get(orgId, keys.tds))!;
      const aws = (yield* records.get(orgId, keys.aws))!;
      assert.deepStrictEqual([exact.state, exact.paid], ["done", 11_800_000]);
      // The client deducted TDS: ₹90,000 received and ₹10,000 TDS, each its own payment line.
      assert.deepStrictEqual([tds.state, tds.paid], ["done", 10_000_000]);
      assert.deepStrictEqual(
        (yield* sql<{
          minor: number;
          note: string;
        }>`SELECT amount_minor AS minor, note FROM kin_record_payments
          WHERE record_id = ${tds.recordId} ORDER BY amount_minor`).map((one) => [
          one.minor,
          one.note.slice(0, 12),
        ]),
        [
          [1_000_000, "TDS deducted"],
          [9_000_000, "HDFC Bank ••"],
        ],
      );
      assert.strictEqual(aws.state, "done");
      // Each settled entry links its bank row, and its history shows the change.
      const detail = yield* records.detail(exact);
      assert.isTrue(
        detail.links.some((link) => link.kind === "record" && link.relation === "evidence"),
      );
      assert.isTrue(
        detail.changes.some((change) => change.fields.some((field) => field.field === "payment")),
      );
      const rows = yield* bankRows;
      assert.lengthOf(rows, 20);
      assert.deepStrictEqual(
        applied.card.unexplained,
        rows.filter((row) => row.state === "open").length,
      );
      assert.isAbove(applied.card.unexplained!, 1);
      // Money sees both invoices paid, and spend is the expenses alone: bank rows are neither.
      const summary = yield* moneySummary(orgId, Date.parse("2026-10-31T12:00:00.000Z"));
      const [spent] = yield* sql<{
        total: number;
      }>`SELECT SUM(amount_minor) AS total FROM kin_records
        WHERE register_id = 'expenses' AND state = 'done'`;
      assert.deepStrictEqual(summary.owed.total, []);
      // Received is what came into the bank; the ₹10,000 TDS settled an invoice but is its own figure.
      assert.deepStrictEqual(summary.received.thisMonth, [{ minor: 20_800_000, currency: "INR" }]);
      assert.deepStrictEqual(summary.tdsDeducted?.thisMonth, [
        { minor: 1_000_000, currency: "INR" },
      ]);
      const settled = yield* records.detail(tds);
      assert.deepStrictEqual(
        [settled.amount, settled.received, settled.tdsDeducted, settled.balance].map(
          (money) => money?.minor,
        ),
        [10_000_000, 9_000_000, 1_000_000, 0],
      );
      assert.deepStrictEqual(summary.spent.thisMonth.total, [
        { minor: spent!.total, currency: "INR" },
      ]);
      // A confirm is single use.
      const twice = yield* OwnerStatements.apply(people, confirmOf(later)).pipe(Effect.flip);
      assert.strictEqual(twice.reason, "widget_changed");
      assert.lengthOf(yield* bankRows, 20);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("undoes one statement's matches, and the same card applies again", () =>
    Effect.gen(function* () {
      const keys = yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const records = yield* KinRecords.KinRecords;
      const result = yield* read(1, "hdfc-account.pdf");
      const { card } = yield* reviewCardOf(result.statement);
      yield* OwnerStatements.apply(people, yield* confirmAll(card));
      const created = yield* sql<{ key: string }>`SELECT key FROM kin_records
        WHERE register_id = 'expenses' AND origin_key LIKE 'statement:%' ORDER BY key`;
      assert.isAbove(created.length, 0);
      const undone = yield* OwnerStatements.undo(people, { orgId, statementId: result.statement });
      assert.strictEqual(undone.card.status, "undone");
      assert.deepStrictEqual((yield* records.get(orgId, keys.exact))!.state, "waiting");
      assert.deepStrictEqual((yield* records.get(orgId, keys.tds))!.paid, 0);
      assert.deepStrictEqual((yield* records.get(orgId, keys.aws))!.state, "open");
      for (const one of created)
        assert.strictEqual((yield* records.get(orgId, one.key))!.state, "dropped");
      assert.isTrue((yield* bankRows).every((row) => row.state === "open"));
      assert.lengthOf(yield* sql`SELECT 1 FROM kin_record_links WHERE kind = 'record'`, 0);
      const refused = yield* OwnerStatements.undo(people, {
        orgId,
        statementId: result.statement,
      }).pipe(Effect.flip);
      assert.strictEqual(refused.reason, "invalid_state");
      const again = yield* OwnerStatements.apply(people, yield* confirmAll(card));
      assert.strictEqual(again.card.status, "applied");
      assert.strictEqual((yield* records.get(orgId, keys.exact))!.state, "done");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("adds nothing twice: the same statement sent again, then an overlapping one", () =>
    Effect.gen(function* () {
      yield* seed;
      const first = yield* read(1, "hdfc-account.pdf");
      yield* OwnerStatements.apply(
        people,
        yield* confirmAll((yield* reviewCardOf(first.statement)).card),
      );
      const explained = (yield* bankRows).filter((row) => row.state !== "open").length;
      const second = opened(yield* read(2, "hdfc-account.pdf"));
      assert.notStrictEqual(second.statement, first.statement);
      assert.strictEqual(second.counts.recorded, explained);
      yield* OwnerStatements.apply(
        people,
        yield* confirmAll((yield* reviewCardOf(second.statement)).card),
      );
      assert.lengthOf(yield* bankRows, 20);
      // November's export repeats October's last four rows and adds two of its own.
      const october = yield* Effect.promise(() => readStatementFile(fixture("hdfc-account.pdf")));
      assert.strictEqual(october._tag, "read");
      const tail = october._tag === "read" ? october.statement.rows.slice(-4) : [];
      const money = (minor: number) => (minor / 100).toFixed(2);
      const csv = [
        "Account No :50100000004821",
        "Date,Narration,Chq/Ref Number,Debit Amount,Credit Amount",
        ...tail.map((row) =>
          [
            row.date.split("-").reverse().join("/"),
            `"${row.description}"`,
            row.reference ?? "",
            row.direction === "debit" ? money(row.amountMinor) : "",
            row.direction === "credit" ? money(row.amountMinor) : "",
          ].join(","),
        ),
        '02/11/2026,"UPI-NEW VENDOR-new@invbank",0000700000000001,999.00,',
        '03/11/2026,"NEFT CR-SOMEONE NEW",N300000000000001,,500.00',
      ].join("\n");
      const third = opened(yield* read(3, "november.csv", new TextEncoder().encode(csv)));
      assert.strictEqual(third.rows, 6);
      yield* OwnerStatements.apply(
        people,
        yield* confirmAll((yield* reviewCardOf(third.statement)).card),
      );
      assert.lengthOf(yield* bankRows, 22);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("adopts an existing Bank transactions list and knows its imported rows", () =>
    Effect.gen(function* () {
      yield* seed;
      const records = yield* KinRecords.KinRecords;
      const sql = yield* SqlClient.SqlClient;
      // As an import made it: its own fields and rows, no balance field and no Kin keys.
      yield* defineList(
        orgId,
        {
          _tag: "new",
          id: "bank_txns",
          name: "Bank Transactions",
          prefix: "BT",
          definition: {
            noun: "transaction",
            states: ["open", "done", "dropped"],
            stateLabels: {},
            defaultState: "done",
            categories: [],
            fields: [
              {
                key: "direction",
                label: "Direction",
                type: "choice",
                choices: ["Debit", "Credit"],
                sensitive: false,
              },
              { key: "reference", label: "Reference", type: "text", sensitive: false },
              { key: "account", label: "Account", type: "text", sensitive: false },
            ],
            sensitive: true,
            amount: true,
            currency: "INR",
          },
        },
        NOW,
      );
      const october = yield* Effect.promise(() => readStatementFile(fixture("hdfc-account.pdf")));
      const rows = october._tag === "read" ? october.statement.rows.slice(0, 3) : [];
      for (const [index, row] of rows.entries())
        yield* records.create(
          orgId,
          { actor: { _tag: "system" }, via: "import" },
          {
            list: "bank_txns",
            originKey: `import:old:entry:b${index}`,
            title: row.description.slice(0, 40),
            owner: { _tag: "person", personId: ownerId },
            state: "done",
            amount: { minor: row.amountMinor, currency: "INR" },
            dateAt: Date.parse(`${row.date}T18:29:59.999Z`),
            dateAllDay: true,
            fields: {
              direction: row.direction === "debit" ? "Debit" : "Credit",
              ...(row.reference === null ? {} : { reference: row.reference }),
              account: "HDFC XX4821",
            },
          },
        );
      const result = opened(yield* read(1, "hdfc-account.pdf"));
      assert.strictEqual(result.counts.recorded, 3);
      yield* OwnerStatements.apply(
        people,
        yield* confirmAll((yield* reviewCardOf(result.statement)).card),
      );
      const lists = yield* sql<{
        id: string;
        json: string;
      }>`SELECT register_id AS id, definition_json AS json
        FROM kin_registers WHERE lower(name) = 'bank transactions'`;
      assert.deepStrictEqual(
        lists.map((one) => one.id),
        ["bank_txns"],
      );
      assert.include(lists[0]!.json, '"balance"');
      assert.lengthOf(yield* bankRows, 20);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "asks for a locked PDF's password on a card, and the password is stored nowhere else",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        logged.length = 0;
        const locked = yield* read(1, "hdfc-account-locked.pdf");
        assert.strictEqual(locked.status, "needs_password");
        const [card] = yield* sql<{ state: string }>`SELECT state_json AS state FROM kin_widgets
        WHERE type = 'statement_password'`;
        assert.include(card!.state, '"status":"locked"');
        const unlock = (password: string, remember: boolean) =>
          OwnerStatements.unlock(people, {
            orgId,
            statementId: locked.statement,
            password: Redacted.make(password),
            remember,
          });
        assert.deepStrictEqual(yield* unlock("lake0000", false), { status: "wrong" });
        assert.deepStrictEqual(yield* unlock(PASSWORD, true), { status: "opened" });
        const keptAccounts = yield* OwnerStatements.passwords(people, { orgId });
        assert.deepStrictEqual(
          keptAccounts.accounts.map((one) => one.label),
          ["HDFC Bank ••4821"],
        );
        assert.notInclude(JSON.stringify(keptAccounts), PASSWORD);
        const { card: review } = yield* reviewCardOf(locked.statement);
        assert.strictEqual(review.matched.length, 3);
        // The next locked statement of the account opens with the kept password, untyped.
        const next = yield* read(2, "hdfc-account-locked.pdf");
        assert.strictEqual(next.status, "read");
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const { secretsDir } = yield* ServerConfig.ServerConfig;
        const kept = NodeFS.readdirSync(secretsDir).filter((name) =>
          name.startsWith("kin-statement-"),
        );
        assert.lengthOf(kept, 1);
        // Only the secret store holds it: no row of any table, no tool result and no log line.
        const tables = yield* sql<{
          name: string;
        }>`SELECT name FROM sqlite_master WHERE type = 'table'
        ORDER BY name`;
        for (const { name } of tables) {
          const rows = yield* sql.unsafe(`SELECT * FROM "${name}"`);
          assert.notInclude(JSON.stringify(rows), PASSWORD, name);
        }
        assert.notInclude(JSON.stringify([locked, next]), PASSWORD);
        assert.notInclude(logged.join("\n"), PASSWORD);
        // The owner can take it back, from its card or the list of kept accounts.
        yield* OwnerStatements.forgetPassword(people, { orgId, statementId: locked.statement });
        yield* OwnerStatements.unlock(people, {
          orgId,
          statementId: next.statement,
          password: Redacted.make(PASSWORD),
          remember: true,
        }).pipe(Effect.ignore);
        yield* sql`UPDATE kin_bank_statements SET status = 'needs_password'
          WHERE statement_id = ${next.statement}`;
        yield* OwnerStatements.unlock(people, {
          orgId,
          statementId: next.statement,
          password: Redacted.make(PASSWORD),
          remember: true,
        });
        const listed = yield* OwnerStatements.passwords(people, { orgId });
        assert.lengthOf(listed.accounts, 1);
        assert.deepStrictEqual(
          yield* OwnerStatements.forgetAccount(people, {
            orgId,
            account: listed.accounts[0]!.account,
          }),
          { accounts: [] },
        );
        assert.isTrue(Option.isNone(yield* secrets.get(kept[0]!.replace(/\.bin$/, ""))));
        assert.lengthOf(
          NodeFS.readdirSync(secretsDir).filter((name) => name.startsWith("kin-statement-")),
          0,
        );
        const third = yield* read(3, "hdfc-account-locked.pdf");
        assert.strictEqual(third.status, "needs_password");
        // Five wrong passwords and the card stops trying, the right one included.
        const tries = [];
        for (let n = 0; n < 6; n += 1)
          tries.push(
            (yield* OwnerStatements.unlock(people, {
              orgId,
              statementId: third.statement,
              password: Redacted.make(n === 5 ? PASSWORD : `lake000${n}`),
              remember: false,
            })).status,
          );
        assert.deepStrictEqual(tries, ["wrong", "wrong", "wrong", "wrong", "limit", "limit"]);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("says a scan has no text, then takes the rows the agent read for the same card", () =>
    Effect.gen(function* () {
      yield* seed;
      const scanned = yield* read(1, "scanned.pdf");
      assert.strictEqual(scanned.status, "scanned");
      const proposed = opened(
        yield* LeadStatements.read(scope, {
          sourceEventId: "event-1",
          attachment: "scanned.pdf",
          bank: "HDFC Bank",
          account: "4821",
          opening: "2,50,000.00",
          closing: "3,68,000.00",
          rows: [
            {
              date: "2026-10-02",
              description: "NEFT CR-BRIGHTLINE MEDIA LLP",
              amount: "1,18,000.00",
              direction: "credit",
            },
          ],
        }),
      );
      assert.strictEqual(proposed.status, "read");
      assert.include(proposed.balance, "It adds up");
      const { card } = yield* reviewCardOf(proposed.statement);
      assert.strictEqual(card.readByAgent, true);
      assert.strictEqual(card.matched.length, 1);
      // Rows read from images start with nothing ticked; Tick all is one change.
      assert.deepStrictEqual([card.selection?.ticked, card.chosen?.matched], ["none", 0]);
      assert.include(card.heldBack, "images of a scan");
      assert.strictEqual(
        (yield* choose(card, [{ _tag: "tickAll", ticked: true }])).chosen?.matched,
        1,
      );
    }).pipe(Effect.provide(layer)),
  );
});

/** A CSV statement of these rows: day, narration, money out, money in. */
const csvOf = (
  rows: ReadonlyArray<readonly [string, string, number | null, number | null]>,
  balances?: { readonly opening: number },
) => {
  let balance = balances?.opening ?? 0;
  const money = (minor: number) => (minor / 100).toFixed(2);
  return new TextEncoder().encode(
    [
      "Account No :50100000009034",
      ...(balances === undefined ? [] : [`"Opening Balance: ${money(balances.opening)}"`]),
      `Date,Narration,Debit Amount,Credit Amount${balances === undefined ? "" : ",Balance"}`,
      ...rows.map(([day, text, out, inflow]) => {
        balance += (inflow ?? 0) - (out ?? 0);
        return [
          day.split("-").reverse().join("/"),
          `"${text}"`,
          out === null ? "" : money(out),
          inflow === null ? "" : money(inflow),
          ...(balances === undefined ? [] : [money(balance)]),
        ].join(",");
      }),
    ].join("\n"),
  );
};
const expense = (title: string, minor: number, day: string, vendor: string) =>
  Effect.gen(function* () {
    const records = yield* KinRecords.KinRecords;
    const { row } = yield* records.create(orgId, owner, {
      list: "expenses",
      originKey: `expense:${title}:${day}`,
      title,
      owner: { _tag: "person", personId: ownerId },
      state: "open",
      amount: { minor, currency: "INR" },
      dateAt: Date.parse(`${day}T18:29:59.999Z`),
      dateAllDay: true,
      fields: { vendor },
    });
    return row;
  });
const livePayments = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ key: string; minor: number }>`SELECT r.key, p.amount_minor AS minor
    FROM kin_record_payments p JOIN kin_records r ON r.org_id = p.org_id AND r.record_id = p.record_id
    WHERE p.voided_at IS NULL ORDER BY r.key, p.amount_minor`;
});

describe("bank statement safety", () => {
  it.effect(
    "confirms again after an undo and a fresh read, and the card says what was recorded",
    () =>
      Effect.gen(function* () {
        const keys = yield* seed;
        const records = yield* KinRecords.KinRecords;
        const sql = yield* SqlClient.SqlClient;
        const result = yield* read(1, "hdfc-account.pdf");
        yield* OwnerStatements.apply(
          people,
          yield* confirmAll((yield* reviewCardOf(result.statement)).card),
        );
        yield* OwnerStatements.undo(people, { orgId, statementId: result.statement });
        assert.lengthOf(yield* livePayments, 0);
        // Kin reads it again: undo cleared nothing that a read can reset.
        yield* LeadStatements.read(scope, {
          sourceEventId: "event-1",
          attachment: "hdfc-account.pdf",
          refresh: true,
        });
        const fresh = (yield* reviewCardOf(result.statement)).card;
        assert.strictEqual(fresh.status, "open");
        const applied = yield* OwnerStatements.apply(people, yield* confirmAll(fresh));
        assert.include(
          applied.card.result!.join(" "),
          "Recorded 2 payments on invoices, 1 with TDS deducted.",
        );
        assert.deepStrictEqual(
          (yield* livePayments).map((one) => [one.key, one.minor]),
          [
            [keys.exact, 11_800_000],
            [keys.tds, 1_000_000],
            [keys.tds, 9_000_000],
          ],
        );
        assert.strictEqual((yield* records.get(orgId, keys.exact))!.state, "done");
        assert.strictEqual((yield* records.get(orgId, keys.tds))!.state, "done");
        assert.strictEqual((yield* records.get(orgId, keys.aws))!.state, "done");
        const added = applied.card.result!.join(" ").match(/Added (\d+) new expense/)?.[1];
        const live = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_records
        WHERE register_id = 'expenses' AND origin_key LIKE 'statement:%' AND state = 'done'`;
        assert.strictEqual(live[0]!.n, Number(added));
        // One live review card for the statement.
        assert.lengthOf(
          yield* sql`SELECT 1 FROM kin_widgets WHERE type = 'statement_review' AND closed_at IS NULL
          AND state_json LIKE '%"status":"open"%'`,
          0,
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect("lets one entry answer one row: two equal debits, two equal expenses", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const first = yield* expense("Cowork desk October", 500_000, "2026-10-01", "Lakeview Cowork");
      const second = yield* expense("Cowork desk extra", 500_000, "2026-10-01", "Lakeview Cowork");
      const result = yield* read(
        1,
        "cowork.csv",
        csvOf([
          ["2026-10-02", "UPI-LAKEVIEW COWORK-desk@invbank", 500_000, null],
          ["2026-10-03", "UPI-LAKEVIEW COWORK-desk@invbank", 500_000, null],
        ]),
      );
      const card = (yield* reviewCardOf(result.statement)).card;
      assert.lengthOf(card.choose, 2);
      const [one, two] = card.choose;
      const option = (row: typeof one, key: string) =>
        row!.options.find((target) => target.key === key)!.option;
      const picked = yield* choose(card, [
        { _tag: "pick", row: one!.row, option: option(one, first.key) },
      ]);
      // The same expense for the second row is refused, naming it.
      const refused = yield* choose(picked, [
        { _tag: "pick", row: two!.row, option: option(two, first.key) },
      ]).pipe(Effect.flip);
      assert.include(refused.message, first.key);
      // A selection that names it twice anyway (stored before this check) applies nothing.
      yield* sql`UPDATE kin_bank_statements SET selection_json = ${JSON.stringify({
        ...picked.selection,
        revision: 99,
        picks: [
          { row: one!.row, option: option(one, first.key) },
          { row: two!.row, option: option(two, first.key) },
        ],
      })} WHERE statement_id = ${result.statement}`;
      const twice = yield* OwnerStatements.apply(people, {
        ...confirmOf(picked),
        revision: 99,
      }).pipe(Effect.flip);
      assert.include(twice.message, first.key);
      assert.lengthOf(yield* bankRows, 0);
      yield* sql`UPDATE kin_bank_statements SET selection_json = NULL WHERE statement_id = ${result.statement}`;
      const both = yield* choose((yield* reviewCardOf(result.statement)).card, [
        { _tag: "pick", row: one!.row, option: option(one, first.key) },
        { _tag: "pick", row: two!.row, option: option(two, second.key) },
      ]);
      yield* OwnerStatements.apply(people, confirmOf(both));
      const records = yield* KinRecords.KinRecords;
      for (const key of [first.key, second.key])
        assert.strictEqual((yield* records.get(orgId, key))!.state, "done");
      assert.lengthOf(
        yield* sql`SELECT DISTINCT target_record_id FROM kin_bank_statement_entries`,
        2,
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("matches an older expense on a statement listed newest first", () =>
    Effect.gen(function* () {
      yield* seed;
      const rent = yield* expense(
        "Studio rent September",
        3_500_000,
        "2026-09-20",
        "Lakeview Estates",
      );
      const result = opened(
        yield* read(
          1,
          "newest-first.csv",
          csvOf([
            ["2026-11-30", "NEFT CR-SOMEONE NEW", null, 100_000],
            ["2026-11-02", "UPI-NEW VENDOR-new@invbank", 99_900, null],
            ["2026-10-02", "NEFT DR-LAKEVIEW ESTATES-rent", 3_500_000, null],
          ]),
        ),
      );
      const card = (yield* reviewCardOf(result.statement)).card;
      assert.deepStrictEqual(
        [
          ...card.matched.map((one) => one.target.key),
          ...card.choose.flatMap((one) => one.options.map((o) => o.key)),
        ],
        [rent.key],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("starts with nothing ticked when the rows can't be trusted, and says why", () =>
    Effect.gen(function* () {
      const keys = yield* seed;
      // No balances to check: the matched invoice waits for the owner's tick.
      const result = yield* read(
        1,
        "unchecked.csv",
        csvOf([["2026-10-02", "NEFT CR-BRIGHTLINE MEDIA LLP", null, 11_800_000]]),
      );
      const card = (yield* reviewCardOf(result.statement)).card;
      assert.deepStrictEqual(
        [card.matched.map((one) => one.target.key), card.selection?.ticked, card.chosen?.matched],
        [[keys.exact], "none", 0],
      );
      assert.include(card.heldBack, "no balances");
      const ticked = yield* choose(card, [{ _tag: "tickAll", ticked: true }]);
      assert.strictEqual(ticked.chosen?.matched, 1);
      // Balances that add up start ticked.
      const checked = yield* read(
        2,
        "checked.csv",
        csvOf([["2026-10-02", "NEFT CR-BRIGHTLINE MEDIA LLP", null, 11_800_000]], {
          opening: 1_000_000,
        }),
      );
      const fine = (yield* reviewCardOf(checked.statement)).card;
      assert.deepStrictEqual([fine.selection?.ticked, fine.heldBack], ["all", undefined]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("carries a month's rows on the card and pages the rest, applying all it chose", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const rows = Array.from(
        { length: 5_000 },
        (_, index) =>
          [
            `2026-10-${String(1 + (index % 28)).padStart(2, "0")}`,
            `UPI-INVENTED SHOP ${index}-shop${index}@invbank`,
            1_000 + index,
            null,
          ] as const,
      );
      const result = opened(yield* read(1, "year.csv", csvOf(rows)));
      const { card, state } = yield* reviewCardOf(result.statement);
      assert.deepStrictEqual(
        [card.unmatched.length, card.counts?.unmatched],
        [KIN_STATEMENT_CARD_ROWS, 5_000],
      );
      // What is re-sent on each update stays small, however long the statement.
      assert.isBelow(state.length, 40_000);
      const page = yield* OwnerStatements.rows(people, {
        orgId,
        statementId: card.statementId,
        hash: card.hash,
        section: "unmatched",
        offset: 4_950,
        limit: 100,
      });
      assert.deepStrictEqual([page.total, page.unmatched.length], [5_000, 50]);
      const last = page.unmatched.at(-1)!.row;
      const chosen = yield* choose(card, [{ _tag: "action", row: last, action: "ignore" }]);
      assert.strictEqual(chosen.chosen?.unmatched, 1);
      yield* OwnerStatements.apply(people, confirmOf(chosen));
      const states = yield* sql<{ state: string; n: number }>`SELECT state, COUNT(*) AS n
        FROM kin_records WHERE register_id IN
          (SELECT register_id FROM kin_registers WHERE lower(name) = 'bank transactions')
        GROUP BY state ORDER BY state`;
      assert.deepStrictEqual(
        states.map((one) => [one.state, one.n]),
        [
          ["dropped", 1],
          ["open", 4_999],
        ],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("replaces a statement's card when it is read again", () =>
    Effect.gen(function* () {
      const keys = yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const records = yield* KinRecords.KinRecords;
      const result = yield* read(1, "hdfc-account.pdf");
      // The invoice voided, a row fits differently, so the fresh read is a new card.
      yield* records.update(orgId, owner, keys.exact, { state: "dropped" });
      yield* LeadStatements.read(scope, {
        sourceEventId: "event-1",
        attachment: "hdfc-account.pdf",
        refresh: true,
      });
      const widgets = yield* sql<{
        state: string;
        closed: string | null;
      }>`SELECT state_json AS state,
          closed_at AS closed FROM kin_widgets WHERE type = 'statement_review' ORDER BY widget_id`;
      assert.deepStrictEqual(
        widgets.map((one) => [JSON.parse(one.state).status, one.closed === null]).toSorted(),
        [
          ["open", true],
          ["replaced", false],
        ],
      );
      assert.strictEqual((yield* reviewCardOf(result.statement)).card.status, "open");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("undo leaves what a person changed since, and a payment with a receipt", () =>
    Effect.gen(function* () {
      const keys = yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const records = yield* KinRecords.KinRecords;
      const result = yield* read(1, "hdfc-account.pdf");
      yield* OwnerStatements.apply(
        people,
        yield* confirmAll((yield* reviewCardOf(result.statement)).card),
      );
      const created = yield* sql<{ key: string }>`SELECT key FROM kin_records
        WHERE register_id = 'expenses' AND origin_key LIKE 'statement:%' ORDER BY key`;
      // The owner corrects AWS's date and notes a new expense; a receipt is issued for one payment.
      yield* records.update(orgId, owner, keys.aws, { notes: "Paid on the company card" });
      yield* records.update(orgId, owner, created[0]!.key, { notes: "Team lunch" });
      const [payment] = yield* sql<{ paymentId: string }>`SELECT p.payment_id AS "paymentId"
        FROM kin_record_payments p JOIN kin_records r ON r.record_id = p.record_id
        WHERE r.key = ${keys.exact}`;
      yield* defineList(
        orgId,
        { _tag: "new", id: "receipts", ...PRESETS.receipts, definition: PRESETS.receipts },
        NOW,
      );
      const receipt = yield* records.create(orgId, owner, {
        list: "receipts",
        originKey: "receipt:test",
        title: "Received towards September",
        owner: { _tag: "person", personId: ownerId },
        state: "open",
        amount: { minor: 11_800_000, currency: "INR" },
      });
      // Kin ties a receipt to its payment itself, as kin_receipt does.
      yield* sql`UPDATE kin_records SET fields_json = json_set(fields_json,
          '$.invoice', ${keys.exact}, '$.payment', ${payment!.paymentId})
        WHERE record_id = ${receipt.row.recordId}`;
      const undone = yield* OwnerStatements.undo(people, { orgId, statementId: result.statement });
      const said = undone.card.result!.join(" ");
      assert.include(said, "2 left as you changed them");
      assert.include(said, keys.aws);
      assert.include(said, created[0]!.key);
      assert.include(said, `receipt ${receipt.row.key}`);
      // Left as the owner made them, and the receipted payment stays live.
      assert.strictEqual((yield* records.get(orgId, keys.aws))!.state, "done");
      assert.strictEqual((yield* records.get(orgId, created[0]!.key))!.state, "done");
      assert.strictEqual((yield* records.get(orgId, keys.exact))!.state, "done");
      for (const other of created.slice(1))
        assert.strictEqual((yield* records.get(orgId, other.key))!.state, "dropped");
      assert.deepStrictEqual(
        (yield* livePayments).map((one) => one.key),
        [keys.exact],
      );
      assert.strictEqual((yield* records.get(orgId, keys.tds))!.paid, 0);
    }).pipe(Effect.provide(layer)),
  );
});
