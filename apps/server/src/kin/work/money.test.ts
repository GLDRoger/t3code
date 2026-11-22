// Loaded first: the chat and trigger modules import each other.
import "../chat/KinChatService.ts";
import * as NodeZlib from "node:zlib";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ServerConfig } from "../../config.ts";
import {
  EnvironmentId,
  KinAgentId,
  KinOrgId,
  KinPersonId,
  KinRecordKey,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { KinDocRenderer } from "../gendocs/render.ts";
import { KinWorkspace } from "../gendocs/workspace.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import * as KinPulse from "../pulse/KinPulse.ts";
import { setAsideOverdue } from "../pulse/invoiceAsides.ts";
import { KinLevelGate } from "../lead/LevelGate.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import { runKinMigrations } from "../persistence/KinMigrations.ts";
import {
  answerChange,
  changeLines,
  countryFirstMessage,
  countryNeeded,
  newCompanyProfileJson,
  readProfile,
  setProfile,
} from "./companyProfile.ts";
import * as Goals from "./goals.ts";
import * as KinRecords from "./KinRecords.ts";
import * as LeadMoney from "./leadMoney.ts";
import { approvalDedupeKey, approvalEventId } from "../questions/approval.ts";
import * as LeadWork from "./leadWork.ts";
import { typedFields } from "./leadFields.ts";
import { aboutTotal, addUp, financialYearOf, formatMinor, parseAmount } from "./money.ts";
import { budgetFlags, budgetsAnswer, budgetsView } from "./budgets.ts";
import { cashAnswer, cashPosition, outlook, outlookAnswer } from "./moneyAnswers.ts";
import { partnersOwed } from "./partnersOwed.ts";
import {
  dates as datesView,
  moneySection,
  moneySummary,
  ownerLevelStillToInvoice,
} from "./moneyViews.ts";
import { KIN_OWNER_LEVEL, viewerOfPeople } from "./teamView.ts";
import * as OwnerMoney from "./ownerMoney.ts";
import { weeklyFigures } from "../pulse/weekly.ts";
import { checkFields, listDef, presetList, proposalFor } from "./registers.ts";
import { ensureBankList } from "./statements/bankList.ts";
import { waitLine } from "./statements/passwordBudget.ts";
import * as OwnerMoneyAnswers from "./ownerMoneyAnswers.ts";
import * as OwnerWork from "./ownerWork.ts";
import * as LeadDocuments from "../gendocs/leadDocuments.ts";
import * as Quotes from "../gendocs/quotes.ts";
import { endOfDay } from "./recordRows.ts";
import { moneyOf } from "./projectSpine.ts";

// Invented org, people, amounts and files only; nothing here reads a real database.
const orgId = KinOrgId.make("org");
const otherOrg = KinOrgId.make("elsewhere");
const ownerId = KinPersonId.make("owner");
const lead = KinAgentId.make("lead");
const at = "2026-11-11T00:00:00.000Z";
const NOW = Date.parse("2026-11-12T06:00:00.000Z");
const people = [{ _tag: "person" as const, orgId, personId: ownerId }];
/** A PNG's signature and header, as a logo's size is read from them. */
const joined = (parts: ReadonlyArray<Uint8Array>) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};
const pngChunk = (type: string, data: Uint8Array) => {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, NodeZlib.crc32(out.subarray(4, 8 + data.length)));
  return out;
};
/** A real, blank RGBA PNG of this size. */
const pngOf = (width: number, height: number) => {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  return joined([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", NodeZlib.deflateSync(new Uint8Array((width * 4 + 1) * height))),
    pngChunk("IEND", new Uint8Array()),
  ]);
};
/** A JPEG's headers, 120 × 400, cut off in its image data before it ends. */
const cutJpeg = new Uint8Array([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x78, 0x01, 0x90, 0x03, 0x01, 0x22, 0x00, 0x02,
  0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11,
  0x00, 0x3f, 0x00, 0xd2, 0xcf, 0x20, 0x8a, 0x28,
]);
const system = { actor: { _tag: "system" as const }, via: "import" as const };

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
// Kin's card for the owner, stored as the chat service stores a lead's question, and bound in the
// same transaction; no level gate here.
const gate = Layer.unwrap(
  Effect.map(SqlClient.SqlClient, (sql) =>
    Layer.mock(KinLevelGate)({
      ask: (agent, input, bind) =>
        Effect.gen(function* () {
          const messageId = `card-${input.clientMessageId}`;
          const widgetId = `choice:${messageId}`;
          const [{ seq }] = (yield* sql<{ seq: number }>`SELECT 1000 + COUNT(*) AS seq
            FROM kin_widgets`) as [{ seq: number }];
          const state = {
            question: input.question,
            detail: input.detail ?? null,
            options: input.options.map((option, index) => ({
              optionId: `option-${index + 1}`,
              ...option,
            })),
            answer: null,
            ...(input.image === undefined ? {} : { image: input.image }),
          };
          yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind,
              author_agent_id, author_owner_person_id, author_thread_id, author_member_id,
              author_role, kind, body, mentions_json, status, created_at, client_message_id)
            VALUES (${messageId}, ${agent.orgId}, ${input.chatId}, ${seq}, 'agent', ${agent.agentId},
              ${ownerId}, 'lead-thread', 'lead-chat-lead', 'member', 'text', '', '[]', 'posted',
              ${at}, ${`send:${input.clientMessageId}`})
            ON CONFLICT DO NOTHING`;
          yield* sql`INSERT INTO kin_widgets (widget_id, org_id, chat_id, message_id, widget_class,
              type, revision, state_json, awaiting_json, updated_at)
            VALUES (${widgetId}, ${agent.orgId}, ${input.chatId}, ${messageId}, 'native', 'choice', 1,
              ${JSON.stringify(state)}, ${JSON.stringify([ownerId])}, ${at})
            ON CONFLICT DO NOTHING`;
          if (bind !== undefined) yield* bind({ widgetId } as never);
          return { widgetId } as never;
        }).pipe(sql.withTransaction, Effect.orDie),
      // As KinChatService.closeReplaced marks the card.
      closeReplaced: (_agent, widgetIds) =>
        Effect.forEach(
          widgetIds,
          (widgetId) => sql`UPDATE kin_widgets SET closed_at = ${at},
            state_json = json_set(state_json, '$.replaced', json('true'))
            WHERE widget_id = ${widgetId}`,
        ).pipe(Effect.asVoid, Effect.orDie),
    }),
  ),
);
// No documents were made for these entries, so issuing one renders nothing (`DocJobs.test.ts`).
const documents = Layer.mergeAll(
  Layer.mock(KinDocRenderer)({ drawable: () => Effect.undefined }),
  Layer.mock(KinWorkspace)({}),
);
const layer = Layer.mergeAll(KinRecords.layer, identity, gate, documents).pipe(
  Layer.provideMerge(KinEventQueue.layer),
  Layer.provideMerge(KinPersistence.layer),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-money-" })),
  Layer.provideMerge(NodeServices.layer),
);

/**
 * A turn the owner woke with a message in the lead's chat; the turn before it ends. `files`
 * rides on the message as attachments.
 */
const turn = (n: number, body: string, files: ReadonlyArray<string> = []) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const attachments = files.map((name, index) => ({
      type: "file",
      id: `att-${n}-${index}`,
      name,
      mimeType: "image/jpeg",
      sizeBytes: 1000,
    }));
    yield* sql`UPDATE kin_wakeups SET status = 'completed' WHERE status = 'running'`;
    yield* sql`UPDATE kin_chats SET last_seq = ${n} WHERE chat_id = 'lead-chat'`;
    yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind,
        author_person_id, author_member_id, author_role, kind, body, mentions_json, status,
        created_at, attachments_json)
      VALUES (${`msg-${n}`}, ${orgId}, 'lead-chat', ${n}, 'human', ${ownerId}, 'lead-chat-owner',
        'owner', 'text', ${body}, '[]', 'posted', ${at}, ${JSON.stringify(attachments)})`;
    for (const [index] of files.entries())
      yield* sql`INSERT INTO kin_message_attachments (attachment_id, org_id, chat_id, message_id)
        VALUES (${`att-${n}-${index}`}, ${orgId}, 'lead-chat', ${`msg-${n}`})`;
    yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, model, started_at,
        status, event_ids, audience)
      VALUES (${`wake-${n}`}, ${orgId}, ${lead}, 'lead-thread', 'test', 0, 'running',
        ${JSON.stringify([`event-${n}`])}, 'owner_only')`;
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

/** The owner, one lead with its direct chat in India's time zone, and a second org. */
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* TestClock.setTime(NOW);
  yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Invented Co', ${at}), (${otherOrg}, 'Other', ${at})`;
  yield* sql`INSERT INTO kin_trigger_settings (org_id, time_zone, morning_brief, evening_summary,
      dream, full_rebuild_weekday, owner_check_weekday, owner_check, quiet_hours_json)
    VALUES (${orgId}, 'Asia/Kolkata', '08:00', '18:00', '02:00', 0, 1, '09:00', '[]')`;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
    VALUES (${ownerId}, ${orgId}, 'owner', 'Owner', ${at})`;
  yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at, retired_at) VALUES (${lead}, ${orgId}, 'Lead lead', 'lead', ${ownerId}, ${at}, NULL)`;
  yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
    VALUES ('lead-chat', ${orgId}, 'direct', 'owner:lead', 0, ${at})`;
  yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
    VALUES ('lead-chat-owner', ${orgId}, 'lead-chat', 'person', ${ownerId}, 'owner', ${at})`;
  yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, agent_id, role, joined_at)
    VALUES ('lead-chat-lead', ${orgId}, 'lead-chat', 'agent', ${lead}, 'member', ${at})`;
  yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, thread_id, models_json,
      worker_projects_json, owner_chat_id)
    VALUES (${lead}, ${orgId}, 'Lead lead', 0, 'lead-thread', '{}', '[]', 'lead-chat')`;
});

/** The choices a list's Paid with field offers. */
const paidWith = (list: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ choices: string }>`SELECT json_extract(field.value, '$.choices')
        AS choices
      FROM kin_registers r, json_each(json_extract(r.definition_json, '$.fields')) field
      WHERE r.register_id = ${list} AND json_extract(field.value, '$.key') = 'paidWith'`;
    return JSON.parse(row!.choices) as ReadonlyArray<string>;
  });

/** Proposes a list in one turn and creates it from the owner's yes in the next. */
const defined = (n: number, input: Omit<typeof LeadMoney.DefineInput.Type, "sourceEventId">) =>
  Effect.gen(function* () {
    const asked = yield* turn(n, "Start tracking this");
    const proposed = yield* LeadMoney.define(scope, { sourceEventId: asked, ...input });
    // Kin's own invoices and quotes lists need no yes.
    if (proposed.status === "defined") return proposed;
    const yes = yield* turn(n + 1, "Yes, go ahead");
    return yield* LeadMoney.define(scope, { sourceEventId: yes, proposal: proposed.proposal! });
  });

/**
 * `personId`'s tap on Kin's card, settled as the chat service settles a choice (the first answer
 * is the card's), with the tap row it posts and the turn it wakes.
 */
const tap = (n: number, widgetId: string, kind: "yes" | "no", personId: string = ownerId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [card] = yield* sql<{ state: string; messageId: string }>`SELECT state_json AS state,
        message_id AS "messageId" FROM kin_widgets WHERE widget_id = ${widgetId}`;
    const state = JSON.parse(card!.state) as {
      options: Array<{ optionId: string; kind?: string }>;
    };
    const option = state.options.find((one) => one.kind === kind)!;
    const answer = { optionId: option.optionId, personId, via: "tap", emoji: null, answeredAt: at };
    yield* sql`UPDATE kin_widgets SET state_json = ${JSON.stringify({ ...state, answer })},
        revision = revision + 1 WHERE widget_id = ${widgetId}`;
    yield* sql`UPDATE kin_wakeups SET status = 'completed' WHERE status = 'running'`;
    yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind,
        author_person_id, author_member_id, author_role, kind, body, mentions_json, status,
        created_at, widget_id, reply_to)
      VALUES (${`tap-${n}`}, ${orgId}, 'lead-chat', ${2000 + n}, 'human', ${personId},
        'lead-chat-owner', 'owner', 'widget_action', '{}', '[]', 'posted', ${at}, ${widgetId},
        ${card!.messageId})`;
    yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, model, started_at,
        status, event_ids, audience)
      VALUES (${`wake-${n}`}, ${orgId}, ${lead}, 'lead-thread', 'test', 0, 'running',
        ${JSON.stringify([`event-${n}`])}, 'owner_only')`;
    const event = {
      _tag: "widget.action",
      orgId,
      agentId: lead,
      eventId: `event-${n}`,
      receivedAt: at,
      dedupeKey: null,
      provenance: { _tag: "human", personId, memberId: "lead-chat-owner" },
      chatId: "lead-chat",
      messageId: `tap-${n}`,
      actionId: "choose",
    };
    yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json,
        received_at, queued_at, state, wakeup_id)
      VALUES (${`event-${n}`}, ${orgId}, ${lead}, 'widget.action', 'P0', ${JSON.stringify(event)},
        0, 0, 'claimed', ${`wake-${n}`})`;
    return `event-${n}`;
  });
const cardOf = (clientMessageId: string) => `choice:card-${clientMessageId}`;
/** The owner issues them: an invoice an agent made is a draft until then. */
const issueAll = (...keys: ReadonlyArray<string>) =>
  Effect.forEach(keys, (key) => OwnerMoney.issue(people, { orgId, key: KinRecordKey.make(key) }), {
    discard: true,
  });

describe("amounts", () => {
  it("reads spoken and written amounts as exact minor units, and refuses the ambiguous", () => {
    for (const [text, minor, currency] of [
      ["4.2 lakh", 42_000_000, "INR"],
      ["₹1,23,456.78", 12_345_678, "INR"],
      ["Rs. 999/-", 99_900, "INR"],
      ["1.5 crore", 1_500_000_000, "INR"],
      ["12k", 1_200_000, "INR"],
      ["$12.5", 1_250, "USD"],
      ["EUR 0.10", 10, "EUR"],
      ["JPY 1500", 1_500, "JPY"],
      ["PKR 1,500", 1_500, "PKR"],
    ] as const)
      assert.deepStrictEqual(parseAmount(text, "INR"), { money: { minor, currency } }, text);
    for (const text of ["12.345", "$5 and ₹5", "a lot", "JPY 1.5", "99999999999999 crore", "-20"])
      assert.isTrue("error" in parseAmount(text, "INR"), text);
  });

  it("adds awkward amounts exactly and never mixes currencies", () => {
    const tenths = Array.from({ length: 10 }, () => ({ minor: 10, currency: "INR" }));
    assert.deepStrictEqual(
      addUp(
        [
          ...tenths,
          { minor: 1, currency: "USD" },
          { minor: Number.MAX_SAFE_INTEGER - 100, currency: "EUR" },
          { minor: 100, currency: "EUR" },
          { minor: 2, currency: "USD" },
        ],
        "INR",
      ),
      [
        { minor: 100, currency: "INR" },
        { minor: Number.MAX_SAFE_INTEGER, currency: "EUR" },
        { minor: 3, currency: "USD" },
      ],
    );
    // A refund row takes its part off, and a total may go below zero.
    assert.deepStrictEqual(
      addUp(
        [
          { minor: 500, currency: "INR" },
          { minor: -700, currency: "INR" },
        ],
        "INR",
      ),
      [{ minor: -200, currency: "INR" }],
    );
    // A company whose home currency is USD reads its own total first.
    assert.deepStrictEqual(
      addUp([...tenths, { minor: 3, currency: "USD" }], "USD").map((one) => one.currency),
      ["USD", "INR"],
    );
    assert.throws(() =>
      addUp(
        [
          { minor: Number.MAX_SAFE_INTEGER, currency: "INR" },
          { minor: 1, currency: "INR" },
        ],
        "INR",
      ),
    );
  });

  it("estimates totals at the owner's rates, summed exactly and rounded once", () => {
    const eur = [{ currency: "EUR", rate: "1.08", asOf: "2026-11-10" }];
    const usd = (minor: number) => ({ minor, currency: "USD" });
    const three = [
      usd(100_000),
      { minor: 50_000, currency: "EUR" },
      { minor: 2_000, currency: "AED" },
    ];
    assert.deepStrictEqual(aboutTotal(three, "USD", eur), {
      home: "USD",
      total: usd(154_000),
      missing: ["AED"],
    });
    // One currency says it exactly already; none with a rate is no estimate at all.
    assert.strictEqual(aboutTotal([usd(100_000)], "USD", eur), undefined);
    assert.strictEqual(
      aboutTotal(
        [
          { minor: 1, currency: "AED" },
          { minor: 1, currency: "GBP" },
        ],
        "USD",
        eur,
      ),
      undefined,
    );
    // A refund lowers the exact total and the estimate with it.
    const refunded = addUp(
      [usd(100_000), { minor: 50_000, currency: "EUR" }, { minor: -10_000, currency: "EUR" }],
      "USD",
    );
    assert.deepStrictEqual(refunded, [usd(100_000), { minor: 40_000, currency: "EUR" }]);
    assert.deepStrictEqual(aboutTotal(refunded, "USD", eur)?.total, usd(143_200));
    assert.deepStrictEqual(
      aboutTotal([usd(-100_000), { minor: -50_000, currency: "EUR" }], "USD", eur)?.total,
      usd(-154_000),
    );
    // $10.40 + €0.40 + £0.40 at 1.0 is $11.20, about $11; rounding each first would say $10.
    const par = [
      { currency: "EUR", rate: "1", asOf: "2026-11-10" },
      { currency: "GBP", rate: "1.0", asOf: "2026-11-10" },
    ];
    assert.deepStrictEqual(
      aboutTotal(
        [usd(1_040), { minor: 40, currency: "EUR" }, { minor: 40, currency: "GBP" }],
        "USD",
        par,
      )?.total,
      usd(1_100),
    );
    // Across decimals: ¥1,500 at 0.006543 is $9.8145 and KWD 1.000 at 3.25 is $3.25.
    assert.deepStrictEqual(
      aboutTotal(
        [usd(30), { minor: 1_500, currency: "JPY" }, { minor: 1_000, currency: "KWD" }],
        "USD",
        [
          { currency: "JPY", rate: "0.006543", asOf: "2026-11-10" },
          { currency: "KWD", rate: "3.25", asOf: "2026-11-10" },
        ],
      )?.total,
      usd(1_300),
    );
  });

  it("formats totals past a float's exact range digit for digit, signed", () => {
    const past = BigInt(Number.MAX_SAFE_INTEGER) * 10n + 7n;
    assert.strictEqual(formatMinor(past, "INR"), "₹90,07,19,92,54,74,099.17");
    assert.strictEqual(formatMinor(-past, "USD"), "-$900,719,925,474,099.17");
    assert.strictEqual(formatMinor(-5n, "INR"), "-₹0.05");
    const view = {
      month: "2026-11",
      budgets: [
        {
          budgetId: "bg",
          category: "travel",
          projectId: null,
          projectKey: null,
          projectTitle: null,
          currency: "INR",
          limitMinor: 100,
          spent: past,
          expenses: 2,
          status: "over" as const,
          notCounted: [],
        },
      ],
    };
    assert.deepInclude(budgetsAnswer(view).budgets[0], {
      spent: "₹90,07,19,92,54,74,099.17",
      over: "₹90,07,19,92,54,74,098.17",
    });
  });

  it("puts 31 March and 1 April in different financial years", () => {
    assert.strictEqual(financialYearOf("2026-03-31"), "FY2025-26");
    assert.strictEqual(financialYearOf("2026-04-01"), "FY2026-27");
    assert.strictEqual(financialYearOf("2099-12-31"), "FY2099-00");
    // A year from January is named by its one year; one from July spans two.
    assert.strictEqual(financialYearOf("2026-03-31", 1), "FY2026");
    assert.strictEqual(financialYearOf("2026-06-30", 7), "FY2025-26");
    assert.strictEqual(financialYearOf("2026-07-01", 7), "FY2026-27");
  });
});

describe("lists through the tools", () => {
  it.effect("are created only from the owner's later yes, then take entries totalled exactly", () =>
    Effect.gen(function* () {
      yield* seed;
      const asked = yield* turn(1, "Start tracking expenses");
      // Before any list exists, an expense has nowhere to go.
      const early = yield* LeadWork.create(scope, {
        sourceEventId: asked,
        records: [{ list: "expenses", title: "Invented taxi", amount: "450" }],
      }).pipe(Effect.flip);
      assert.include(early, { reason: "not_found" });
      const proposed = yield* LeadMoney.define(scope, {
        sourceEventId: asked,
        template: "expenses",
        fields: [{ label: "Project code", type: "text" }],
      });
      assert.strictEqual(proposed.status, "proposed");
      assert.include(
        proposed.fields.map((one) => one.key),
        "projectCode",
      );
      // The same turn can't carry its own proposal out: the owner hasn't answered.
      const same = yield* LeadMoney.define(scope, {
        sourceEventId: asked,
        proposal: proposed.proposal!,
      }).pipe(Effect.flip);
      assert.include(same, { reason: "not_allowed" });
      const sql = yield* SqlClient.SqlClient;
      assert.deepStrictEqual(
        yield* sql`SELECT register_id FROM kin_registers WHERE register_id = 'expenses'`,
        [],
      );

      const yes = yield* turn(2, "Yes");
      const made = yield* LeadMoney.define(scope, {
        sourceEventId: yes,
        proposal: proposed.proposal!,
      });
      assert.strictEqual(made.status, "defined");
      // A retry of the yes returns the same list and adds nothing.
      yield* LeadMoney.define(scope, { sourceEventId: yes, proposal: proposed.proposal! });
      assert.lengthOf(yield* sql`SELECT 1 FROM kin_registers WHERE register_id = 'expenses'`, 1);

      // An amount in the title is refused; the amount field takes it.
      const titled = yield* LeadWork.create(scope, {
        sourceEventId: yes,
        records: [{ list: "expenses", title: "Taxi ₹450" }],
      }).pipe(Effect.flip);
      assert.include(titled, { reason: "invalid_state" });
      const rows = [
        {
          list: "expenses",
          title: "Invented taxi",
          amount: "0.10",
          category: "travel",
          date: "2026-11-02",
        },
        {
          list: "expenses",
          title: "Invented cab",
          amount: "0.20",
          category: "travel",
          date: "2026-11-03",
        },
        {
          list: "expenses",
          title: "Invented stand",
          amount: "4.2 lakh",
          category: "hardware",
          date: "2026-11-04",
        },
        {
          list: "expenses",
          title: "Invented domain",
          amount: "$12.34",
          category: "software",
          date: "2026-11-05",
        },
        {
          list: "expenses",
          title: "Invented hosting",
          amount: "USD 0.66",
          category: "software",
          date: "2026-11-06",
        },
      ];
      // K023: 4.2 lakh after rows of paise reads like a slip until the agent says it is right.
      const slip = yield* LeadWork.create(scope, { sourceEventId: yes, records: rows }).pipe(
        Effect.flip,
      );
      assert.include(
        slip.message,
        'Row 3 ("Invented stand"): ₹4,20,000.00 is far above anything in Expenses (largest ₹0.20).',
      );
      const created = yield* LeadWork.create(scope, {
        sourceEventId: yes,
        records: rows.map((row) =>
          row.title === "Invented stand" ? { ...row, confirmed: true } : row,
        ),
      });
      assert.deepStrictEqual(
        created.records.map((one) => one.key),
        ["EXP-1", "EXP-2", "EXP-3", "EXP-4", "EXP-5"],
      );
      const all = yield* LeadWork.query(scope, { list: "expenses", groupBy: "category" });
      assert.deepStrictEqual(all.totals, ["₹4,20,000.30", "$13.00"]);
      assert.isTrue(all.sensitive);
      assert.deepStrictEqual(all.groups?.map((one) => [one.group, one.totals]).toSorted(), [
        ["hardware", ["₹4,20,000.00"]],
        ["software", ["$13.00"]],
        ["travel", ["₹0.30"]],
      ]);
      // summary keeps the count, exact totals and groups, and shrinks each row to its key.
      const compact = yield* LeadWork.query(scope, {
        list: "expenses",
        groupBy: "category",
        summary: true,
      });
      const { records: allRows, ...rest } = all;
      assert.deepStrictEqual(compact, {
        ...rest,
        records: [],
        keys: allRows.map((one) => one.key),
      });
      assert.deepStrictEqual(
        (yield* LeadWork.query(scope, { list: "expenses", summary: true, limit: 2 })).next,
        2,
      );
      // The service figures are integers per currency, never a float sum.
      const records = yield* KinRecords.KinRecords;
      const totals = yield* records.totals(orgId, { list: "expenses" });
      assert.deepStrictEqual(totals.total, [
        { minor: 42_000_030, currency: "INR" },
        { minor: 1_300, currency: "USD" },
      ]);

      // The owner's list screen: one category over some days, with every match summed.
      const travel = yield* OwnerWork.list(people, {
        orgId,
        list: "expenses",
        listCategory: "travel",
        dateFrom: "2026-11-03",
        dateTo: "2026-11-30",
        totalsBy: "month",
        limit: 1,
      });
      assert.deepStrictEqual(
        [travel.records.map((one) => one.key), travel.total, travel.totals],
        [
          ["EXP-2"],
          1,
          {
            total: [{ minor: 20, currency: "INR" }],
            groups: [{ group: "2026-11", count: 1, total: [{ minor: 20, currency: "INR" }] }],
          },
        ],
      );
      const byCategory = yield* OwnerWork.list(people, {
        orgId,
        list: "expenses",
        totalsBy: "category",
        limit: 1,
      });
      assert.deepStrictEqual(
        byCategory.totals?.groups.map((one) => [one.group, one.count]).toSorted(),
        [
          ["hardware", 1],
          ["software", 2],
          ["travel", 2],
        ],
      );

      // The owner renames a state the list uses; one it doesn't use is refused.
      const [expenses] = (yield* OwnerMoney.lists(people, { orgId })).lists.filter(
        (one) => one.list === "expenses",
      );
      const renamed = yield* OwnerMoney.updateList(people, {
        orgId,
        list: "expenses",
        rev: expenses!.rev,
        stateLabels: { done: "Settled" },
      });
      assert.deepStrictEqual(
        [renamed.stateLabels.done, renamed.stateLabels.open, renamed.rev],
        ["Settled", "To pay", expenses!.rev + 1],
      );
      const unused = yield* OwnerMoney.updateList(people, {
        orgId,
        list: "expenses",
        rev: renamed.rev,
        stateLabels: { doing: "Under way" },
      }).pipe(Effect.flip);
      assert.include(unused, { reason: "invalid_state" });

      // A void entry stays in the list and out of its sum, unless void is what was asked for.
      yield* LeadWork.update(scope, { key: "EXP-3", sourceEventId: yes, state: "dropped" });
      const everything = yield* OwnerWork.list(people, {
        orgId,
        list: "expenses",
        totalsBy: "none",
        limit: 1,
      });
      const voided = yield* OwnerWork.list(people, {
        orgId,
        list: "expenses",
        states: ["dropped"],
        totalsBy: "none",
      });
      assert.deepStrictEqual(
        [everything.total, everything.totals?.total, voided.totals?.total],
        [
          5,
          [
            { minor: 30, currency: "INR" },
            { minor: 1_300, currency: "USD" },
          ],
          [{ minor: 42_000_000, currency: "INR" }],
        ],
      );
      // K004: an amount-only edit of a dollar expense stays in dollars, not the list's rupees.
      yield* LeadWork.update(scope, { sourceEventId: yes, key: "EXP-4", amount: "15" });
      assert.deepStrictEqual((yield* records.get(orgId, "EXP-4"))?.currency, "USD");
      assert.strictEqual((yield* records.get(orgId, "EXP-4"))?.amountMinor, 1_500);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "take a tap only on the proposal's own card, a typed yes for all pending, and a No as final",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const asked = yield* turn(1, "Track receipts and expenses, and dates too");
        const receipts = yield* LeadMoney.define(scope, {
          sourceEventId: asked,
          template: "receipts",
        });
        const expenses = yield* LeadMoney.define(scope, {
          sourceEventId: asked,
          template: "expenses",
        });
        const dates = yield* LeadMoney.define(scope, { sourceEventId: asked, template: "dates" });
        // Each proposal is put to the owner on a card of its own, with its fields.
        const [card] = yield* sql<{ widgetId: string; state: string }>`SELECT p.widget_id AS
            "widgetId", w.state_json AS state FROM kin_list_proposals p
          JOIN kin_widgets w ON w.widget_id = p.widget_id
          WHERE p.proposal_id = ${receipts.proposal!}`;
        assert.strictEqual(card!.widgetId, cardOf(`kin-list:${receipts.proposal!}`));
        assert.include(JSON.parse(card!.state).question, "Receipts");
        assert.include(JSON.parse(card!.state).detail, "Receipt number (text)");
        const define = (sourceEventId: string, proposal: string) =>
          LeadMoney.define(scope, { sourceEventId, proposal });

        // A teammate's tap is no answer, and nor is the owner's yes on some other question.
        yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
          VALUES ('mate', ${orgId}, 'mate', 'Mate', ${at})`;
        const strangers = yield* tap(2, cardOf(`kin-list:${receipts.proposal!}`), "yes", "mate");
        assert.include(yield* Effect.flip(define(strangers, receipts.proposal!)), {
          reason: "not_allowed",
        });
        const other = yield* tap(3, cardOf(`kin-list:${expenses.proposal!}`), "yes");
        assert.include(yield* Effect.flip(define(other, dates.proposal!)), {
          reason: "not_allowed",
        });
        // That yes was for expenses, so it carries expenses out, once.
        assert.strictEqual((yield* define(other, expenses.proposal!)).status, "defined");
        assert.strictEqual((yield* define(other, expenses.proposal!)).status, "defined");
        assert.lengthOf(yield* sql`SELECT 1 FROM kin_registers WHERE register_id = 'expenses'`, 1);

        // A No on its card ends a proposal: no later message carries it out.
        const no = yield* tap(4, cardOf(`kin-list:${dates.proposal!}`), "no");
        assert.include(yield* Effect.flip(define(no, dates.proposal!)), { reason: "not_allowed" });
        const later = yield* turn(5, "Yes, do it");
        assert.include(yield* Effect.flip(define(later, dates.proposal!)), {
          reason: "not_allowed",
        });
        // One typed yes may answer every proposal still pending before it; the model judges it.
        assert.strictEqual((yield* define(later, receipts.proposal!)).status, "defined");
        assert.deepStrictEqual(
          yield* sql`SELECT register_id FROM kin_registers WHERE register_id = 'dates'`,
          [],
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect("keep a defined list's sensitive fields out of what search shows as public", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* defined(1, {
        name: "Leave",
        fields: [
          { label: "Reason", type: "text", sensitive: true },
          { label: "Cover", type: "text" },
        ],
      });
      const asked = yield* turn(3, "Log my leave");
      yield* LeadWork.create(scope, {
        sourceEventId: asked,
        records: [
          {
            list: "leave",
            title: "Invented week off",
            fields: { reason: "zqsurgery", cover: "zqcolleague" },
          },
        ],
      });
      const sql = yield* SqlClient.SqlClient;
      const parts = (word: string) =>
        sql<{ part: string }>`SELECT m.part FROM kin_search s
          JOIN kin_search_rows m ON m.id = s.rowid WHERE kin_search MATCH ${word}`;
      assert.deepStrictEqual(yield* parts("zqsurgery"), [{ part: "sensitive" }]);
      assert.deepStrictEqual(yield* parts("zqcolleague"), [{ part: "public" }]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("groups by Indian financial year in the owner's zone, not UTC", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* defined(1, { template: "expenses" });
      const records = yield* KinRecords.KinRecords;
      // 20:00 UTC on 31 March is already 1 April in India.
      for (const [title, dateAt] of [
        ["Invented March rent", Date.parse("2026-03-31T12:00:00.000Z")],
        ["Invented April rent", Date.parse("2026-03-31T20:00:00.000Z")],
      ] as const)
        yield* records.create(orgId, system, {
          list: "expenses",
          title,
          owner: { _tag: "person", personId: ownerId },
          amount: { minor: 100_00, currency: "INR" },
          dateAt,
          originKey: title,
        });
      const byYear = yield* records.totals(orgId, { list: "expenses" }, "financialYear");
      assert.deepStrictEqual(byYear.groups, [
        { group: "FY2025-26", count: 1, total: [{ minor: 100_00, currency: "INR" }] },
        { group: "FY2026-27", count: 1, total: [{ minor: 100_00, currency: "INR" }] },
      ]);
      // Undated, it belongs to the month it was added in, wherever it is due.
      yield* records.create(orgId, system, {
        list: "expenses",
        title: "Invented undated bill",
        owner: { _tag: "person", personId: ownerId },
        amount: { minor: 100_00, currency: "INR" },
        dueAt: Date.parse("2026-12-01T06:00:00.000Z"),
        originKey: "undated",
      });
      const november = yield* records.totals(
        orgId,
        {
          list: "expenses",
          dateFrom: Date.parse("2026-10-31T18:30:00.000Z"),
          dateTo: Date.parse("2026-11-30T18:30:00.000Z"),
        },
        "month",
      );
      assert.deepStrictEqual(
        november.groups?.map((one) => one.group),
        ["2026-11"],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "keep a receipt from the turn's own message, and an unreadable one as a suggestion",
    () =>
      Effect.gen(function* () {
        yield* seed;
        yield* defined(1, { template: "expenses" });
        const sent = yield* turn(3, "Receipts", ["taxi.jpg", "blurry.jpg"]);
        const kept = yield* LeadWork.create(scope, {
          sourceEventId: sent,
          records: [
            {
              list: "expenses",
              title: "Invented taxi",
              amount: "₹450",
              date: "2026-11-10",
              fields: { vendor: "Invented Cabs", receipt: ["taxi.jpg"] },
            },
            {
              list: "expenses",
              title: "Receipt to check",
              date: "2026-11-10",
              suggested: true,
              fields: { receipt: ["blurry.jpg"] },
            },
          ],
        });
        const records = yield* KinRecords.KinRecords;
        const taxi = yield* records.get(orgId, kept.records[0]!.key);
        const detail = yield* records.detail(taxi!);
        assert.deepStrictEqual(
          detail.files?.map((one) => one.name),
          ["taxi.jpg"],
        );
        // A file this turn's messages don't carry is refused, so no entry points at it.
        const missing = yield* LeadWork.create(scope, {
          sourceEventId: sent,
          records: [
            { list: "expenses", title: "Invented lunch", fields: { receipt: ["lunch.jpg"] } },
          ],
        }).pipe(Effect.flip);
        assert.include(missing, { reason: "invalid_state" });
        // W-26: a vendor is who was paid, never the document's word for itself or its file name.
        for (const vendor of ["Receipt", "invoice #123", "Bill No. 4", "IMG_1234.jpg", "scan.PDF"])
          assert.include(
            (yield* LeadWork.create(scope, {
              sourceEventId: sent,
              records: [{ list: "expenses", title: "Invented taxi", fields: { vendor } }],
            }).pipe(Effect.flip)).message,
            "is not a vendor",
            vendor,
          );
        // An agent reading a bill for 0, such as a free plan's, records nothing.
        const free = { list: "expenses", title: "Invented hosting", date: "2026-11-10" };
        for (const amount of ["0", "$0.00"])
          assert.include(
            (yield* LeadWork.create(scope, {
              sourceEventId: sent,
              records: [{ ...free, amount }],
            }).pipe(Effect.flip)).message,
            "An expense for 0 cost nothing",
          );
        assert.include(
          (yield* LeadWork.update(scope, {
            sourceEventId: sent,
            key: taxi!.key,
            amount: "0",
          }).pipe(Effect.flip)).message,
          "An expense for 0 cost nothing",
        );
        // The owner may keep one for 0, but a vendor named Receipt is refused for them too.
        const ownerEdit = (
          patch: Omit<Parameters<typeof OwnerWork.update>[1], "orgId" | "key" | "rev">,
        ) =>
          Effect.gen(function* () {
            const row = yield* records.get(orgId, taxi!.key);
            return yield* OwnerWork.update(people, {
              orgId,
              key: taxi!.key,
              rev: row!.rev,
              ...patch,
            });
          });
        assert.strictEqual(
          (yield* ownerEdit({ amount: { minor: 0, currency: "INR" } })).amount?.minor,
          0,
        );
        assert.include(
          (yield* Effect.flip(ownerEdit({ fields: { vendor: "RECEIPT" } }))).message,
          "is not a vendor",
        );
        // The suggestion waits for the owner, who confirms it once they've read the receipt.
        const blurry = yield* records.get(orgId, kept.records[1]!.key);
        assert.strictEqual(blurry!.confirmed, 0);
        yield* OwnerWork.confirm(people, { orgId, key: blurry!.key, rev: blurry!.rev });
        assert.strictEqual((yield* records.get(orgId, blurry!.key))!.confirmed, 1);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("record one charge mailed as an invoice and a receipt once, keeping both files", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* defined(1, { template: "expenses" });
      const charge = (title: string, file: string, date = "2026-11-10") => ({
        list: "expenses",
        title,
        amount: "₹1,770",
        date,
        fields: { vendor: "Invented Cloud", receipt: [file] },
      });
      const mailed = yield* turn(3, "Fwd: Your receipt", ["invoice-77.pdf", "receipt-77.pdf"]);
      const pair = [
        charge("Invented Cloud invoice", "invoice-77.pdf"),
        charge("Invented Cloud receipt", "receipt-77.pdf"),
      ];
      const kept = yield* LeadWork.create(scope, { sourceEventId: mailed, records: pair });
      assert.deepStrictEqual(
        kept.records.map((one) => [one.key, one.created]),
        [
          ["EXP-1", true],
          ["EXP-1", false],
        ],
      );
      const records = yield* KinRecords.KinRecords;
      const files = (key: string) =>
        records.get(orgId, key).pipe(
          Effect.flatMap((entry) => records.detail(entry!)),
          Effect.map((detail) => detail.files?.map((one) => one.name)),
        );
      assert.deepStrictEqual(yield* files("EXP-1"), ["invoice-77.pdf", "receipt-77.pdf"]);
      // A retry is the same entry, and keeps each file once.
      const again = yield* LeadWork.create(scope, { sourceEventId: mailed, records: pair });
      assert.deepStrictEqual(
        again.records.map((one) => one.key),
        ["EXP-1", "EXP-1"],
      );
      assert.deepStrictEqual(yield* files("EXP-1"), ["invoice-77.pdf", "receipt-77.pdf"]);
      // The same charge in another mail is another charge.
      const next = yield* turn(4, "Fwd: Your receipt", ["receipt-78.pdf"]);
      const other = yield* LeadWork.create(scope, {
        sourceEventId: next,
        records: [charge("Invented Cloud receipt", "receipt-78.pdf", "2026-11-11")],
      });
      assert.deepInclude(other.records[0], { key: "EXP-2", created: true });
      // Two receipts for the same price in one mail are two purchases.
      const two = yield* turn(5, "Fwd: Your receipts", ["Receipt-2001.pdf", "Receipt-2002.pdf"]);
      const bought = yield* LeadWork.create(scope, {
        sourceEventId: two,
        records: [
          charge("Invented Cloud seat", "Receipt-2001.pdf", "2026-11-12"),
          charge("Invented Cloud domain", "Receipt-2002.pdf", "2026-11-13"),
        ],
      });
      assert.deepStrictEqual(
        bought.records.map((one) => [one.key, one.created]),
        [
          ["EXP-3", true],
          ["EXP-4", true],
        ],
      );
      // Named in besides, an invoice and a receipt stay apart too.
      const told = yield* turn(6, "Fwd: Two orders", ["Invoice-88.pdf", "Receipt-88.pdf"]);
      const plan = { ...charge("Invented Cloud plan", "Invoice-88.pdf"), amount: "₹590" };
      yield* LeadWork.create(scope, { sourceEventId: told, records: [plan] });
      const apart = yield* LeadWork.create(scope, {
        sourceEventId: told,
        records: [
          {
            ...plan,
            title: "Invented Cloud plan, second seat",
            fields: { vendor: "Invented Cloud", receipt: ["Receipt-88.pdf"] },
            besides: ["EXP-5"],
          },
        ],
      });
      assert.deepInclude(apart.records[0], { key: "EXP-6", created: true });
      // Either order ends as one Paid expense, paid on the receipt's day and way, with both files.
      const invoice = (amount: string, file: string, date?: string) => ({
        list: "expenses",
        title: "Invented Cloud invoice",
        amount,
        state: "open" as const,
        due: "2026-11-20",
        ...(date === undefined ? {} : { date }),
        fields: { vendor: "Invented Cloud", receipt: [file] },
      });
      const receipt = (amount: string, file: string) => ({
        list: "expenses",
        title: "Invented Cloud receipt",
        amount,
        date: "2026-11-12",
        fields: { vendor: "Invented Cloud", paidWith: "card", receipt: [file] },
      });
      for (const [n, amount, first] of [
        [7, "₹2,950", "invoice"],
        [8, "₹3,540", "receipt"],
      ] as const) {
        const names = [`Invoice-${n}.pdf`, `Receipt-${n}.pdf`];
        const both = yield* turn(n, "Fwd: Your receipt", names);
        // The invoice first carries its issue day; the one after it, none.
        const issued = first === "invoice" ? "2026-11-10" : undefined;
        const docs = [invoice(amount, names[0]!, issued), receipt(amount, names[1]!)];
        const one = yield* LeadWork.create(scope, {
          sourceEventId: both,
          records: first === "invoice" ? docs : docs.toReversed(),
        });
        assert.strictEqual(one.records[0]!.key, one.records[1]!.key, first);
        const entry = (yield* records.get(orgId, one.records[0]!.key))!;
        assert.strictEqual(entry.state, "done", first);
        assert.strictEqual(entry.dateAt, endOfDay("2026-11-12", "Asia/Kolkata"));
        assert.include(entry.fieldsJson, '"card"');
        assert.sameMembers((yield* files(entry.key))!, names);
      }
    }).pipe(Effect.provide(layer)),
  );
});

describe("goals through the tools", () => {
  it.effect("asks for a fresh target when a goal's measure changes between money and a count", () =>
    Effect.gen(function* () {
      yield* seed;
      const asked = yield* turn(1, "Set a goal of 12 tasks done by December");
      yield* LeadWork.create(scope, {
        sourceEventId: asked,
        records: [
          {
            list: "goals",
            title: "Invented: twelve tasks",
            measure: "tasks_done",
            target: "12",
            due: "2026-12-31",
          },
        ],
      });
      const changed = yield* turn(2, "Make that goal about revenue received instead");
      const measureOnly = LeadWork.update(scope, {
        sourceEventId: changed,
        key: "G-1",
        measure: "revenue_received",
      });
      assert.strictEqual(
        (yield* Effect.flip(measureOnly)).message,
        `A revenue received goal's target is an amount: send the target with the measure, such as target "50,000".`,
      );
      const sql = yield* SqlClient.SqlClient;
      assert.deepStrictEqual(
        yield* sql`SELECT json_extract(fields_json, '$.measure') AS measure,
            json_extract(fields_json, '$.target') AS target
          FROM kin_records WHERE register_id = 'goals'`,
        [{ measure: "tasks_done", target: "12" }],
      );
      yield* LeadWork.update(scope, {
        sourceEventId: changed,
        key: "G-1",
        measure: "revenue_received",
        target: "50,000",
      });
      assert.deepStrictEqual(
        yield* sql`SELECT json_extract(fields_json, '$.target.minor') AS minor
          FROM kin_records WHERE register_id = 'goals'`,
        [{ minor: 5_000_000 }],
      );
    }).pipe(Effect.provide(layer)),
  );
});

describe("a list proposed again", () => {
  it.effect(
    "after a co-owner's yes is the same proposal and card; after a no it is a new one",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
        VALUES ('co-owner', ${orgId}, 'co', 'Co', ${at}, 'co_owner')`;
        const cards = () =>
          sql`SELECT 1 FROM kin_widgets WHERE type = 'choice' AND state_json LIKE '%Create the list%'`;
        // Kin's own quotes list is made at once, with no card to tap.
        const quotes = yield* turn(9, "Track quotes");
        const plain = yield* LeadMoney.define(scope, { sourceEventId: quotes, template: "quotes" });
        assert.strictEqual(plain.status, "defined");
        assert.lengthOf(yield* cards(), 0);
        const asked = yield* turn(1, "Track dates");
        const first = yield* LeadMoney.define(scope, { sourceEventId: asked, template: "dates" });
        // A co-owner taps Create it; the tap's turn proposes the same list instead of carrying it out.
        const yes = yield* tap(2, cardOf(`kin-list:${first.proposal!}`), "yes", "co-owner");
        const again = yield* LeadMoney.define(scope, { sourceEventId: yes, template: "dates" });
        assert.strictEqual(again.proposal, first.proposal);
        assert.lengthOf(yield* cards(), 1);
        const made = yield* LeadMoney.define(scope, {
          sourceEventId: yes,
          proposal: again.proposal!,
        });
        assert.strictEqual(made.status, "defined");
        // A no stands: asked again later, it is a new question on a new card.
        const later = yield* turn(3, "Track expenses");
        const declined = yield* LeadMoney.define(scope, {
          sourceEventId: later,
          template: "expenses",
        });
        yield* tap(4, cardOf(`kin-list:${declined.proposal!}`), "no", "co-owner");
        const asks = yield* turn(5, "Actually, do track expenses");
        const fresh = yield* LeadMoney.define(scope, { sourceEventId: asks, template: "expenses" });
        assert.notStrictEqual(fresh.proposal, declined.proposal);
        assert.lengthOf(yield* cards(), 3);
      }).pipe(Effect.provide(layer)),
  );
});

describe("who asked", () => {
  it.effect("is the tapper by the tap's own stored row, never the message a tap event names", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
        VALUES ('mate', ${orgId}, 'mate', 'Mate', ${at})`;
      const asked = yield* turn(1, "Track dates");
      const proposed = yield* LeadMoney.define(scope, {
        sourceEventId: asked,
        template: "dates",
      });
      const askedBy = (n: number) =>
        LeadWork.askedBy({ orgId, agentId: lead, wakeupId: `wake-${n}` } as LeadWork.Lead);
      // A tap event naming the owner's own message, not a tap row, is nobody's tap.
      for (const personId of ["mate", ownerId]) {
        yield* turn(2, "Here is a message");
        yield* sql`UPDATE kin_events SET tag = 'widget.action', json = json_set(json,
            '$._tag', 'widget.action', '$.actionId', 'choose',
            '$.provenance.personId', ${personId}) WHERE event_id = 'event-2'`;
        assert.isNull(yield* askedBy(2));
        yield* sql`DELETE FROM kin_events WHERE event_id = 'event-2'`;
        yield* sql`DELETE FROM kin_wakeups WHERE wakeup_id = 'wake-2'`;
        yield* sql`DELETE FROM kin_messages WHERE message_id = 'msg-2'`;
      }
      yield* tap(3, cardOf(`kin-list:${proposed.proposal!}`), "yes");
      assert.strictEqual(yield* askedBy(3), ownerId);
      yield* tap(4, cardOf(`kin-list:${proposed.proposal!}`), "yes", "mate");
      assert.isNull(yield* askedBy(4));
    }).pipe(Effect.provide(layer)),
  );
});

describe("repeating entries", () => {
  it.effect("spawn exactly one successor however often the close is retried", () =>
    Effect.gen(function* () {
      yield* seed;
      const records = yield* KinRecords.KinRecords;
      const owner = { _tag: "person" as const, personId: ownerId };
      const { row } = yield* records.create(orgId, system, {
        title: "Invented GST return",
        owner,
        // The last day of January, all day, in India: the next one is the last of February.
        dueAt: Date.parse("2027-01-31T18:29:59.999Z"),
        dueAllDay: true,
        repeat: { every: "month" },
        originKey: "gst",
      });
      for (let attempt = 0; attempt < 3; attempt++)
        yield* records.update(orgId, system, row.key, { state: "done" });
      // Reopened and closed again, it already has its successor.
      yield* records.update(orgId, system, row.key, { state: "open" });
      yield* records.update(orgId, system, row.key, { state: "done" });
      const all = yield* records.query(orgId, { text: "Invented GST return" });
      assert.lengthOf(all.rows, 2);
      const next = all.rows.find((one) => one.recordId !== row.recordId)!;
      assert.strictEqual(next.state, "open");
      assert.strictEqual(next.dueAt, Date.parse("2027-02-28T18:29:59.999Z"));
      assert.deepStrictEqual(next.repeatJson === null ? null : JSON.parse(next.repeatJson).rule, {
        every: "month",
      });
      // An issued invoice closes; its next one is a draft without the number, to be issued.
      yield* defined(1, { template: "invoices" });
      const { row: invoice } = yield* records.create(orgId, system, {
        list: "invoices",
        title: "Invented hosting",
        owner,
        amount: { minor: 236_000, currency: "INR" },
        dueAt: Date.parse("2027-01-31T18:29:59.999Z"),
        dueAllDay: true,
        repeat: { every: "month" },
        originKey: "hosting",
      });
      const issued = yield* OwnerMoney.issue(people, {
        orgId,
        key: KinRecordKey.make(invoice.key),
      });
      yield* records.update(orgId, system, invoice.key, { state: "done" });
      const sql = yield* SqlClient.SqlClient;
      const hosting = yield* sql<{ state: string; number: string | null }>`SELECT state,
          json_extract(fields_json, '$.number') AS number FROM kin_records
        WHERE register_id = 'invoices' AND title = 'Invented hosting' ORDER BY key`;
      assert.deepStrictEqual(
        hosting.map((one) => [one.state, one.number]),
        [
          ["done", issued.number],
          ["open", null],
        ],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("start a numbered entry's next one with no number of its own", () =>
    Effect.gen(function* () {
      yield* seed;
      const records = yield* KinRecords.KinRecords;
      const owner = { _tag: "person" as const, personId: ownerId };
      const writer = { actor: owner, via: "owner" } as const;
      yield* defined(1, { template: "invoices" });
      // Issued elsewhere, so typed with its own number, and billed every month.
      const { row } = yield* records.create(orgId, writer, {
        list: "invoices",
        title: "Invented retainer",
        owner,
        originKey: "retainer",
        fields: { number: "OLD/2026/041" },
        amount: { minor: 4_720_000, currency: "INR" },
        dueAt: Date.parse("2027-01-31T18:29:59.999Z"),
        dueAllDay: true,
        repeat: { every: "month" },
      });
      yield* records.update(orgId, writer, row.key, { state: "done" });
      const sql = yield* SqlClient.SqlClient;
      const all = yield* sql<{ key: string; state: string; fields: string }>`SELECT key, state,
          fields_json AS fields FROM kin_records
        WHERE org_id = ${orgId} AND title = 'Invented retainer' ORDER BY created_at, key`;
      assert.deepStrictEqual(
        all.map((one) => [one.state, JSON.parse(one.fields).number ?? null]),
        [
          ["done", "OLD/2026/041"],
          ["open", null],
        ],
      );
    }).pipe(Effect.provide(layer)),
  );
});

describe("invoices", () => {
  it.effect("reach an agent's dates once each, issue and due day on one row", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* defined(1, { template: "invoices" });
      const asked = yield* turn(3, "Invoice Invented Acme");
      yield* LeadWork.create(scope, {
        sourceEventId: asked,
        records: [
          { list: "clients", title: "Invented Acme" },
          { title: "Invented review", due: "2026-11-21" },
        ],
      });
      // Issued from the 13th, each due a week later, so later invoices issue after earlier fall due.
      yield* LeadWork.create(scope, {
        sourceEventId: asked,
        records: Array.from({ length: 10 }, (_, at) => ({
          list: "invoices",
          title: `Invented retainer ${at + 1}`,
          client: "Invented Acme",
          amount: "10,000",
          date: `2026-11-${13 + at}`,
          due: `2026-11-${20 + at}`,
        })),
      });
      yield* issueAll(...Array.from({ length: 10 }, (_, at) => `INV-${at + 1}`));
      const told = yield* LeadMoney.datesQuery(scope, { from: "2026-11-13", to: "2026-12-11" });
      const invoices = told.dates.filter((one) => one.key.startsWith("INV-"));
      assert.deepStrictEqual([told.total, told.dates.length, invoices.length], [11, 11, 10]);
      assert.deepStrictEqual(
        invoices.map(({ key, issued, due, what, on }) => ({ key, issued, due, what, on })),
        Array.from({ length: 10 }, (_, at) => ({
          key: `INV-${at + 1}`,
          issued: `2026-11-${13 + at}`,
          due: `2026-11-${20 + at}`,
          what: undefined,
          on: undefined,
        })),
      );
      // Anything else is as it was: what the day is, and the day.
      assert.deepStrictEqual(
        told.dates.filter((one) => !one.key.startsWith("INV-")).map(({ what, on }) => [what, on]),
        [["Due", "2026-11-21"]],
      );

      const section = moneySection(yield* OwnerMoney.money(people, { orgId }), "Asia/Kolkata");
      // By their due day, one entry each; Money's dates are money's only, so the review is not here.
      assert.deepStrictEqual(
        section?.next30Days.map((one) => [one.key, one.issued, one.due]),
        Array.from({ length: 10 }, (_, at) => [
          `INV-${at + 1}`,
          `2026-11-${13 + at}`,
          `2026-11-${20 + at}`,
        ]),
      );
      assert.strictEqual(section?.moreDates, undefined);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "an agent's suggestion is owed nowhere, takes no payment or number, and counts once a person with the right keeps it",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
          VALUES ('co-owner', ${orgId}, 'co', 'Co', ${at}, 'co_owner'),
            ('mate', ${orgId}, 'mate', 'Mate', ${at}, 'member')`;
        const inr = (minor: number) => [{ minor, currency: "INR" }];
        const as = (personId: string) => [
          { _tag: "person" as const, orgId, personId: KinPersonId.make(personId) },
        ];
        yield* defined(1, { template: "invoices" });
        const asked = yield* turn(3, "Invoice Invented Orbit");
        yield* LeadWork.create(scope, {
          sourceEventId: asked,
          records: [{ list: "clients", title: "Invented Orbit" }],
        });
        const invoice = (title: string, date: string, suggested?: true) => ({
          list: "invoices",
          title,
          client: "Invented Orbit",
          amount: "47,200",
          date,
          due: "2026-11-01",
          ...(suggested === undefined ? {} : { suggested }),
        });
        // Asked for "issued" by its date or its state, the agent's kept invoice is a draft.
        const made = yield* LeadWork.create(scope, {
          sourceEventId: asked,
          records: [
            { ...invoice("Invented retainer", "2026-10-01"), state: "waiting" },
            invoice("Invented renewal", "2026-10-02", true),
            invoice("Invented second renewal", "2026-10-03", true),
            invoice("Invented third renewal", "2026-10-04", true),
          ],
        });
        assert.include(made.records[0], {
          key: "INV-1",
          state: "open",
          stateLabel: "Draft: waits for the owner or a co-owner to issue it",
        });
        const owed = Effect.gen(function* () {
          const summary = yield* OwnerMoney.money(people, { orgId });
          const page = yield* OwnerWork.list(people, { orgId, list: "invoices", totalsBy: "none" });
          const client = yield* LeadWork.get(scope, { key: "C-1" });
          const outlookView = outlookAnswer(yield* outlook(orgId, NOW));
          const pulse = yield* KinPulse.read({ orgId, at: NOW, viewer: { _tag: "owner" } });
          return {
            owed: summary.owed.total,
            overdue: summary.owed.overdue,
            byClient: summary.owed.byClient.map((one) => one.owed),
            listOwed: page.totals?.owed,
            clientUnpaid: client.owed?.money.unpaid,
            overdueIn: outlookView.overdueNotCounted.map((one) => one.key),
            pulse: pulse.facts
              .filter((fact) => fact.sense === "invoice_overdue")
              .map((fact) => fact.subject.key),
            suggested: (summary.suggested ?? []).map((one) => one.record.key),
            late: page.records
              .filter((one) => one.late)
              .map((one) => one.key)
              .toSorted(),
          };
        });
        const nothingOwed = {
          owed: [],
          overdue: [],
          byClient: [],
          listOwed: [],
          clientUnpaid: [],
          overdueIn: [],
          pulse: [],
          suggested: ["INV-2", "INV-3", "INV-4"],
          // Late is a deadline's, kept or not; no figure counts a suggestion's or a draft's.
          late: ["INV-1", "INV-2", "INV-3", "INV-4"],
        };
        assert.deepStrictEqual(yield* owed, nothingOwed);
        // Nor does asking for it Issued or Paid by its state: the draft stays as it was.
        for (const state of ["waiting", "done"] as const)
          assert.include(
            yield* LeadWork.update(scope, { sourceEventId: asked, key: "INV-1", state }),
            { state: "open", stateLabel: "Draft: waits for the owner or a co-owner to issue it" },
          );
        assert.deepStrictEqual(yield* owed, nothingOwed);
        // Issued by the owner, it has its number and counts.
        yield* OwnerMoney.issue(people, { orgId, key: KinRecordKey.make("INV-1") });
        assert.deepStrictEqual(yield* owed, {
          owed: inr(4_720_000),
          overdue: inr(4_720_000),
          byClient: [inr(4_720_000)],
          listOwed: inr(4_720_000),
          clientUnpaid: ["₹47,200.00"],
          overdueIn: ["INV-1"],
          pulse: ["INV-1"],
          suggested: ["INV-2", "INV-3", "INV-4"],
          late: ["INV-1", "INV-2", "INV-3", "INV-4"],
        });
        // The agent reads it as a suggestion, and it waits on a person with the right.
        assert.include(yield* LeadWork.get(scope, { key: "INV-2" }), {
          suggested: true,
          stateLabel: "Draft, suggested: waits for the owner or a co-owner to keep it",
        });
        const section = moneySection(yield* OwnerMoney.money(people, { orgId }), "Asia/Kolkata");
        assert.deepStrictEqual(
          [section?.owedToUs, section?.suggestedNotKept?.entries.map((one) => one.key)],
          ["₹47,200.00", ["INV-2", "INV-3", "INV-4"]],
        );
        const waits =
          "INV-2 is still a suggestion: the owner or a co-owner hasn't kept it. They keep it with Keep on its page, or by asking you to keep it themselves. Nothing changed.";
        const paid = yield* LeadMoney.payment(scope, {
          sourceEventId: asked,
          key: "INV-2",
          amount: "47,200",
          paidOn: "2026-11-05",
        }).pipe(Effect.flip);
        assert.strictEqual(paid.message, waits);
        const numbered = yield* OwnerMoney.issue(people, {
          orgId,
          key: KinRecordKey.make("INV-2"),
        }).pipe(Effect.flip);
        assert.strictEqual(numbered.message, waits);
        // On a turn nobody asked for, an agent's keep is not one.
        yield* sql`UPDATE kin_wakeups SET status = 'completed' WHERE status = 'running'`;
        yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, model,
            started_at, status, event_ids, audience)
          VALUES ('wake-routine', ${orgId}, ${lead}, 'lead-thread', 'test', 0, 'running',
            '["event-routine"]', 'owner_only')`;
        yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json,
            received_at, queued_at, state, wakeup_id)
          VALUES ('event-routine', ${orgId}, ${lead}, 'schedule.fired', 'P0',
            ${JSON.stringify({ _tag: "schedule.fired" })}, 0, 0, 'claimed', 'wake-routine')`;
        yield* LeadWork.update(scope, {
          sourceEventId: "event-routine",
          key: "INV-2",
          confirmed: true,
        });
        yield* sql`UPDATE kin_wakeups SET status = 'completed' WHERE wakeup_id = 'wake-routine'`;
        yield* sql`UPDATE kin_wakeups SET status = 'running' WHERE wakeup_id = 'wake-3'`;
        const rev = (key: string) =>
          OwnerWork.list(people, { orgId, list: "invoices" }).pipe(
            Effect.map((page) => page.records.find((one) => one.key === key)!.rev),
          );
        for (const tried of [
          OwnerWork.confirm(as("mate"), { orgId, key: "INV-2", rev: yield* rev("INV-2") }),
          OwnerWork.decline(as("mate"), { orgId, key: "INV-2", rev: yield* rev("INV-2") }),
        ]) {
          const refused = yield* Effect.flip(tried);
          assert.deepStrictEqual(
            [refused.reason, refused.message],
            ["not_allowed", "Only the owner or a co-owner can do that in Work."],
          );
        }
        assert.deepStrictEqual((yield* owed).suggested, ["INV-2", "INV-3", "INV-4"]);

        // A co-owner's keep and the owner's each count from then; a decline drops it.
        yield* OwnerWork.confirm(as("co-owner"), { orgId, key: "INV-2", rev: yield* rev("INV-2") });
        yield* OwnerWork.confirm(people, { orgId, key: "INV-3", rev: yield* rev("INV-3") });
        yield* OwnerWork.decline(people, { orgId, key: "INV-4", rev: yield* rev("INV-4") });
        // It started as a draft, so kept it is a draft: owed once it is issued.
        assert.deepStrictEqual((yield* owed).owed, inr(4_720_000));
        const balanceOf = (key: string) =>
          LeadWork.get(scope, { key }).pipe(Effect.map((one) => [one.amount, one.balance]));
        assert.deepStrictEqual(yield* balanceOf("INV-2"), ["₹47,200.00", undefined]);
        for (const key of ["INV-2", "INV-3"])
          yield* OwnerMoney.issue(people, { orgId, key: KinRecordKey.make(key) });
        assert.deepStrictEqual(yield* balanceOf("INV-2"), ["₹47,200.00", "₹47,200.00"]);
        assert.deepStrictEqual(yield* owed, {
          owed: inr(14_160_000),
          overdue: inr(14_160_000),
          byClient: [inr(14_160_000)],
          listOwed: inr(14_160_000),
          clientUnpaid: ["₹1,41,600.00"],
          overdueIn: ["INV-1", "INV-2", "INV-3"],
          pulse: ["INV-1", "INV-2", "INV-3"],
          suggested: [],
          late: ["INV-1", "INV-2", "INV-3"],
        });
        const records = yield* KinRecords.KinRecords;
        assert.strictEqual((yield* records.get(orgId, "INV-4"))!.state, "dropped");
        // An issued invoice is opened by the number on its page too, and named by it.
        const number = String(JSON.parse((yield* records.get(orgId, "INV-2"))!.fieldsJson).number);
        assert.strictEqual((yield* LeadWork.get(scope, { key: number })).key, "INV-2");
        const lines = (yield* LeadWork.get(scope, { key: "C-1" })).owed?.money.invoices ?? [];
        assert.isTrue(lines.some((line) => line.startsWith(`${number} (INV-2): `)));
        yield* LeadMoney.payment(scope, {
          sourceEventId: asked,
          key: "INV-2",
          amount: "47,200",
          paidOn: "2026-11-05",
        });
      }).pipe(Effect.provide(layer)),
  );

  it.effect("take part payments exactly once each, refuse overpaying, and reopen on a void", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* defined(1, { template: "invoices" });
      const asked = yield* turn(3, "Invoice Invented Acme");
      yield* LeadWork.create(scope, {
        sourceEventId: asked,
        records: [{ list: "clients", title: "Invented Acme" }],
      });
      yield* LeadWork.create(scope, {
        sourceEventId: asked,
        records: [
          {
            list: "invoices",
            title: "Invented October retainer",
            client: "Invented Acme",
            amount: "1 lakh",
            date: "2026-10-01",
            due: "2026-11-01",
          },
        ],
      });
      // Issued on the owner's ask, by the agent, so the owner changed nothing it is asked about later.
      yield* LeadDocuments.issue(scope, {
        sourceEventId: asked,
        entry: KinRecordKey.make("INV-1"),
      });
      // Issued and overdue, yet only its due day is late: the day it was issued never is.
      const lateOn = (day: string) =>
        LeadMoney.datesQuery(scope, { from: day, to: day }).pipe(
          Effect.map((told) => told.dates.map((one) => one.late === true)),
        );
      assert.deepStrictEqual(
        [yield* lateOn("2026-10-01"), yield* lateOn("2026-11-01")],
        [[false], [true]],
      );
      const paid = yield* turn(4, "Acme paid 40k");
      const first = yield* LeadMoney.payment(scope, {
        sourceEventId: paid,
        key: "INV-1",
        amount: "40k",
        paidOn: "2026-11-05",
      });
      // The same call again is a retry and records nothing more.
      const again = yield* LeadMoney.payment(scope, {
        sourceEventId: paid,
        key: "INV-1",
        amount: "40k",
        paidOn: "2026-11-05",
      });
      assert.strictEqual(again.paymentId, first.paymentId);
      assert.deepStrictEqual(
        [first.received, first.balance, first.state],
        ["₹40,000.00", "₹60,000.00", "waiting"],
      );
      // The agent recorded it on the owner's message, and the read says so beside the bank.
      const read = yield* LeadWork.get(scope, { key: "INV-1" });
      assert.match(
        read.payments?.[0]?.source ?? "",
        /^recorded by .+ \(you\) on .+ \(owner\)'s word$/,
      );
      assert.deepStrictEqual(read.bank, {
        knownThrough: null,
        note: "No bank statement is confirmed, so Kin can't see what reached the bank.",
      });
      const stored = yield* (yield* KinRecords.KinRecords).detail(
        (yield* (yield* KinRecords.KinRecords).get(orgId, "INV-1"))!,
      );
      assert.deepStrictEqual(stored.payments?.[0]?.source, {
        _tag: "person",
        personId: ownerId,
        agentId: lead,
      });
      const over = yield* LeadMoney.payment(scope, {
        sourceEventId: paid,
        key: "INV-1",
        amount: "60,000.01",
        paidOn: "2026-11-06",
      }).pipe(Effect.flip);
      assert.include(over, { reason: "invalid_state" });

      const summary = yield* OwnerMoney.money(people, { orgId });
      assert.deepStrictEqual(summary.owed.total, [{ minor: 6_000_000, currency: "INR" }]);
      assert.deepStrictEqual(summary.owed.overdue, [{ minor: 6_000_000, currency: "INR" }]);
      assert.strictEqual(summary.owed.byClient[0]!.party?.title, "Invented Acme");
      // Due the 1st, read the 12th in the company's zone: 11 calendar days.
      assert.strictEqual(summary.owed.byClient[0]!.oldestOverdueDays, 11);
      assert.deepStrictEqual(summary.received.thisMonth, [{ minor: 4_000_000, currency: "INR" }]);
      // The morning summary's section carries the same figures, formatted in code.
      const section = moneySection(summary, summary.timeZone);
      assert.deepStrictEqual(
        [section?.owedToUs, section?.byClient[0]?.daysOverdue],
        ["₹60,000.00", 11],
      );
      // "Don't remind me till the 17th": the agent sets it aside on the owner's word. The money
      // an agent reads marks it, by whom and until when, and drops the mark once that day comes.
      const now = yield* Clock.currentTimeMillis;
      yield* KinPulse.aside({
        orgId,
        at: now,
        viewer: { _tag: "owner" },
        by: { _tag: "agent", agentId: lead },
        recordKey: "INV-1",
        action: "set",
        until: now + 5 * 86_400_000,
        note: null,
        holding: { _tag: "may", forPersonId: null, onWordOf: ownerId },
      });
      const parked = (at: number) =>
        setAsideOverdue({ orgId, now: at, viewer: KIN_OWNER_LEVEL }).pipe(
          Effect.map((setAside) => moneySection(summary, summary.timeZone, setAside)),
        );
      const setAside = (yield* parked(now))?.overdueSetAside;
      assert.lengthOf(setAside ?? [], 1);
      assert.deepInclude(setAside?.[0], {
        invoice: "INV-1",
        client: "Invented Acme (C-1)",
        owed: "₹60,000.00",
        daysOverdue: 11,
        until: "2026-11-17",
        by: "Lead lead on Owner's word",
      });
      assert.deepNestedInclude(yield* LeadMoney.money(scope, {}), {
        "summary.overdueSetAside": setAside,
      });
      assert.isUndefined((yield* parked(now + 5 * 86_400_000))?.overdueSetAside);
      yield* KinPulse.aside({
        orgId,
        at: now,
        viewer: { _tag: "owner" },
        by: { _tag: "person", personId: ownerId },
        recordKey: "INV-1",
        action: "lift",
        until: null,
        note: null,
        holding: { _tag: "may", forPersonId: null, onWordOf: null },
      });

      // "Received this month" opens the invoices a payment came in against that month.
      const receivedIn = (paidFrom: string, paidTo: string) =>
        OwnerWork.list(people, { orgId, list: "invoices", paidFrom, paidTo }).pipe(
          Effect.map((page) => page.records.map((one) => one.key)),
        );
      assert.deepStrictEqual(yield* receivedIn("2026-11-01", "2026-11-30"), ["INV-1"]);
      assert.deepStrictEqual(yield* receivedIn("2026-10-01", "2026-10-31"), []);

      const rest = yield* LeadMoney.payment(scope, {
        sourceEventId: paid,
        key: "INV-1",
        amount: "60,000",
        paidOn: "2026-11-06",
      });
      assert.deepStrictEqual([rest.balance, rest.state], ["₹0.00", "done"]);
      yield* LeadMoney.payment(scope, {
        sourceEventId: paid,
        key: "INV-1",
        void: first.paymentId!,
      });
      const records = yield* KinRecords.KinRecords;
      const after = yield* records.get(orgId, "INV-1");
      assert.deepStrictEqual([after!.state, after!.paid], ["waiting", 6_000_000]);
      // The voided payment's own call again is no retry of a live payment: it is refused.
      const voidedRetry = yield* LeadMoney.payment(scope, {
        sourceEventId: paid,
        key: "INV-1",
        amount: "40k",
        paidOn: "2026-11-05",
      }).pipe(Effect.flip);
      assert.include(voidedRetry, { reason: "conflict" });
      assert.strictEqual((yield* records.get(orgId, "INV-1"))!.paid, 6_000_000);

      // A refusal that quotes what is owed or received marks the turn as having read figures.
      const sql = yield* SqlClient.SqlClient;
      const marked = (wakeupId: string) =>
        sql`SELECT 1 FROM kin_wakeup_sensitive_reads WHERE org_id = ${orgId} AND wakeup_id = ${wakeupId}`;
      const fixed = yield* turn(6, "It was only 50k");
      const below = yield* LeadWork.update(scope, {
        sourceEventId: fixed,
        key: "INV-1",
        amount: "50,000",
      }).pipe(Effect.flip);
      assert.include(below, { reason: "invalid_state" });
      assert.include(below.message, "₹60,000.00");
      assert.include(below.message, "Void a payment");
      assert.lengthOf(yield* marked("wake-6"), 1);
      const overpaid = yield* turn(7, "They paid the rest");
      yield* LeadMoney.payment(scope, {
        sourceEventId: overpaid,
        key: "INV-1",
        amount: "50,000",
        paidOn: "2026-11-07",
      }).pipe(Effect.flip);
      assert.lengthOf(yield* marked("wake-7"), 1);
      // An amount down to what was received is paid; up again, it is owed again.
      for (const [amount, state] of [
        ["60,000", "done"],
        ["70,000", "waiting"],
      ] as const) {
        const changed = yield* LeadWork.update(scope, {
          sourceEventId: overpaid,
          key: "INV-1",
          amount,
        });
        assert.strictEqual(changed.state, state);
      }
      // A state given with a new amount can't contradict the balance; Draft and Void still can be.
      for (const [minor, given, outcome] of [
        [8_000_000, "done", "₹20,000.00 owed"],
        [6_000_000, "waiting", "fully paid"],
        [8_000_000, "open", "open"],
        [7_000_000, "waiting", "waiting"],
      ] as const) {
        const update = records.update(orgId, system, "INV-1", {
          amount: { minor, currency: "INR" },
          state: given,
        });
        if (outcome === given) assert.strictEqual((yield* update).state, outcome);
        else assert.include((yield* Effect.flip(update)).message, outcome);
      }
      const kept = yield* records.get(orgId, "INV-1");
      assert.deepStrictEqual([kept!.state, kept!.amountMinor], ["waiting", 7_000_000]);

      // A payment retried with any detail changed is refused, the currency included.
      const once = {
        amount: { minor: 100, currency: "INR" },
        paidOn: "2026-11-08",
        originKey: "x",
      };
      yield* records.pay(orgId, system, "INV-1", once);
      for (const changed of [
        { ...once, amount: { minor: 100, currency: "USD" } },
        { ...once, note: "Another" },
      ])
        assert.include(yield* Effect.flip(records.pay(orgId, system, "INV-1", changed)), {
          reason: "not_allowed",
        });
      assert.strictEqual((yield* records.pay(orgId, system, "INV-1", once)).row.paid, 6_000_100);

      // F20: "paid ₹1,00,000, deducted ₹18,000 TDS" is one settlement: cash, and tax withheld.
      yield* LeadWork.create(scope, {
        sourceEventId: overpaid,
        records: [
          {
            list: "invoices",
            title: "Invented November retainer",
            client: "Invented Acme",
            amount: "1,18,000",
            date: "2026-11-08",
          },
        ],
      });
      yield* LeadDocuments.issue(scope, {
        sourceEventId: overpaid,
        entry: KinRecordKey.make("INV-2"),
      });
      const unsettled = yield* OwnerMoney.money(people, { orgId });
      const tds = {
        sourceEventId: overpaid,
        key: "INV-2",
        amount: "1,00,000",
        withheld: "18,000",
        paidOn: "2026-11-09",
      };
      const settled = yield* LeadMoney.payment(scope, tds);
      assert.deepStrictEqual(
        [settled.received, settled.tdsWithheld, settled.balance, settled.state],
        ["₹1,00,000.00", "₹18,000.00", "₹0.00", "done"],
      );
      const retried = yield* LeadMoney.payment(scope, tds);
      assert.deepStrictEqual(
        [retried.paymentId, retried.tdsPaymentId],
        [settled.paymentId, settled.tdsPaymentId],
      );

      const settledMoney = yield* OwnerMoney.money(people, { orgId });
      const minor = (money: ReadonlyArray<{ readonly minor: number }>) => money[0]?.minor ?? 0;
      assert.deepStrictEqual(
        [
          minor(settledMoney.received.thisMonth) - minor(unsettled.received.thisMonth),
          settledMoney.tdsDeducted?.thisMonth,
        ],
        [10_000_000, [{ minor: 1_800_000, currency: "INR" }]],
      );
      // More than is owed records neither part.
      yield* LeadWork.create(scope, {
        sourceEventId: overpaid,
        records: [
          {
            list: "invoices",
            title: "Invented extra",
            client: "Invented Acme",
            amount: "1,000",
            date: "2026-11-08",
          },
        ],
      });
      yield* LeadDocuments.issue(scope, {
        sourceEventId: overpaid,
        entry: KinRecordKey.make("INV-3"),
      });
      yield* LeadMoney.payment(scope, {
        ...tds,
        key: "INV-3",
        amount: "900",
        withheld: "101",
      }).pipe(Effect.flip);
      assert.strictEqual((yield* records.get(orgId, "INV-3"))!.paid, 0);
      // Review 45: ₹900 and ₹100 TDS, retried as ₹900 and ₹101, is refused: TDS stays ₹100.
      yield* LeadWork.create(scope, {
        sourceEventId: overpaid,
        records: [
          {
            list: "invoices",
            title: "Invented part",
            client: "Invented Acme",
            amount: "2,000",
            date: "2026-11-08",
          },
        ],
      });
      yield* LeadDocuments.issue(scope, {
        sourceEventId: overpaid,
        entry: KinRecordKey.make("INV-4"),
      });
      const part = { ...tds, key: "INV-4", amount: "900", withheld: "100" };
      yield* LeadMoney.payment(scope, part);
      for (const changed of [{ withheld: "101" }, { amount: "901" }, { withheld: undefined }])
        assert.include(yield* LeadMoney.payment(scope, { ...part, ...changed }).pipe(Effect.flip), {
          reason: "not_allowed",
        });
      const parted = (yield* records.get(orgId, "INV-4"))!;
      assert.deepStrictEqual([parted.paid, parted.withheld], [100_000, 10_000]);

      // K085: an invoice with no issue day and no number is a Draft, and nothing is owed on it.
      const owedBefore = (yield* OwnerMoney.money(people, { orgId })).owed.total;
      yield* LeadWork.create(scope, {
        sourceEventId: overpaid,
        records: [
          { list: "invoices", title: "Invented draft", client: "Invented Acme", amount: "5,000" },
        ],
      });
      assert.strictEqual((yield* records.get(orgId, "INV-5"))!.state, "open");
      assert.deepStrictEqual((yield* OwnerMoney.money(people, { orgId })).owed.total, owedBefore);
      // K234: issued after its own due day reads like a slip, until the agent says it is right.
      const backwards = {
        list: "invoices",
        title: "Invented backwards",
        client: "Invented Acme",
        amount: "3,000",
        date: "2026-11-09",
        due: "2026-11-01",
      };
      assert.include(
        (yield* LeadWork.create(scope, { sourceEventId: overpaid, records: [backwards] }).pipe(
          Effect.flip,
        )).message,
        "An invoice issued 2026-11-09 can't fall due 2026-11-01, before it.",
      );
      yield* LeadWork.create(scope, {
        sourceEventId: overpaid,
        records: [{ ...backwards, confirmed: true }],
      });
      yield* LeadDocuments.issue(scope, {
        sourceEventId: overpaid,
        entry: KinRecordKey.make("INV-6"),
      });

      // K150: an invoice for 0 is refused on the owner's own path too.
      const ownerEdit = (amount: { minor: number; currency: string }) =>
        Effect.gen(function* () {
          const row = yield* records.get(orgId, "INV-5");
          return yield* OwnerWork.update(people, { orgId, key: "INV-5", rev: row!.rev, amount });
        });
      assert.include(
        (yield* Effect.flip(ownerEdit({ minor: 0, currency: "INR" }))).message,
        "An invoice for 0 isn't owed; leave the amount off or drop it.",
      );
      // An agent's figure a thousand times the largest invoice is checked first...
      assert.include(
        (yield* LeadWork.update(scope, {
          sourceEventId: overpaid,
          key: "INV-4",
          amount: "900 crore",
        }).pipe(Effect.flip)).message,
        "is far above anything in Invoices",
      );

      // ...while the owner typed theirs, so it is not asked again.
      assert.strictEqual(
        (yield* ownerEdit({ minor: 900_000_000_000, currency: "INR" })).amount?.minor,
        900_000_000_000,
      );
      // K086: a client with money owed can't be dropped, and the refusal names what is unpaid.
      const dropped = yield* LeadWork.update(scope, {
        sourceEventId: overpaid,
        key: "C-1",
        state: "dropped",
      }).pipe(Effect.flip);
      assert.strictEqual(
        dropped.message,
        "C-1 still owes on 4 unpaid invoices: INV-1 (₹9,999.00 owed), INV-6 (₹3,000.00 owed), INV-3 (₹1,000.00 owed), INV-4 (₹1,000.00 owed). Record their payments or void them first.",
      );
      assert.strictEqual((yield* records.get(orgId, "C-1"))!.state, "open");

      // W-18: an invoice dated ahead with no number hasn't gone out, so it is a Draft, not owed.
      const owedNow = (yield* OwnerMoney.money(people, { orgId })).owed.total;
      yield* LeadWork.create(scope, {
        sourceEventId: overpaid,
        records: [
          {
            list: "invoices",
            title: "Invented December retainer",
            client: "Invented Acme",
            amount: "8,000",
            date: "2026-12-01",
            due: "2026-12-15",
          },
        ],
      });
      assert.strictEqual((yield* records.get(orgId, "INV-7"))!.state, "open");
      assert.deepStrictEqual((yield* OwnerMoney.money(people, { orgId })).owed.total, owedNow);
      assert.notInclude(
        (yield* outlook(orgId, NOW)).incoming.map((one) => one.key),
        "INV-7",
      );
      // People's Money leaves a draft out of its dates (S9); an agent's dates read its day as "Date".
      const december = yield* OwnerMoney.dates(people, {
        orgId,
        from: "2026-12-01T00:00:00.000Z",
        to: "2026-12-31T00:00:00.000Z",
      });
      assert.notInclude(
        december.rows.map((one) => one.record.key),
        "INV-7",
      );
      const told = yield* LeadMoney.datesQuery(scope, { from: "2026-12-01", to: "2026-12-31" });
      assert.deepStrictEqual(
        told.dates
          .filter((one) => one.key === "INV-7")
          .map((one) => [one.date !== undefined, one.issued, one.due !== undefined]),
        [[true, undefined, true]],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "issue consecutive numbers per financial year, once per entry, kept when voided, never by an agent",
    () =>
      Effect.gen(function* () {
        yield* seed;
        yield* defined(1, { template: "invoices" });
        const asked = yield* turn(3, "Draft five invoices for Invented Acme");
        yield* LeadWork.create(scope, {
          sourceEventId: asked,
          records: [
            { list: "clients", title: "Invented Acme" },
            ...[1, 2, 3, 4, 5].map((n) => ({
              list: "invoices",
              title: `Invented retainer ${n}`,
              client: "Invented Acme",
              amount: "1 lakh",
              state: "open" as const,
            })),
          ],
        });
        const own = yield* LeadWork.update(scope, {
          sourceEventId: asked,
          key: "INV-1",
          fields: { number: "INV/26-27/999" },
        }).pipe(Effect.flip);
        assert.include(own.message, "when they are issued");
        // A draft isn't owed yet, so a payment on it waits for its number.
        const unissued = yield* OwnerMoney.recordPayment(people, {
          orgId,
          key: "INV-1",
          amount: { minor: 100_000, currency: "INR" },
          paidOn: "2026-11-05",
          clientRequestId: "on-a-draft",
        }).pipe(Effect.flip);
        assert.include(unissued, { reason: "invalid_state" });
        assert.include(unissued.message, "Issue it first");
        // The agent's payment on a draft is refused by the same rule, and writes nothing.
        const agentPays = LeadMoney.payment(scope, {
          sourceEventId: asked,
          key: "INV-1",
          amount: "1,000",
          paidOn: "2026-11-05",
        });
        const refused = yield* Effect.flip(agentPays);
        assert.include(refused, { reason: "invalid_state" });
        assert.strictEqual(
          refused.message,
          "INV-1 is a draft, so nothing is owed on it yet. Issue it first with kin_issue, which takes its date as the issue day (else today; set date with record_update first if the owner gave another), then record the payment.",
        );
        const sql = yield* SqlClient.SqlClient;
        const paymentsOn = sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_record_payments p
          JOIN kin_records r ON r.org_id = p.org_id AND r.record_id = p.record_id
          WHERE p.org_id = ${orgId} AND r.key = 'INV-1'`;
        assert.deepStrictEqual(yield* paymentsOn, [{ n: 0 }]);
        // Two issues at once get consecutive numbers, one each.
        const both = yield* Effect.all(
          [
            OwnerMoney.issue(people, { orgId, key: "INV-1" }),
            OwnerMoney.issue(people, { orgId, key: "INV-2" }),
          ],
          { concurrency: 2 },
        );
        assert.deepStrictEqual(both.map((one) => one.number).toSorted(), [
          "INV/26-27/001",
          "INV/26-27/002",
        ]);
        assert.deepStrictEqual(
          both.map((one) => [one.state, one.issued]),
          [
            ["waiting", true],
            ["waiting", true],
          ],
        );
        const first = both.find((one) => one.key === "INV-1")!;
        // Issued, the same payment is recorded, once.
        assert.strictEqual((yield* agentPays).received, "₹1,000.00");
        yield* agentPays;
        assert.deepStrictEqual(yield* paymentsOn, [{ n: 1 }]);
        // A failed build is retried with the number it was given; asking again issues nothing.
        const again = yield* OwnerMoney.issue(people, { orgId, key: "INV-1" });
        assert.deepStrictEqual(again, { ...first, issued: false });
        const changed = yield* (yield* KinRecords.KinRecords)
          .update(orgId, OwnerWork.ownerWriter(people[0]!), "INV-1", {
            fields: { number: "INV/26-27/777" },
          })
          .pipe(Effect.flip);
        assert.include(changed.message, "never changes");
        // Issue's confirmation reads the number it would give, taking none.
        const preview = () => OwnerMoney.nextNumber(people, { orgId, key: "INV-3" });
        assert.deepStrictEqual(
          [yield* preview(), yield* preview()].map((one) => one.number),
          ["INV/26-27/003", "INV/26-27/003"],
        );
        assert.isNull((yield* OwnerMoney.nextNumber(people, { orgId, key: "INV-1" })).number);
        assert.include(
          yield* Effect.flip(
            OwnerMoney.nextNumber([{ ...people[0]!, personId: KinPersonId.make("someone") }], {
              orgId,
              key: "INV-3",
            }),
          ),
          { reason: "not_allowed" },
        );
        // Voided, it keeps its number, and the next one is never that number again.
        const voided = yield* OwnerMoney.voidEntry(people, { orgId, key: "INV-1" });
        assert.deepStrictEqual([voided.state, voided.number], ["dropped", first.number]);
        // Undoing the void makes it owed again with that number; paid in full, it is paid.
        const back = yield* OwnerMoney.unvoidEntry(people, { orgId, key: "INV-1" });
        assert.deepStrictEqual([back.state, back.number], ["waiting", first.number]);
        yield* OwnerMoney.recordPayment(people, {
          orgId,
          key: "INV-2",
          amount: { minor: 10_000_000, currency: "INR" },
          paidOn: "2026-11-12",
          clientRequestId: "paid-2",
        });
        yield* OwnerMoney.voidEntry(people, { orgId, key: "INV-2" });
        const paid = yield* OwnerMoney.unvoidEntry(people, { orgId, key: "INV-2" });
        assert.deepStrictEqual([paid.state, paid.number], ["done", "INV/26-27/002"]);
        yield* OwnerMoney.voidEntry(people, { orgId, key: "INV-1" });
        const third = yield* OwnerMoney.issue(people, { orgId, key: "INV-3" });
        assert.strictEqual(third.number, "INV/26-27/003");
        // The series follows India's financial year in the owner's zone.
        yield* TestClock.setTime(Date.parse("2027-03-31T18:29:59.000Z"));
        const march = yield* OwnerMoney.issue(people, { orgId, key: "INV-4" });
        yield* TestClock.setTime(Date.parse("2027-03-31T18:30:00.000Z"));
        const april = yield* OwnerMoney.issue(people, { orgId, key: "INV-5" });
        assert.deepStrictEqual([march.number, april.number], ["INV/26-27/004", "INV/27-28/001"]);
        const records = yield* KinRecords.KinRecords;
        const row = yield* records.get(orgId, "INV-5");
        assert.include(row!.fieldsJson, "INV/27-28/001");
        // F22: dated before one issued already, it still takes the next number, and says so.
        yield* LeadWork.create(scope, {
          sourceEventId: asked,
          records: [
            {
              list: "invoices",
              title: "Invented March work",
              client: "Invented Acme",
              amount: "1 lakh",
              state: "open",
              date: "2027-03-20",
            },
          ],
        });
        const backdated = yield* OwnerMoney.issue(people, { orgId, key: "INV-6" });
        const notice =
          "INV/27-28/002 is dated 20 Mar 2027, before INV/27-28/001 (1 Apr 2027), which was issued first: its number comes after entries dated later.";
        assert.deepStrictEqual([backdated.number, backdated.notice], ["INV/27-28/002", notice]);
        assert.strictEqual((yield* records.get(orgId, "INV-6"))!.notes, notice);
        // Kin's own words, written as Kin's: not the owner's, whatever the list calls its entries.
        assert.deepStrictEqual(
          yield* sql`SELECT c.actor_kind AS kind FROM kin_record_changes c
            JOIN kin_records r ON r.org_id = c.org_id AND r.record_id = c.record_id
            WHERE r.org_id = ${orgId} AND r.key = 'INV-6' AND c.fields_json LIKE '%"notes"%'`,
          [{ kind: "system" }],
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "file a project's invoices under it however they are made, and count them against it",
    () =>
      Effect.gen(function* () {
        yield* seed;
        yield* defined(1, { template: "invoices" });
        yield* defined(3, { template: "quotes" });
        yield* defined(7, { template: "receipts" });
        const records = yield* KinRecords.KinRecords;
        const owner: KinRecords.Writer = {
          actor: { _tag: "person", personId: ownerId },
          via: "owner",
        };
        const asked = yield* turn(5, "Set up Acme's work and bill it");
        yield* LeadWork.create(scope, {
          sourceEventId: asked,
          records: [{ list: "clients", title: "Invented Acme" }],
        });
        const projects = yield* LeadWork.create(scope, {
          sourceEventId: asked,
          records: [
            { list: "projects", title: "Invented site", client: "Invented Acme", value: "1 lakh" },
            {
              list: "projects",
              title: "Invented retainer",
              client: "Invented Acme",
              billing: "retainer",
              value: "20,000",
            },
          ],
        });
        const site = (yield* records.get(orgId, projects.records[0]!.key))!;
        const retainer = (yield* records.get(orgId, projects.records[1]!.key))!;
        const made = yield* LeadWork.create(scope, {
          sourceEventId: asked,
          records: [
            {
              list: "quotes",
              title: "Invented site quote",
              client: "Invented Acme",
              project: site.key,
              amount: "1,00,000",
              state: "done",
            },
            {
              list: "invoices",
              title: "Invented site deposit",
              client: "Invented Acme",
              project: site.key,
              amount: "30,000",
              date: "2026-11-10",
              state: "waiting",
            },
            {
              list: "invoices",
              title: "Invented retainer November",
              client: "Invented Acme",
              project: "Invented retainer",
              amount: "20,000",
              date: "2026-11-01",
              due: "2026-11-15",
              state: "waiting",
              repeat: { every: "month" },
            },
            {
              list: "receipts",
              title: "Invented site deposit received",
              client: "Invented Acme",
              project: site.key,
              amount: "30,000",
              date: "2026-11-12",
            },
          ],
        });
        const [quote, deposit, monthly] = made.records.map((one) => one.key);
        yield* issueAll(deposit!);
        // From the project's quote, from the agent that named it, and the retainer's next one.
        const { entry: invoiced } = yield* Quotes.invoiceFromQuote(orgId, owner, quote!);
        yield* records.update(orgId, owner, monthly!, { state: "done" });
        const next = (yield* records.query(orgId, { list: "invoices" })).rows.find(
          (one) => one.title === "Invented retainer November" && one.key !== monthly,
        );
        assert.deepStrictEqual(
          [(yield* records.get(orgId, deposit!))?.projectId, invoiced.projectId, next?.projectId],
          [site.recordId, site.recordId, retainer.recordId],
        );
        // A receipt is Draft until numbered, yet its money arrived, so it counts.
        assert.deepStrictEqual((yield* moneyOf(orgId, site.recordId, KIN_OWNER_LEVEL)).received, [
          { minor: 3_000_000, currency: "INR" },
        ]);
        // The quote's invoice is a draft until issued, so only the deposit counts so far.
        assert.deepStrictEqual(
          [
            (yield* moneyOf(orgId, site.recordId, KIN_OWNER_LEVEL)).invoiced,
            (yield* moneyOf(orgId, retainer.recordId, KIN_OWNER_LEVEL)).invoiced,
            yield* ownerLevelStillToInvoice(orgId),
          ],
          [
            [{ minor: 3_000_000, currency: "INR" }],
            [{ minor: 2_000_000, currency: "INR" }],
            [
              {
                project: `${site.key} Invented site (Invented Acme)`,
                stillToInvoice: "₹70,000.00",
                agreed: "₹1,00,000.00, from accepted quotes",
                invoicedSoFar: "₹30,000.00",
              },
            ],
          ],
        );
      }).pipe(Effect.provide(layer)),
  );
});

describe("the owner's taps", () => {
  const inr = (minor: number) => [{ minor, currency: "INR" }];

  it.effect("edit every kind of detail, checked as an agent's are, and log each change", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* defined(1, {
        name: "Vendor bills",
        prefix: "VB",
        amount: true,
        categories: ["rent", "gst"],
        fields: [
          { label: "Reference", type: "text" },
          { label: "Mode", type: "choice", choices: ["card", "upi"] },
          { label: "Paid day", type: "date" },
          { label: "Approver", type: "person" },
          { label: "For client", type: "link", link: "clients" },
          { label: "Tax", type: "money" },
          { label: "Bill", type: "file" },
        ],
      });
      const asked = yield* turn(3, "A bill", ["bill.pdf"]);
      yield* LeadWork.create(scope, {
        sourceEventId: asked,
        records: [{ list: "clients", title: "Invented Acme" }],
      });
      const made = yield* LeadWork.create(scope, {
        sourceEventId: asked,
        records: [{ list: "vendor_bills", title: "Invented rent", amount: "50,000" }],
      });
      const key = made.records[0]!.key;
      const records = yield* KinRecords.KinRecords;
      const client = (yield* records.query(orgId, { list: "clients" })).rows[0]!;
      const edit = (patch: Omit<Parameters<typeof OwnerWork.update>[1], "orgId" | "key" | "rev">) =>
        Effect.gen(function* () {
          const row = yield* records.get(orgId, key);
          return yield* OwnerWork.update(people, { orgId, key, rev: row!.rev, ...patch });
        });
      const fields = {
        reference: "Q3 lease",
        mode: "upi",
        paidDay: "2026-11-10",
        approver: `person:${ownerId}`,
        forClient: client.recordId,
        tax: { minor: 900_000, currency: "INR" },
        bill: ["att-3-0"],
      };
      const saved = yield* edit({
        listCategory: "gst" as never,
        amount: { minor: 6_000_000, currency: "INR" },
        party: client.key,
        fields,
      });
      assert.deepStrictEqual(
        [saved.listCategory, saved.amount, saved.party?.key, saved.fields],
        ["gst", { minor: 6_000_000, currency: "INR" }, client.key, fields],
      );
      assert.deepStrictEqual(
        saved.files?.map((file) => file.name),
        ["bill.pdf"],
      );
      const logged = saved.changes[0]!;
      assert.strictEqual(logged.via, "owner");
      assert.deepInclude(logged.fields, { field: "tax", from: null, to: "₹9,000.00" });
      assert.deepInclude(logged.fields, { field: "category", from: null, to: "gst" });

      // F54: a date field keeps a time, and its days are on All dates under the list's name.
      const timed = yield* edit({ fields: { paidDay: "2026-11-18T15:00" } });
      assert.strictEqual(timed.fields?.paidDay, "2026-11-18T15:00");
      const onDates = (from: string, to: string) =>
        OwnerMoney.dates(people, { orgId, from, to }).pipe(
          Effect.map(({ rows, total }) => ({
            total,
            rows: rows
              .filter((row) => row.field !== undefined)
              .map(({ record, label, field, at, allDay }) => ({
                key: record.key,
                label,
                field,
                at,
                allDay,
              })),
          })),
        );
      const shown = yield* onDates("2026-11-18T00:00:00.000Z", "2026-11-19T00:00:00.000Z");
      assert.deepStrictEqual(shown.rows, [
        { key, label: "Paid day", field: "paidDay", at: "2026-11-18T09:30:00.000Z", allDay: false },
      ]);
      assert.deepStrictEqual(
        (yield* onDates("2026-11-18T09:31:00.000Z", "2026-11-19T00:00:00.000Z")).rows,
        [],
      );
      yield* edit({ fields: { paidDay: "2026-11-10" } });

      // A file on a message in a chat the owner is not in is not the owner's to keep.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
        VALUES ('elsewhere-chat', ${orgId}, 'direct', 'a:b', 1, ${at})`;
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
        VALUES ('mate', ${orgId}, 'mate', 'Mate', ${at})`;
      yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind,
          person_id, role, joined_at)
        VALUES ('else-mate', ${orgId}, 'elsewhere-chat', 'person', 'mate', 'member', ${at})`;
      yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind,
          author_person_id, author_member_id, author_role, kind, body, mentions_json, status,
          created_at, attachments_json)
        VALUES ('msg-else', ${orgId}, 'elsewhere-chat', 1, 'human', 'mate', 'else-mate', 'member',
          'text', 'x', '[]', 'posted', ${at},
          ${JSON.stringify([{ type: "file", id: "att-else", name: "payroll.pdf", mimeType: "application/pdf", sizeBytes: 9 }])})`;
      yield* sql`INSERT INTO kin_message_attachments (attachment_id, org_id, chat_id, message_id)
        VALUES ('att-else', ${orgId}, 'elsewhere-chat', 'msg-else')`;
      for (const [patch, reason] of [
        [{ fields: { mode: "cheque" } }, "invalid_state"],
        [{ fields: { paidDay: "2026-02-30" } }, "invalid_state"],
        [{ fields: { approver: "person:nobody" } }, "not_found"],
        [{ fields: { forClient: "rec_nope" } }, "not_found"],
        [{ fields: { tax: { minor: 1, currency: "ZZZ" } } }, "invalid_state"],
        [{ fields: { bill: ["att-none"] } }, "not_found"],
        [{ fields: { bill: ["att-3-0", "att-else"] } }, "not_found"],
        [{ fields: { vendor: "No such field" } }, "invalid_state"],
        [{ listCategory: "travel" as never }, "invalid_state"],
      ] as const)
        assert.include(yield* Effect.flip(edit(patch)), { reason }, JSON.stringify(patch));
      // The picker offers only what would be accepted.
      const offered = yield* OwnerMoney.files(people, { orgId });
      assert.deepStrictEqual(
        offered.files.map((file) => file.name),
        ["bill.pdf"],
      );
      assert.lengthOf((yield* OwnerMoney.files(people, { orgId, text: "BILL" })).files, 1);
      assert.lengthOf((yield* OwnerMoney.files(people, { orgId, text: "payroll" })).files, 0);
      // A teammate who joined after the bill was sent is never offered it; the owner still is.
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
        VALUES ('teammate', ${orgId}, 'teammate', 'Teammate', ${at})`;
      yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind,
          person_id, role, joined_at, joined_seq)
        VALUES ('lead-chat-teammate', ${orgId}, 'lead-chat', 'person', 'teammate', 'member', ${at}, 4)`;
      yield* turn(5, "The new bill", ["later.pdf"]);
      const names = (personId: string) =>
        OwnerMoney.readableFiles(orgId, personId, {}).pipe(
          Effect.map((page) => page.files.map((file) => file.name).toSorted()),
        );
      assert.deepStrictEqual(yield* names("teammate"), ["later.pdf"]);
      assert.deepStrictEqual(yield* names(ownerId), ["bill.pdf", "later.pdf"]);

      const cleared = yield* edit({ listCategory: null, fields: { bill: null, mode: null } });
      assert.deepStrictEqual(
        [cleared.listCategory, cleared.files, cleared.fields?.mode, cleared.fields?.reference],
        [undefined, undefined, undefined, "Q3 lease"],
      );
      // Work's own entries have no details of this kind.
      const task = yield* OwnerWork.create(people, {
        orgId,
        title: "A task",
        clientRequestId: "t",
      });
      assert.include(
        yield* Effect.flip(
          OwnerWork.update(people, {
            orgId,
            key: task.key,
            rev: task.rev,
            fields: { reference: "x" },
          }),
        ),
        { reason: "invalid_state" },
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("settle an invoice from its balance when the amount is edited", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* defined(1, { template: "invoices" });
      const asked = yield* turn(3, "Invoice");
      yield* LeadWork.create(scope, {
        sourceEventId: asked,
        records: [
          { list: "invoices", title: "Invented retainer", amount: "1 lakh", date: "2026-11-01" },
        ],
      });
      yield* issueAll("INV-1");
      yield* OwnerMoney.recordPayment(people, {
        orgId,
        key: "INV-1",
        amount: { minor: 4_000_000, currency: "INR" },
        paidOn: "2026-11-05",
        clientRequestId: "p1",
      });
      const records = yield* KinRecords.KinRecords;
      const amount = (minor: number) =>
        Effect.gen(function* () {
          const row = yield* records.get(orgId, "INV-1");
          return yield* OwnerWork.update(people, {
            orgId,
            key: "INV-1",
            rev: row!.rev,
            amount: { minor, currency: "INR" },
          });
        });
      const below = yield* Effect.flip(amount(3_000_000));
      assert.include(below, { reason: "invalid_state" });
      assert.include(below.message, "₹40,000.00");
      // The owner is told what to do in the app's words, not an agent tool's.
      assert.notInclude(below.message, "payment_record");
      assert.deepStrictEqual(
        [(yield* amount(4_000_000)).state, (yield* amount(9_000_000)).state],
        ["done", "waiting"],
      );
      assert.deepStrictEqual(
        (yield* records.detail((yield* records.get(orgId, "INV-1"))!)).balance,
        {
          minor: 5_000_000,
          currency: "INR",
        },
      );
      // The owner's cash and the TDS the client kept settle it together, as one payment form.
      const settled = yield* OwnerMoney.recordPayment(people, {
        orgId,
        key: "INV-1",
        amount: { minor: 4_000_000, currency: "INR" },
        tds: { minor: 1_000_000, currency: "INR" },
        paidOn: "2026-11-06",
        clientRequestId: "p2",
      });
      assert.strictEqual(settled.state, "done");
      assert.deepStrictEqual(
        settled.payments
          ?.map((payment) => `${payment.amount.minor}${payment.withheld === true ? " TDS" : ""}`)
          .toSorted(),
        ["1000000 TDS", "4000000", "4000000"],
      );
      // Each is the owner's own tap, and Kin can't see a bank it has no statement of.
      assert.deepStrictEqual(
        settled.payments?.map((payment) => payment.source),
        [1, 2, 3].map(() => ({ _tag: "person" as const, personId: ownerId })),
      );
      assert.deepStrictEqual(settled.bankKnown, { through: null });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("sends only list definition features the caller accepts", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* defined(1, { template: "expenses" });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE kin_registers SET definition_json = json_set(definition_json,
        '$.fields', json(${JSON.stringify([
          { key: "count", label: "Count", type: "number", sensitive: false },
          { key: "checked", label: "Checked", type: "yesno", sensitive: false },
          {
            key: "shelf",
            label: "Shelf",
            type: "link",
            link: "list",
            linkList: "shelves",
            sensitive: false,
          },
          { key: "client", label: "Client", type: "link", link: "clients", sensitive: false },
          { key: "reviewOn", label: "Review on", type: "date", sensitive: false },
        ])}), '$.remindOn', 'reviewOn', '$.check', json('{"field":"count","below":2}'))
        WHERE org_id = ${orgId} AND register_id = 'expenses'`;
      const read = (accept?: ReadonlyArray<string>) =>
        OwnerMoney.lists(people, { orgId, accept }).pipe(
          Effect.map(({ lists }) => lists.find(({ list }) => list === "expenses")),
        );

      const legacy = yield* read();
      assert.deepStrictEqual(
        legacy?.fields.map(({ type }) => type),
        ["text", "text", "link", "date"],
      );
      assert.strictEqual(legacy?.fields.find(({ key }) => key === "client")?.link, "clients");
      assert.notProperty(legacy, "remindOn");
      assert.notProperty(legacy, "check");

      const partial = yield* read(["number"]);
      assert.deepStrictEqual(
        partial?.fields.map(({ type }) => type),
        ["number", "text", "link", "date"],
      );

      const current = yield* read(["number", "yesno", "list", "remindOn", "check"]);
      assert.deepStrictEqual(
        current?.fields.map(({ type }) => type),
        ["number", "yesno", "link", "link", "date"],
      );
      assert.include(
        current?.fields.find(({ key }) => key === "shelf"),
        { link: "list", linkList: "shelves" },
      );
      assert.strictEqual(current?.remindOn, "reviewOn");
      assert.deepStrictEqual(current?.check, { field: "count", below: 2 });
      const def = (yield* listDef(orgId, "expenses"))!;
      const unexpected = () => Effect.die("A read-only field must not reach a resolver");
      const readOnly: ReadonlyArray<Readonly<Record<string, string>>> = [
        { count: "42" },
        { checked: "No" },
        { shelf: "SH-1" },
      ];
      for (const fields of readOnly) {
        assert.include(checkFields(def, fields), { reason: "invalid_state" });
        assert.include(
          yield* Effect.flip(
            typedFields(def, fields, { who: unexpected, ref: unexpected, files: unexpected }),
          ),
          { reason: "invalid_state" },
        );
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("pay any list over time once its definition says so, and only then", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* defined(1, { template: "expenses" });
      yield* defined(3, { template: "invoices" });
      const asked = yield* turn(5, "Rent is due");
      yield* LeadWork.create(scope, {
        sourceEventId: asked,
        records: [
          { list: "expenses", title: "Invented rent", amount: "1 lakh", state: "open" },
          { list: "expenses", title: "Invented taxi", amount: "500", date: "2026-11-10" },
        ],
      });
      const pay = (minor: number, id: string) =>
        OwnerMoney.recordPayment(people, {
          orgId,
          key: "EXP-1",
          amount: { minor, currency: "INR" },
          paidOn: "2026-11-05",
          clientRequestId: id,
        });
      const totals = OwnerWork.list(people, { orgId, list: "expenses", totalsBy: "none" }).pipe(
        Effect.map((page) => page.totals),
      );
      // Without the flag a list is as it was: no payments, no balance, no "still owed".
      assert.include(yield* Effect.flip(pay(4_000_000, "a")), { reason: "invalid_state" });
      assert.strictEqual((yield* totals)?.owed, undefined);
      const lists = () =>
        OwnerMoney.lists(people, { orgId }).pipe(
          Effect.map((all) => all.lists.find((one) => one.list === "expenses")!),
        );
      assert.strictEqual((yield* lists()).payments, undefined);
      const flagged = yield* OwnerMoney.updateList(people, {
        orgId,
        list: "expenses",
        rev: (yield* lists()).rev,
        payments: true,
      });
      assert.strictEqual(flagged.payments, true);

      const part = yield* pay(4_000_000, "a");
      assert.deepStrictEqual(
        [part.state, part.balance, part.payments?.length],
        ["open", { minor: 6_000_000, currency: "INR" }, 1],
      );
      assert.deepStrictEqual(
        [(yield* totals)?.total, (yield* totals)?.owed],
        [inr(10_050_000), inr(6_000_000)],
      );
      const full = yield* pay(6_000_000, "b");
      assert.deepStrictEqual([full.state, full.balance?.minor], ["done", 0]);
      // Taken back, it is owed again in the state this list has for that.
      const back = yield* OwnerMoney.voidPayment(people, {
        orgId,
        key: "EXP-1",
        paymentId: part.payments![0]!.paymentId,
      });
      assert.deepStrictEqual([back.state, back.balance?.minor], ["open", 4_000_000]);
      // Its request again can't stand for the payment taken back.
      assert.include(yield* Effect.flip(pay(4_000_000, "a")), { reason: "conflict" });
      // Nor can a lead's create again stand for the entry the owner dropped.
      const taxi = { list: "expenses", title: "Invented taxi", amount: "500", date: "2026-11-10" };
      const records = yield* KinRecords.KinRecords;
      yield* records.update(orgId, system, "EXP-2", { state: "dropped" });
      const recreated = yield* LeadWork.create(scope, {
        sourceEventId: asked,
        records: [
          { list: "expenses", title: "Invented rent", amount: "1 lakh", state: "open" },
          taxi,
        ],
      }).pipe(Effect.flip);
      assert.include(recreated, { reason: "conflict" });
      // Money paid out never counts as money received.
      assert.deepStrictEqual((yield* OwnerMoney.money(people, { orgId })).received.thisMonth, []);
      // The way out is refused while a payment still counts, and Invoices never lose theirs.
      const off = (list: string, rev: number) =>
        OwnerMoney.updateList(people, { orgId, list, rev, payments: false });
      assert.include(yield* Effect.flip(off("expenses", flagged.rev)), { reason: "invalid_state" });
      const invoices = (yield* OwnerMoney.lists(people, { orgId })).lists.find(
        (one) => one.list === "invoices",
      )!;
      assert.strictEqual(invoices.payments, true);
      assert.include(yield* Effect.flip(off("invoices", invoices.rev)), {
        reason: "invalid_state",
      });
      yield* OwnerMoney.voidPayment(people, {
        orgId,
        key: "EXP-1",
        paymentId: full.payments!.find((one) => one.voidedAt === null)!.paymentId,
      });
      assert.strictEqual((yield* off("expenses", flagged.rev)).payments, undefined);
      assert.strictEqual((yield* totals)?.owed, undefined);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("count every unpaid entry not yet closed as owed, whatever it is called", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* defined(1, {
        name: "Jobs",
        prefix: "JOB",
        amount: true,
        states: ["open", "doing", "done", "dropped"],
        fields: [{ label: "Site\tcode", type: "text" }],
      });
      const lists = yield* OwnerMoney.lists(people, { orgId });
      const jobs = lists.lists.find((one) => one.list === "jobs")!;
      // A label is one line, however a lead wrote it.
      assert.strictEqual(jobs.fields.find((one) => one.key === "siteCode")?.label, "Site code");
      yield* OwnerMoney.updateList(people, { orgId, list: "jobs", rev: jobs.rev, payments: true });
      const asked = yield* turn(3, "A job under way");
      yield* LeadWork.create(scope, {
        sourceEventId: asked,
        records: [{ list: "jobs", title: "Invented fit-out", amount: "100", state: "doing" }],
      });
      const page = yield* OwnerWork.list(people, { orgId, list: "jobs", totalsBy: "none" });
      assert.deepStrictEqual(page.totals?.owed, inr(10_000));
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "count no suggestion in a figure, and keep each as work, a date and a row to keep",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
        VALUES ('mate', ${orgId}, 'mate', 'Mate', ${at}, 'member')`;
        yield* defined(1, { template: "invoices" });
        yield* defined(3, { template: "expenses" });
        yield* defined(5, { template: "dates" });
        const asked = yield* turn(7, "The books");
        yield* LeadWork.create(scope, {
          sourceEventId: asked,
          records: [{ list: "clients", title: "Invented Acme" }],
        });
        yield* LeadWork.create(scope, {
          sourceEventId: asked,
          records: [
            { list: "expenses", title: "Invented flight", amount: "9,000", category: "travel" },
            {
              list: "expenses",
              title: "Invented guessed hotel",
              amount: "40,000",
              category: "travel",
              suggested: true,
            },
            {
              list: "invoices",
              title: "Invented guessed invoice",
              client: "Invented Acme",
              amount: "50,000",
              date: "2026-11-12",
              due: "2026-11-20",
              suggested: true,
            },
            { title: "Invented guessed follow-up", due: "2026-11-10", suggested: true },
            { title: "Invented kept review", due: "2026-11-25" },
            {
              list: "dates",
              title: "Invented guessed filing",
              due: "2026-11-20",
              amount: "1,200",
              suggested: true,
            },
            {
              list: "projects",
              title: "Invented guessed project",
              client: "Invented Acme",
              value: "6 lakh",
              suggested: true,
            },
          ],
        });
        yield* OwnerMoneyAnswers.setBudget(people, {
          orgId,
          category: "travel",
          project: null,
          currency: "INR",
          limitMinor: 2_000_000,
          clientRequestId: "travel",
        });
        const summary = yield* OwnerMoney.money(people, { orgId });
        const section = moneySection(summary, "Asia/Kolkata");
        const view = outlookAnswer(yield* outlook(orgId, NOW));
        assert.deepStrictEqual(
          {
            spent: summary.spent.thisMonth.total,
            topSpend: section?.topSpendThisMonth,
            budget: (yield* OwnerMoneyAnswers.budgets(people, { orgId })).budgets[0]?.spent,
            comingIn: view.comingIn,
            stillToInvoice: yield* ownerLevelStillToInvoice(orgId),
            owed: summary.owed.invoices,
          },
          {
            spent: inr(900_000),
            topSpend: [{ category: "travel", spent: "₹9,000.00" }],
            budget: { minor: 900_000, currency: "INR" },
            comingIn: [],
            stillToInvoice: [],
            owed: 0,
          },
        );
        // A teammate's summary has no suggestions to keep; the owner's names each one.
        const mate = viewerOfPeople([KinPersonId.make("mate")]);
        assert.notProperty(yield* moneySummary(orgId, NOW, mate), "suggested");
        assert.deepStrictEqual(
          [
            (summary.suggested ?? []).map((one) => one.record.key).toSorted(),
            summary.suggestedLists,
          ],
          [
            ["DT-1", "EXP-2", "INV-1"],
            [
              { list: "dates", listName: "Dates", count: 1 },
              { list: "expenses", listName: "Expenses", count: 1 },
              { list: "invoices", listName: "Invoices", count: 1 },
            ],
          ],
        );
        // As work and a date it is still there, late as any deadline is.
        const window = { from: Date.parse("2026-11-01"), to: Date.parse("2026-11-30") };
        const agenda = yield* datesView(orgId, { ...window, viewer: KIN_OWNER_LEVEL }, NOW);
        const tasks = yield* OwnerWork.list(people, { orgId });
        assert.deepStrictEqual(
          [
            [...new Set(agenda.rows.map((one) => one.record.key))].toSorted(),
            tasks.records.filter((one) => one.late && !one.confirmed).map((one) => one.key),
          ],
          [["DT-1", "INV-1", "W-1", "W-2"], ["W-1"]],
        );
        // Its day there is no issue day; Money's coming-up count is of kept entries' dates only.
        assert.deepStrictEqual(
          agenda.rows.filter((one) => one.record.key === "INV-1").map((one) => one.label),
          ["Date", "Due"],
        );
        // People's Money reads money's dates alone: no task, and no invoice still a draft.
        const peoples = yield* OwnerMoney.dates(people, {
          orgId,
          from: "2026-11-01T00:00:00.000Z",
          to: "2026-11-30T00:00:00.000Z",
        });
        assert.deepStrictEqual(
          [peoples.total, peoples.rows.map((one) => one.record.key)],
          [1, ["DT-1"]],
        );
        const told = yield* LeadMoney.datesQuery(scope, {
          from: "2026-11-01",
          to: "2026-11-29",
        });
        assert.deepStrictEqual(
          told.dates
            .filter((one) => one.key === "INV-1")
            .map((one) => [one.date, one.due, one.issued, one.state]),
          [
            [
              "2026-11-12",
              "2026-11-20",
              undefined,
              "Draft, suggested: waits for the owner or a co-owner to keep it",
            ],
          ],
        );
        // An agent's summary still reads every date ahead; people's Money, money's alone.
        const told30 = yield* moneySummary(orgId, NOW, KIN_OWNER_LEVEL);
        assert.deepStrictEqual(
          [
            [told30.upcomingTotal, told30.upcoming.map((one) => one.record.key)],
            [summary.upcomingTotal, summary.upcoming.map((one) => one.record.key)],
          ],
          [
            [1, ["W-2"]],
            [0, []],
          ],
        );
        // Past Money's newest 20, the rest open as a list; a paid one keeps its Keep.
        yield* LeadWork.create(scope, {
          sourceEventId: asked,
          records: Array.from({ length: 21 }, (_, at) => ({
            list: "expenses",
            title: `Invented guessed taxi ${at + 1}`,
            amount: `${at + 1}00`,
            suggested: true as const,
          })),
        });
        const more = yield* OwnerMoney.money(people, { orgId });
        const rest = yield* OwnerWork.list(people, {
          orgId,
          list: "expenses",
          kept: false,
          limit: 50,
        });
        const oldest = rest.records.find((one) => one.key === "EXP-2")!;
        assert.deepStrictEqual(
          [
            more.suggested?.length,
            more.suggestedLists?.find((one) => one.list === "expenses")?.count,
            rest.total,
            [oldest.state, oldest.can?.confirm],
          ],
          [20, 22, 22, ["done", true]],
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect("open, from each Money figure, a list whose header is that figure", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* defined(1, { template: "invoices" });
      yield* defined(3, { template: "expenses" });
      const asked = yield* turn(5, "The books");
      yield* LeadWork.create(scope, {
        sourceEventId: asked,
        records: [
          { list: "clients", title: "Invented Acme" },
          { list: "clients", title: "Invented Birch" },
        ],
      });
      yield* LeadWork.create(scope, {
        sourceEventId: asked,
        records: [
          {
            list: "invoices",
            title: "Invented October retainer",
            client: "Invented Acme",
            amount: "1 lakh",
            date: "2026-10-01",
            due: "2026-11-01",
          },
          {
            list: "invoices",
            title: "Invented one-off",
            amount: "50,000",
            date: "2026-11-01",
            due: "2026-12-01",
          },
          {
            list: "invoices",
            title: "Invented old audit",
            client: "Invented Birch",
            amount: "10,000",
            date: "2026-08-01",
            due: "2026-09-01",
          },
          // A draft past its date is not owed yet, whatever its due date says.
          {
            list: "invoices",
            title: "Invented draft",
            amount: "20,000",
            due: "2026-10-01",
            state: "open",
          },
          // Paid, with no date of its own: spent on the day it was added.
          { list: "expenses", title: "Invented taxi", amount: "500" },
          { list: "expenses", title: "Invented flight", amount: "9,000", category: "travel" },
        ],
      });
      yield* issueAll("INV-1", "INV-2", "INV-3");
      yield* OwnerMoney.recordPayment(people, {
        orgId,
        key: "INV-1",
        amount: { minor: 4_000_000, currency: "INR" },
        paidOn: "2026-11-05",
        clientRequestId: "p1",
      });
      // Suggestions nobody kept: an overdue invoice that took a payment under an older build, and
      // an expense filed paid. No figure counts them, and no list opened from one shows them.
      yield* LeadWork.create(scope, {
        sourceEventId: asked,
        records: [
          {
            list: "invoices",
            title: "Invented guessed renewal",
            client: "Invented Birch",
            amount: "30,000",
            date: "2026-10-01",
            due: "2026-10-15",
          },
          { list: "expenses", title: "Invented guessed lunch", amount: "700", suggested: true },
        ],
      });
      yield* issueAll("INV-5");
      yield* OwnerMoney.recordPayment(people, {
        orgId,
        key: "INV-5",
        amount: { minor: 1_000_000, currency: "INR" },
        paidOn: "2026-11-06",
        clientRequestId: "p2",
      });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE kin_records SET confirmed = 0 WHERE org_id = ${orgId} AND key = 'INV-5'`;
      const summary = yield* OwnerMoney.money(people, { orgId });
      const open = (filter: Omit<Parameters<typeof OwnerWork.list>[1], "orgId" | "totalsBy">) =>
        OwnerWork.list(people, { orgId, totalsBy: "none", ...filter });
      const counted = (filter: Omit<Parameters<typeof OwnerWork.list>[1], "orgId" | "totalsBy">) =>
        open({ ...filter, kept: true }).pipe(Effect.map((page) => page.total));
      const month = { paidFrom: "2026-11-01", paidTo: "2026-11-30" };
      const dated = { dateFrom: "2026-11-01", dateTo: "2026-11-30" };
      // Each list opened from a figure counts what the figure counted, before it pages.
      assert.deepStrictEqual(
        [
          [summary.owed.invoices, yield* counted({ list: "invoices", states: ["waiting"] })],
          [
            summary.owed.overdueInvoices,
            yield* counted({ list: "invoices", states: ["waiting"], late: true }),
          ],
          [1, yield* counted({ list: "invoices", ...month })],
          [2, yield* counted({ list: "expenses", states: ["done"], ...dated })],
          [summary.receivedThisFinancialYear, summary.spentThisFinancialYear],
          [summary.series.at(-1)?.received, summary.series.at(-1)?.spent],
        ],
        [
          [3, 3],
          [2, 2],
          [1, 1],
          [2, 2],
          [inr(4_000_000), inr(950_000)],
          [inr(4_000_000), inr(950_000)],
        ],
      );
      // The whole list still holds them, for Keep.
      assert.deepStrictEqual(
        [
          (yield* open({ list: "invoices", states: ["waiting"] })).total,
          (yield* open({ list: "invoices", kept: false })).records.map((one) => one.key),
          (yield* open({ list: "expenses", kept: false })).records.map((one) => one.key),
        ],
        [4, ["INV-5"], ["EXP-3"]],
      );
      const issued = yield* open({ list: "invoices", states: ["waiting"] });
      assert.deepStrictEqual(
        [summary.owed.total, issued.totals?.owed, issued.totals?.total],
        [inr(12_000_000), inr(12_000_000), inr(16_000_000)],
      );
      // The whole list agrees too: a draft is billed, and not owed yet.
      const every = yield* open({ list: "invoices" });
      assert.deepStrictEqual(
        [every.totals?.owed, every.totals?.total],
        [inr(12_000_000), inr(18_000_000)],
      );
      const overdue = yield* open({ list: "invoices", states: ["waiting"], late: true });
      assert.deepStrictEqual(
        [summary.owed.overdue, overdue.totals?.owed],
        [inr(7_000_000), inr(7_000_000)],
      );
      const received = yield* open({ list: "invoices", ...month });
      assert.deepStrictEqual(
        [summary.received.thisMonth, received.totals?.received],
        [inr(4_000_000), inr(4_000_000)],
      );
      const spent = yield* open({ list: "expenses", states: ["done"], ...dated });
      assert.deepStrictEqual(
        [summary.spent.thisMonth.total, spent.totals?.total],
        [inr(950_000), inr(950_000)],
      );
      // Longest overdue first, whatever the amounts.
      assert.deepStrictEqual(
        summary.owed.byClient.map((row) => [row.party?.title ?? null, row.oldestOverdueDays]),
        [
          ["Invented Birch", 72],
          ["Invented Acme", 11],
          [null, null],
        ],
      );
      // "No client" and "No category" are filters of their own.
      const noClient = yield* open({ list: "invoices", states: ["waiting"], party: null });
      assert.deepStrictEqual(
        [noClient.records.map((one) => one.title), noClient.totals?.owed],
        [["Invented one-off"], inr(5_000_000)],
      );
      const noCategory = yield* open({ list: "expenses", listCategory: null });
      assert.deepStrictEqual(
        [noCategory.records.map((one) => one.title), noCategory.totals?.total],
        [["Invented taxi", "Invented guessed lunch"], inr(50_000)],
      );
      // A stored category keeps a label only where the definition gives one.
      const expenses = (yield* OwnerMoney.lists(people, { orgId })).lists.find(
        (one) => one.list === "expenses",
      )!;
      const labelled = yield* OwnerMoney.updateList(people, {
        orgId,
        list: "expenses",
        rev: expenses.rev,
        categoryLabels: { travel: "Travel & stay" as never },
      });
      assert.deepStrictEqual(labelled.categoryLabels, { travel: "Travel & stay" });
      assert.include(
        yield* Effect.flip(
          OwnerMoney.updateList(people, {
            orgId,
            list: "expenses",
            rev: labelled.rev,
            categoryLabels: { nope: "Nope" as never },
          }),
        ),
        { reason: "invalid_state" },
      );
      const plain = yield* OwnerMoney.updateList(people, {
        orgId,
        list: "expenses",
        rev: labelled.rev,
        categoryLabels: { travel: null },
      });
      assert.strictEqual(plain.categoryLabels, undefined);
      // A preset's label cleared stays cleared.
      yield* defined(7, { template: "dates" });
      // F53: a renewal created with its fee keeps it.
      const renewal = yield* turn(70, "Domain renewal on 3 Jan, ₹1,299");
      yield* LeadWork.create(scope, {
        sourceEventId: renewal,
        records: [{ list: "dates", title: "Domain renewal", date: "2027-01-03", amount: "₹1,299" }],
      });
      const renewed = yield* (yield* KinRecords.KinRecords).get(orgId, "DT-1");
      assert.deepStrictEqual([renewed?.amountMinor, renewed?.currency], [129_900, "INR"]);
      const dates = () =>
        OwnerMoney.lists(people, { orgId }).pipe(
          Effect.map((all) => all.lists.find((one) => one.list === "dates")!),
        );
      const unlabelled = yield* OwnerMoney.updateList(people, {
        orgId,
        list: "dates",
        rev: (yield* dates()).rev,
        categoryLabels: { gst: null },
      });
      assert.notProperty(unlabelled.categoryLabels ?? {}, "gst");
      assert.notProperty((yield* dates()).categoryLabels ?? {}, "gst");
      assert.strictEqual((yield* dates()).categoryLabels?.tds, "TDS");
      // A label stored with a control character before they were refused still loads, without it.
      yield* sql`UPDATE kin_registers SET name = ${"Key\tdates"},
          definition_json = replace(definition_json, '"TDS"', '"T\\u0007DS"')
        WHERE org_id = ${orgId} AND register_id = 'dates'`;
      const loaded = yield* dates();
      assert.deepStrictEqual([loaded.name, loaded.categoryLabels?.tds], ["Key dates", "T DS"]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("send a screen the first 20 owing clients and a count of the rest", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* defined(1, { template: "invoices" });
      const asked = yield* turn(5, "The books");
      const names = Array.from({ length: 22 }, (_, i) => `Invented Client ${i + 1}`);
      yield* LeadWork.create(scope, {
        sourceEventId: asked,
        records: names.map((title) => ({ list: "clients", title })),
      });
      yield* LeadWork.create(scope, {
        sourceEventId: asked,
        records: names.map((client, i) => ({
          list: "invoices",
          title: `Invented invoice ${i + 1}`,
          client,
          amount: "10,000",
          date: "2026-10-01",
          due: `2026-10-${String(i + 1).padStart(2, "0")}`,
        })),
      });
      yield* issueAll(...names.map((_, i) => `INV-${i + 1}`));
      const screen = yield* OwnerMoney.money(people, { orgId });
      const every = yield* OwnerMoney.money(people, { orgId, allClients: true });
      assert.deepStrictEqual<unknown>(screen.owed, {
        ...every.owed,
        byClient: every.owed.byClient.slice(0, 20),
        byClientMore: 2,
      });
      assert.strictEqual(every.owed.byClient.length, 22);
      assert.notProperty(every.owed, "byClientMore");
      // A client's own page is sent its line, wherever it falls in the order.
      const last = every.owed.byClient.at(-1)!.party!;
      assert.deepStrictEqual(
        (yield* OwnerMoney.money(people, { orgId, party: last.key })).owed.byClient,
        [every.owed.byClient.at(-1)],
      );
    }).pipe(Effect.provide(layer)),
  );
});

describe("who keeps a suggestion", () => {
  // The owner's binding rule: a quote or invoice is real on an owner-level person's word only.
  it.effect("is decided in the write from who acted, and nothing an agent passes", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
        VALUES ('co-owner', ${orgId}, 'co', 'Co', ${at}, 'co_owner'),
          ('mate', ${orgId}, 'mate', 'Mate', ${at}, 'member')`;
      yield* defined(1, { template: "invoices" });
      yield* defined(3, { template: "expenses" });
      yield* defined(5, { template: "quotes" });
      const records = yield* KinRecords.KinRecords;
      const person = (id: string): KinRecords.Writer => ({
        actor: { _tag: "person", personId: KinPersonId.make(id) },
        via: "owner",
      });
      // A turn of the lead woken by these, in order: people's messages, or a routine or reaction.
      let n = 100;
      // The party an approved draft names, if any.
      let approvedParty: {
        key: string;
        title: string;
        recordId: string;
        list: "clients";
        partyId: string;
      } | null = null;
      const woken = (...by: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          n += 1;
          const wake = `wake-${n}`;
          yield* sql`UPDATE kin_wakeups SET status = 'completed' WHERE status = 'running'`;
          yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, model,
              started_at, status, event_ids, audience)
            VALUES (${wake}, ${orgId}, ${lead}, 'lead-thread', 'test', 0, 'running', '[]',
              'owner_only')`;
          let first = `event-${n}-0`;
          for (const [i, who] of by.entries()) {
            const eventId = `event-${n}-${i}`;
            const message = `msg-${n}-${i}`;
            // The owner's Approve on a sent-up draft (`approveDraft`), or the same unapproved.
            if (who === "approved" || who === "unapproved") {
              const questionId = `q-${n}-${i}`;
              const approval = approvalEventId(orgId, questionId);
              if (i === 0) first = approval;
              const draft = JSON.stringify({
                kind: "invoice",
                for: approvedParty,
                text: "Invoice: ____",
                line: "Invoice",
                names: { owner: "Owner", asker: "Mate", agent: "Lead lead" },
              });
              yield* sql`INSERT INTO kin_questions (question_id, org_id, agent_id, person_id,
                  chat_id, kind, question, safe, asked_at, due_at, act_at, state, answer,
                  for_chat_id, for_person_id, draft_json, approved_at)
                VALUES (${questionId}, ${orgId}, ${lead}, ${ownerId}, 'lead-chat', 'card',
                  'Approve the invoice?', 0, 0, 0, 0, 'answered', 'Approve', 'mate-chat', 'mate',
                  ${draft}, ${who === "approved" ? 1 : null})`;
              yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json,
                  received_at, queued_at, state, wakeup_id, dedupe_key)
                VALUES (${approval}, ${orgId}, ${lead}, 'deferral.due', 'P0', ${JSON.stringify({
                  _tag: "deferral.due",
                  provenance: { _tag: "system" },
                  subject: { type: "question", questionId, answered: true, approved: true },
                })}, 0, 0, 'claimed', ${wake}, ${approvalDedupeKey(questionId)})`;
              continue;
            }
            const said = who !== "routine" && who !== "reaction";
            if (said)
              yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind,
                  author_person_id, author_member_id, author_role, kind, body, mentions_json,
                  status, created_at, attachments_json)
                VALUES (${message}, ${orgId}, 'lead-chat', ${n * 10 + i}, 'human', ${who},
                  'lead-chat-owner', 'owner', 'text', 'Invoice it', '[]', 'posted', ${at}, '[]')`;
            const tag = said
              ? "chat.message"
              : who === "routine"
                ? "schedule.fired"
                : "chat.reaction";
            yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json,
                received_at, queued_at, state, wakeup_id)
              VALUES (${eventId}, ${orgId}, ${lead}, ${tag}, 'P0', ${JSON.stringify({
                _tag: tag,
                chatId: "lead-chat",
                messageId: message,
                provenance: { _tag: "human", personId: ownerId },
              })}, 0, 0, 'claimed', ${wake})`;
          }
          return first;
        });
      const kept = (key: string) =>
        records.get(orgId, key).pipe(Effect.map((row) => row?.confirmed));
      const AGENTS = [
        ["owner asked", [ownerId]],
        ["co-owner asked", ["co-owner"]],
        ["owner and co-owner asked", [ownerId, "co-owner"]],
        ["owner and teammate asked", [ownerId, "mate"]],
        ["teammate asked", ["mate"]],
        ["nobody asked", ["routine"]],
        ["owner reacted", ["reaction"]],
        ["owner approved a draft", ["approved"]],
        ["a draft not approved", ["unapproved"]],
      ] as const;
      const asAgent = (by: ReadonlyArray<string>, records: ReadonlyArray<object>) =>
        Effect.gen(function* () {
          const asked = yield* woken(...by);
          const made = yield* LeadWork.create(scope, {
            sourceEventId: asked,
            records: records as never,
          });
          return made.records.map((one) => one.key);
        });
      const lists = (title: string) => [
        { list: "quotes", title: `${title} quote`, amount: "10,000" },
        { list: "invoices", title: `${title} invoice`, amount: "10,000", state: "open" },
        { list: "expenses", title: `${title} expense`, amount: "100" },
        { title: `${title} task` },
      ];
      // Each actor against creating each kind: [quote, invoice, expense, task].
      // A turn a teammate is part of writes in the team view, which this lead chat refuses.
      const created: Record<string, ReadonlyArray<number | string | undefined>> = {};
      for (const [name, by] of AGENTS)
        created[name] = yield* Effect.forEach(lists(name), (one) =>
          asAgent(by, [one]).pipe(
            Effect.flatMap(([key]) => kept(key!)),
            Effect.catchTags({ KinChatError: () => Effect.succeed("refused") }),
          ),
        );
      for (const who of [ownerId, "co-owner", "mate"]) {
        const keys = [];
        for (const [i, one] of lists(who).entries()) {
          const { row } = yield* records.create(orgId, person(who), {
            ...(one.list === undefined ? {} : { list: one.list }),
            originKey: `by-${who}-${i}`,
            title: one.title,
            owner: { _tag: "person", personId: KinPersonId.make(who) },
          });
          keys.push(row.key);
        }
        created[who] = yield* Effect.forEach(keys, kept);
      }
      assert.deepStrictEqual(created, {
        "owner asked": [1, 1, 1, 1],
        "co-owner asked": [1, 1, 1, 1],
        "owner and co-owner asked": [1, 1, 1, 1],
        "owner and teammate asked": ["refused", "refused", "refused", "refused"],
        "teammate asked": ["refused", "refused", "refused", "refused"],
        "nobody asked": [0, 0, 0, 0],
        "owner reacted": [0, 0, 0, 0],
        // His Approve of an invoice makes only an invoice real; unapproved, nothing is.
        "owner approved a draft": [0, 1, 0, 0],
        "a draft not approved": [0, 0, 0, 0],
        [ownerId]: [1, 1, 1, 1],
        "co-owner": [1, 1, 1, 1],
        mate: [0, 0, 1, 1],
      });

      // Issued, sent or paid as asked, a quote or invoice nobody kept, or an agent's invoice,
      // starts as a draft on its day.
      const issueDay = "2026-12-01";
      const startedAs = (key: string) =>
        records
          .get(orgId, key)
          .pipe(Effect.map((row) => [row?.confirmed, row?.state, row?.dateAt]));
      const asked = (list: string, state: string, extra: { suggested?: true } = {}) => ({
        list,
        title: `Invented ${list} ${state}${extra.suggested === true ? " suggested" : ""}`,
        amount: "9,750",
        state,
        date: issueDay,
        ...extra,
      });
      // The agent reads what it made: a draft and a suggestion, not what it asked for.
      const made = yield* LeadWork.create(scope, {
        sourceEventId: yield* woken("routine"),
        records: [asked("invoices", "waiting", { suggested: true })].map((one) => ({
          ...one,
          title: "Invented told invoice",
        })) as never,
      });
      assert.deepInclude(made.records[0], {
        state: "open",
        stateLabel: "Draft, suggested: waits for the owner or a co-owner to keep it",
        suggested: true,
      });
      const started = [];
      for (const [by, row] of [
        [["routine"], asked("invoices", "waiting")],
        [["routine"], asked("invoices", "done")],
        [["routine"], asked("quotes", "waiting")],
        [[ownerId], asked("invoices", "waiting", { suggested: true })],
        [[ownerId], { ...asked("invoices", "waiting"), title: "Invented owner's invoice" }],
      ] as const)
        started.push(yield* startedAs((yield* asAgent(by, [row]))[0]!));
      for (const [i, state] of (["waiting", "done"] as const).entries()) {
        const { row } = yield* records.create(orgId, person("mate"), {
          list: "invoices",
          originKey: `mate-issued-${i}`,
          title: `Invented mate invoice ${state}`,
          owner: { _tag: "person", personId: KinPersonId.make("mate") },
          amount: { minor: 975_000, currency: "INR" },
          state,
          dateAt: Date.parse(`${issueDay}T00:00:00.000Z`),
        });
        started.push(yield* startedAs(row.key));
      }
      // One the owner enters with the number another system gave it was issued there: it is owed.
      const { row: elsewhere } = yield* records.create(orgId, person(ownerId), {
        list: "invoices",
        originKey: "owner-numbered",
        title: "Invented invoice from the old books",
        owner: { _tag: "person", personId: ownerId },
        amount: { minor: 975_000, currency: "INR" },
        fields: { number: "OLD/2026/041" },
        dateAt: Date.parse(`${issueDay}T00:00:00.000Z`),
      });
      started.push(yield* startedAs(elsewhere.key));
      const day = Date.parse(`${issueDay}T00:00:00.000Z`);
      assert.deepStrictEqual(
        started.map(([kept, state, dateAt]) => [kept, state, dateAt === null ? null : day]),
        [
          [0, "open", day],
          [0, "open", day],
          [0, "open", day],
          [0, "open", day],
          // Kept on the owner's word, it is still a draft: only Issue makes it owed.
          [1, "open", day],
          [0, "open", day],
          [0, "open", day],
          [1, "waiting", day],
        ],
      );

      // Keeping one: confirmed true keeps it only on a turn an owner-level person asked in person.
      const guessed = (title: string) =>
        asAgent(["routine"], [{ list: "invoices", title, amount: "47,200", state: "open" }]).pipe(
          Effect.map(([key]) => key!),
        );
      const keeps: Record<string, number | undefined> = {};
      for (const [name, by] of AGENTS) {
        const key = yield* guessed(`Kept by ${name}`);
        yield* LeadWork.update(scope, {
          sourceEventId: yield* woken(...by),
          key,
          confirmed: true,
        }).pipe(Effect.catchTags({ KinChatError: () => Effect.void }));
        keeps[name] = yield* kept(key);
      }
      for (const who of [ownerId, "co-owner", "mate"]) {
        const key = yield* guessed(`Kept by ${who}`);
        yield* records.update(orgId, person(who), key, { confirmed: true });
        keeps[who] = yield* kept(key);
      }
      assert.deepStrictEqual(keeps, {
        "owner asked": 1,
        "co-owner asked": 1,
        "owner and co-owner asked": 1,
        "owner and teammate asked": 0,
        "teammate asked": 0,
        "nobody asked": 0,
        "owner reacted": 0,
        // His Approve made the draft; it keeps nothing that was there before it.
        "owner approved a draft": 0,
        "a draft not approved": 0,
        [ownerId]: 1,
        "co-owner": 1,
        mate: 0,
      });

      // One approval makes one kept entry: its list, for its party, as a Draft whatever state it
      // was given; a different party, or a second entry, is ordinary; a retry is the same one.
      const [harbour] = yield* asAgent([ownerId], [{ list: "clients", title: "Invented Harbour" }]);
      yield* asAgent([ownerId], [{ list: "clients", title: "Invented Tide" }]);
      const harbourId = (yield* records.get(orgId, harbour!))!.recordId;
      approvedParty = {
        key: harbour!,
        title: "Invented Harbour",
        recordId: harbourId,
        list: "clients",
        partyId: harbourId,
      };
      const approval = yield* woken("approved");
      const rows = [
        { list: "invoices", title: "Invented wrong party", client: "Invented Tide", amount: "1" },
        {
          list: "invoices",
          title: "Invented approved one",
          client: "Invented Harbour",
          amount: "9,750",
          state: "waiting",
        },
        { list: "invoices", title: "Invented second", client: "Invented Harbour", amount: "2" },
      ];
      const underApproval = (yield* LeadWork.create(scope, {
        sourceEventId: approval,
        records: rows as never,
      })).records.map((one) => one.key);
      assert.deepStrictEqual(yield* Effect.forEach(underApproval, startedAs), [
        [0, "open", null],
        [1, "open", null],
        [0, "open", null],
      ]);
      const retried = (yield* LeadWork.create(scope, {
        sourceEventId: approval,
        records: rows as never,
      })).records.map((one) => one.key);
      assert.deepStrictEqual(retried, underApproval);
      approvedParty = null;

      // Nothing else an agent does keeps one, or takes a person's keep back.
      const key = yield* guessed("Invented renewal");
      const routine = () => woken("routine");
      yield* LeadWork.update(scope, { sourceEventId: yield* routine(), key, amount: null });
      yield* LeadWork.update(scope, {
        sourceEventId: yield* routine(),
        key,
        amount: "47,200",
        confirmed: true,
      });
      yield* LeadWork.update(scope, { sourceEventId: yield* routine(), key, due: "2026-12-01" });
      yield* records.update(orgId, person(ownerId), key, { fields: { number: "INV/26-27/090" } });
      // The owner asking for the same again later makes a new entry; the guess stays a guess.
      const again = yield* asAgent(
        [ownerId],
        [{ list: "invoices", title: "Invented renewal", amount: "47,200", state: "open" }],
      );
      const keptOne = (yield* asAgent(
        [ownerId],
        [{ list: "invoices", title: "Invented kept", amount: "1,000", state: "open" }],
      ))[0]!;
      yield* LeadWork.update(scope, {
        sourceEventId: yield* woken(ownerId),
        key: keptOne,
        confirmed: false,
      });
      assert.deepStrictEqual(
        [yield* kept(key), again[0] !== key, yield* kept(keptOne)],
        [0, true, 1],
      );

      // Until it is kept, nobody issues, sends, pays or moves it to issued.
      const refusal = `${key} is still a suggestion: the owner or a co-owner hasn't kept it. They keep it with Keep on its page, or by asking you to keep it themselves. Nothing changed.`;
      const quote = (yield* asAgent(
        ["routine"],
        [{ list: "quotes", title: "Invented guessed quote", amount: "5,000" }],
      ))[0]!;
      const refused = yield* Effect.all([
        OwnerMoney.issue(people, { orgId, key: KinRecordKey.make(key) }).pipe(Effect.flip),
        OwnerMoney.issue(people, { orgId, key: KinRecordKey.make(quote) }).pipe(Effect.flip),
        records
          .pay(orgId, person(ownerId), key, {
            amount: { minor: 100, currency: "INR" },
            paidOn: "2026-11-12",
            originKey: "paid-a-suggestion",
          })
          .pipe(Effect.flip),
        records.update(orgId, person(ownerId), key, { state: "waiting" }).pipe(Effect.flip),
        records.update(orgId, person(ownerId), quote, { state: "done" }).pipe(Effect.flip),
      ]);
      assert.deepStrictEqual(
        refused.map((one) => one.message),
        [refusal, refusal.replace(key, quote), refusal, refusal, refusal.replace(key, quote)],
      );
      // Not needed, and its undo, still work.
      yield* records.update(orgId, person(ownerId), key, { state: "dropped" });
      yield* records.update(orgId, person(ownerId), key, { state: "open" });

      // Made from another: a suggestion's invoice is one; a kept quote's follows who makes it.
      const keptQuotes = yield* asAgent(
        [ownerId],
        [
          { list: "quotes", title: "Invented kept quote", amount: "5,000" },
          { list: "quotes", title: "Invented second kept quote", amount: "6,000" },
        ],
      );
      const fromQuote = (writer: KinRecords.Writer, quoteKey: string) =>
        Quotes.invoiceFromQuote(orgId, writer, quoteKey).pipe(
          Effect.flatMap(({ entry }) => kept(entry.key)),
        );
      yield* woken("routine");
      const unasked: KinRecords.Writer = {
        actor: { _tag: "agent", agentId: lead },
        via: "lead",
        wakeupId: `wake-${n}`,
      };
      assert.deepStrictEqual(
        [
          yield* fromQuote(person(ownerId), quote),
          yield* fromQuote(person(ownerId), keptQuotes[0]!),
          yield* fromQuote(unasked, keptQuotes[1]!),
        ],
        [0, 1, 0],
      );
      // A repeating entry's next one: a suggestion's is one; a kept one's follows who closed it.
      const repeating = (title: string, by: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          const [one] = yield* asAgent(by, [{ title }]);
          yield* records.update(orgId, system, one!, {
            dueAt: Date.parse("2026-11-20T12:00:00.000Z"),
            repeat: { every: "month" },
          });
          return one!;
        });
      const next = (closed: string, writer: KinRecords.Writer) =>
        Effect.gen(function* () {
          const row = (yield* records.get(orgId, closed))!;
          yield* records.update(orgId, writer, closed, { state: "done" });
          const [copy] = yield* sql<{ confirmed: number }>`SELECT confirmed FROM kin_records
            WHERE org_id = ${orgId} AND origin_key = ${`repeat:${row.recordId}`}`;
          return copy?.confirmed;
        });
      assert.deepStrictEqual(
        [
          yield* next(yield* repeating("Invented guessed check-in", ["routine"]), person(ownerId)),
          yield* next(yield* repeating("Invented kept check-in", [ownerId]), person(ownerId)),
        ],
        [0, 1],
      );
    }).pipe(Effect.provide(layer)),
  );
});

describe("an expense typed by hand", () => {
  it.effect(
    "is the owner level's, makes the Expenses list the first time, and keeps its receipt",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const records = yield* KinRecords.KinRecords;
        yield* turn(1, "The courier's receipt", ["courier.jpg"]);
        const asked = {
          orgId,
          title: "Courier for samples",
          amount: { minor: 235_000, currency: "INR" },
          paidOn: "2026-11-12",
          vendor: "Invented Couriers",
          category: "Office",
          paidWith: "UPI",
          fundedBy: ownerId,
          receipt: ["att-1-0"],
          clientRequestId: "form-1",
        };
        // No Expenses list yet: the first expense makes it, Funded by and all.
        assert.isUndefined(yield* listDef(orgId, "expenses"));
        const made = yield* OwnerMoneyAnswers.newExpense(people, asked);
        const row = (yield* records.get(orgId, made.expense))!;
        assert.deepStrictEqual(
          [row.registerId, row.state, row.amountMinor, row.category, JSON.parse(row.fieldsJson)],
          [
            "expenses",
            "done",
            235_000,
            "office",
            {
              vendor: "Invented Couriers",
              paidWith: "upi",
              fundedBy: `person:${ownerId}`,
              receipt: ["att-1-0"],
            },
          ],
        );
        assert.strictEqual(row.dateAt, endOfDay("2026-11-12", "Asia/Kolkata"));
        // The same request is the same expense; its id with other details makes nothing.
        assert.strictEqual(
          (yield* OwnerMoneyAnswers.newExpense(people, asked)).expense,
          made.expense,
        );
        assert.include(
          yield* OwnerMoneyAnswers.newExpense(people, { ...asked, title: "Other" }).pipe(
            Effect.flip,
          ),
          { reason: "not_allowed" },
        );
        // Paid on a day still ahead, it is to pay; a file from nobody's chat isn't kept.
        const { receipt: _receipt, ...plain } = asked;
        const later = yield* OwnerMoneyAnswers.newExpense(people, {
          ...plain,
          paidOn: "2026-11-30",
          clientRequestId: "form-2",
        });
        assert.strictEqual((yield* records.get(orgId, later.expense))!.state, "open");
        assert.include(
          yield* OwnerMoneyAnswers.newExpense(people, {
            ...asked,
            receipt: ["att-nowhere"],
            clientRequestId: "form-3",
          }).pipe(Effect.flip),
          { reason: "not_found" },
        );
        assert.include(
          yield* OwnerMoneyAnswers.newExpense(people, {
            ...plain,
            category: "Invented snacks",
            clientRequestId: "form-4",
          }).pipe(Effect.flip),
          { reason: "invalid_state" },
        );
        // A teammate's app makes none.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
        VALUES ('teammate', ${orgId}, 'teammate', 'Teammate', ${at})`;
        const teammate = [
          { _tag: "person" as const, orgId, personId: KinPersonId.make("teammate") },
        ];
        assert.include(
          yield* OwnerMoneyAnswers.newExpense(teammate, {
            ...plain,
            clientRequestId: "form-5",
          }).pipe(Effect.flip),
          { reason: "not_allowed" },
        );
        // The agent's read totals both, as it totals its own.
        const all = yield* LeadWork.query(scope, { list: "expenses" });
        assert.deepStrictEqual(all.totals, ["₹4,700.00"]);
        // A form that asks: over a thousand times the largest is refused once, saving nothing,
        // and saved when confirmed; under it, or from a form that can't ask, it saves.
        const far = { minor: 235_000_001, currency: "INR" };
        const slip = yield* OwnerMoneyAnswers.newExpense(people, {
          ...plain,
          amount: far,
          amountConfirmed: false,
          clientRequestId: "form-6",
        }).pipe(Effect.flip);
        assert.deepStrictEqual(slip.farAbove, {
          list: "Expenses",
          largest: { minor: 235_000, currency: "INR" },
        });
        const kept = yield* OwnerMoneyAnswers.newExpense(people, {
          ...plain,
          amount: far,
          amountConfirmed: true,
          clientRequestId: "form-6",
        });
        for (const [n, amount, amountConfirmed] of [
          [7, { minor: 235_000_000, currency: "INR" }, false],
          [8, far, undefined],
        ] as const)
          yield* OwnerMoneyAnswers.newExpense(people, {
            ...plain,
            amount,
            ...(amountConfirmed === undefined ? {} : { amountConfirmed }),
            clientRequestId: `form-${n}`,
          });
        // An edit asks the same of a new amount, and never of the one it already has.
        const edit = (amount: { minor: number; currency: string }, amountConfirmed: boolean) =>
          Effect.gen(function* () {
            const row = (yield* records.get(orgId, later.expense))!;
            return yield* OwnerWork.update(people, {
              orgId,
              key: row.key,
              rev: row.rev,
              amount,
              amountConfirmed,
            });
          });
        const huge = { minor: 999_999_999_999, currency: "INR" };
        assert.deepStrictEqual(
          (yield* edit(huge, false).pipe(Effect.flip)).farAbove?.list,
          "Expenses",
        );
        assert.strictEqual((yield* records.get(orgId, later.expense))!.amountMinor, 235_000);
        yield* edit(huge, true);
        yield* edit(huge, false);
        assert.strictEqual((yield* records.get(orgId, later.expense))!.amountMinor, huge.minor);
        yield* edit({ ...huge, minor: -huge.minor * 2_000 }, false);
        assert.strictEqual(
          (yield* records.get(orgId, later.expense))!.amountMinor,
          -huge.minor * 2_000,
        );
        assert.isDefined(yield* records.get(orgId, kept.expense));
      }).pipe(Effect.provide(layer)),
  );
});

describe("another org", () => {
  it.effect("sees none of this org's entries, payments, proposals or money", () =>
    Effect.gen(function* () {
      yield* seed;
      const records = yield* KinRecords.KinRecords;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
        VALUES ('theirs', ${otherOrg}, 'theirs', 'Theirs', ${at})`;
      const made = yield* defined(1, { template: "invoices" });
      assert.strictEqual(made.list, "invoices");
      // The other org has its own invoices list, and an invoice with a key this org lacks.
      yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in,
          created_at, definition_json, rev)
        SELECT ${otherOrg}, register_id, name, key_prefix, built_in, created_at, definition_json, rev
        FROM kin_registers WHERE org_id = ${orgId} AND register_id = 'invoices'`;
      const { row } = yield* records.create(otherOrg, system, {
        list: "invoices",
        title: "Their invoice",
        owner: { _tag: "person", personId: KinPersonId.make("theirs") },
        amount: { minor: 500_00, currency: "INR" },
        originKey: "theirs",
      });
      const { paymentId } = yield* records.pay(otherOrg, system, row.key, {
        amount: { minor: 100_00, currency: "INR" },
        paidOn: "2026-11-01",
        originKey: "their-payment",
      });
      const asked = yield* turn(3, "Did they pay?");
      const pay = yield* LeadMoney.payment(scope, {
        sourceEventId: asked,
        key: row.key,
        amount: "100",
        paidOn: "2026-11-01",
      }).pipe(Effect.flip);
      assert.include(pay, { reason: "not_found" });
      const voided = yield* records
        .voidPayment(orgId, system, row.key, paymentId)
        .pipe(Effect.flip);
      assert.include(voided, { reason: "not_found" });
      const summary = yield* OwnerMoney.money(people, { orgId });
      assert.deepStrictEqual(summary.received.thisMonth, []);
      assert.deepStrictEqual(summary.owed.total, []);
      // This org's owner is nobody in the other org.
      for (const refused of [
        yield* Effect.flip(OwnerMoney.money(people, { orgId: otherOrg })),
        yield* Effect.flip(OwnerMoney.companyProfile(people, { orgId: otherOrg })),
        yield* Effect.flip(OwnerMoney.lists(people, { orgId: otherOrg })),
      ])
        assert.include(refused, { reason: "not_allowed" });
      // A proposal id from another agent's turn is unknown to this lead.
      yield* sql`INSERT INTO kin_list_proposals (org_id, proposal_id, agent_id, chat_id, wakeup_id,
          register_id, extends_existing, definition_json, chat_seq, proposed_at)
        VALUES (${otherOrg}, 'lp_theirs', 'theirs', 'their-chat', 'their-wake', 'leave', 0, '{}', 0, 0)`;
      const theirs = yield* LeadMoney.define(scope, {
        sourceEventId: asked,
        proposal: "lp_theirs",
      }).pipe(Effect.flip);
      assert.include(theirs, { reason: "not_found" });
    }).pipe(Effect.provide(layer)),
  );
});

describe("the company profile", () => {
  it.effect("asks in the chat the turn came from, so a co-owner's change reaches her", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      // A co-owner's own chat with the lead, and a turn her message woke there.
      yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
        VALUES ('co-chat', ${orgId}, 'direct', 'co:lead', 1, ${at})`;
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
        VALUES ('co-owner', ${orgId}, 'co', 'Co', ${at}, 'co_owner')`;
      yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
        VALUES ('co-chat-co', ${orgId}, 'co-chat', 'person', 'co-owner', 'owner', ${at})`;
      yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, agent_id, role, joined_at)
        VALUES ('co-chat-lead', ${orgId}, 'co-chat', 'agent', ${lead}, 'member', ${at})`;
      yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind,
          author_person_id, author_member_id, author_role, kind, body, mentions_json, status,
          created_at)
        VALUES ('msg-co', ${orgId}, 'co-chat', 1, 'human', 'co-owner', 'co-chat-co', 'owner',
          'text', 'Our trade name is Invented', '[]', 'posted', ${at})`;
      yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, model, started_at,
          status, event_ids, audience)
        VALUES ('wake-co', ${orgId}, ${lead}, 'lead-thread', 'test', 0, 'running',
          '["event-co"]', 'owner_only')`;
      const event = {
        _tag: "chat.message",
        orgId,
        agentId: lead,
        eventId: "event-co",
        receivedAt: at,
        dedupeKey: null,
        provenance: { _tag: "human", personId: "co-owner", memberId: "co-chat-co" },
        chatId: "co-chat",
        messageId: "msg-co",
      };
      yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json,
          received_at, queued_at, state, wakeup_id)
        VALUES ('event-co', ${orgId}, ${lead}, 'chat.message', 'P0', ${JSON.stringify(event)},
          0, 0, 'claimed', 'wake-co')`;
      yield* LeadMoney.profile(scope, {
        sourceEventId: "event-co",
        set: { tradeName: "Invented" },
      });
      const cards = yield* sql<{ chatId: string }>`SELECT w.chat_id AS "chatId"
        FROM kin_profile_changes c JOIN kin_widgets w ON w.widget_id = c.widget_id`;
      assert.deepStrictEqual(cards, [{ chatId: "co-chat" }]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps the owner's home currency and rates, which no agent card proposes", () =>
    Effect.gen(function* () {
      yield* seed;
      const set = yield* OwnerMoney.setCompanyProfile(people, {
        orgId,
        rev: 0,
        legalName: "Invented Private Limited",
      });
      // A profile stored before home currencies reads as rupees with no rates.
      assert.deepStrictEqual([set.homeCurrency, set.rates], ["INR", []]);
      const rated = yield* OwnerMoney.setCompanyProfile(people, {
        orgId,
        rev: set.rev,
        rates: [{ currency: "USD", rate: "84.25", asOf: "2026-11-10" }],
      });
      assert.deepStrictEqual(rated.rates, [{ currency: "USD", rate: "84.25", asOf: "2026-11-10" }]);
      const unrated = yield* OwnerMoney.setCompanyProfile(people, {
        orgId,
        rev: rated.rev,
        rates: [],
      });
      assert.deepStrictEqual([unrated.rates, unrated.legalName], [[], "Invented Private Limited"]);
      // Rates never reach what an agent is shown it could change.
      assert.deepStrictEqual(
        changeLines(unrated, { homeCurrency: "USD", rates: [], pan: "ABCDE1234F" }),
        ["PAN: none → ABCDE1234F"],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("writes its people's times on its country's clock, en-GB's where it has none", () =>
    Effect.gen(function* () {
      yield* seed;
      const at = Date.UTC(2026, 10, 17, 9, 5);
      const line = waitLine(orgId, at);
      // A company that never set one keeps rupees, and so India's 12-hour clock.
      assert.match(yield* line, /after \d{1,2}:35 [ap]m;/);
      let rev = 0;
      for (const [home, clock] of [
        ["GBP", /after \d{2}:35;/],
        ["USD", /after \d{1,2}:35 [AP]M;/],
        ["EUR", /after \d{2}:35;/],
        ["INR", /after \d{1,2}:35 [ap]m;/],
      ] as const) {
        rev = (yield* OwnerMoney.setCompanyProfile(people, { orgId, rev, homeCurrency: home })).rev;
        assert.match(yield* line, clock, home);
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("gives a new expenses list the ways its company's country pays", () =>
    Effect.gen(function* () {
      yield* seed;
      const paidWith = Effect.gen(function* () {
        const proposal = yield* proposalFor(orgId, { template: "expenses" });
        assert(proposal._tag === "new");
        return proposal.definition.fields.find((field) => field.key === "paidWith")?.choices;
      });
      // A company that never set one keeps the default home currency, rupees, and so India's.
      assert.deepStrictEqual(yield* paidWith, ["card", "upi", "bank", "cash"]);
      let rev = 0;
      for (const [home, ways] of [
        ["USD", ["card", "ach", "wire", "check", "cash"]],
        ["GBP", ["card", "bank", "direct debit", "cash"]],
        ["EUR", ["card", "bank", "cash"]],
        ["INR", ["card", "upi", "bank", "cash"]],
      ] as const) {
        rev = (yield* OwnerMoney.setCompanyProfile(people, { orgId, rev, homeCurrency: home })).rev;
        assert.deepStrictEqual(yield* paidWith, ways, home);
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("records no money for a company created now until its country is chosen", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      // The row `bootstrapIdentity` writes for a company it creates (`chat/KinIdentity.test.ts`).
      yield* sql`INSERT INTO kin_company_profile (org_id, profile_json, rev, updated_at,
          updated_by_kind, updated_by_id)
        VALUES (${orgId}, ${yield* newCompanyProfileJson}, 1, 0, 'person', ${ownerId})`;
      const refusal = countryFirstMessage("Owner");
      const invoice = (sourceEventId: string) =>
        LeadWork.create(scope, {
          sourceEventId,
          records: [
            { list: "clients", title: "Invented Kestrel" },
            {
              list: "invoices",
              title: "Invented brand kit",
              client: "Invented Kestrel",
              amount: "1,200",
            },
          ],
        });
      const expense = (sourceEventId: string) =>
        LeadWork.create(scope, {
          sourceEventId,
          records: [
            { list: "expenses", title: "Invented fonts", amount: "40", category: "software" },
          ],
        });
      const budget = (sourceEventId: string) =>
        LeadMoney.budget(scope, { sourceEventId, category: "travel", limit: "500" });
      const ownersBudget = OwnerMoneyAnswers.setBudget(people, {
        orgId,
        category: "travel",
        project: null,
        currency: "GBP",
        limitMinor: 50_000,
        clientRequestId: "new-company-budget",
      });
      const goal = (clientRequestId: string) =>
        Goals.save(people, {
          orgId,
          title: "Invented revenue",
          measure: "revenue_received",
          target: "5,000",
          startsOn: "2026-11-01",
          dueOn: "2026-12-31",
          clientRequestId,
        });
      // Each call keeps its own type: a list of them makes the checker pick one for all.
      const said = <A, R>(call: Effect.Effect<A, { readonly message: string }, R>) =>
        Effect.map(Effect.flip(call), (error) => error.message);
      const refusedIn = (sourceEventId: string) =>
        Effect.all([
          said(invoice(sourceEventId)),
          said(expense(sourceEventId)),
          said(budget(sourceEventId)),
          said(ownersBudget),
          said(goal("new-company-goal")),
        ]);
      // A batch, such as a client with its invoice, saved nothing; one entry wasn't created.
      const saved = countryFirstMessage("Owner", { saved: true });
      // A budget's limit is a change to a setting: nothing was saved.
      const refused = [saved, refusal, saved, refusal, refusal];
      const asked = yield* turn(1, "Invoice Invented Kestrel 1,200 for the brand kit");
      assert.deepStrictEqual(yield* refusedIn(asked), refused);
      // A task works as before; an amount on it is money, and waits too.
      const task = yield* OwnerWork.create(people, {
        orgId,
        title: "Invented: send the brand kit",
        clientRequestId: "new-company-task",
      });
      const priced = OwnerWork.update(people, {
        orgId,
        key: task.key,
        rev: task.rev,
        amount: { minor: 120_000, currency: "GBP" },
      });
      assert.strictEqual((yield* Effect.flip(priced)).message, saved);
      // Dates and a deadline with no fee work; a fee waits. A list asked for now takes no currency.
      yield* defined(2, { template: "dates" });
      const renewals = yield* turn(4, "Track the domain renewal");
      const deadline = (title: string, amount?: string) =>
        LeadWork.create(scope, {
          sourceEventId: renewals,
          records: [
            {
              list: "dates",
              title,
              due: "2026-12-31",
              category: "renewal",
              ...(amount === undefined ? {} : { amount }),
            },
          ],
        });
      yield* deadline("Invented domain renewal");
      assert.strictEqual(yield* said(deadline("Invented licence renewal", "90")), refusal);
      const tracking = yield* turn(5, "Start tracking expenses");
      const expenses = yield* LeadMoney.define(scope, {
        sourceEventId: tracking,
        template: "expenses",
      });
      assert.strictEqual(expenses.status, "proposed");
      assert.deepStrictEqual(
        yield* sql`SELECT register_id AS list FROM kin_records ORDER BY register_id`,
        [{ list: "dates" }, { list: "work" }],
      );
      assert.lengthOf(yield* sql`SELECT 1 FROM kin_money_budgets`, 0);

      // A logo, the owner's Confirm on a details card, a save with no country: still waiting.
      const owner = { _tag: "person" as const, personId: ownerId };
      yield* setProfile(
        orgId,
        owner,
        {
          logo: {
            attachmentId: "kin-chat-invented-png",
            name: "logo.png",
            mimeType: "image/png",
            width: 400,
            height: 120,
            bytes: 1_000,
            sha256: "a".repeat(64),
          },
        },
        undefined,
      );
      yield* LeadMoney.profile(scope, {
        sourceEventId: tracking,
        set: { legalName: "Invented Kestrel Limited" },
      });
      const [card] = yield* sql<{ widgetId: string }>`SELECT widget_id AS "widgetId"
        FROM kin_profile_changes`;
      yield* answerChange({
        orgId,
        widgetId: card!.widgetId,
        personId: ownerId,
        confirmed: true,
        via: "tap",
        now: NOW,
      });
      const rev = () => readProfile(orgId).pipe(Effect.map((one) => one.rev));
      yield* OwnerMoney.setCompanyProfile(people, {
        orgId,
        rev: yield* rev(),
        address: "1 Invented Road",
      });
      yield* OwnerMoney.setCompanyProfile(people, { orgId, rev: yield* rev(), country: null });
      assert.deepInclude(yield* readProfile(orgId), {
        legalName: "Invented Kestrel Limited",
        address: "1 Invented Road",
        country: null,
      });
      assert.isTrue(yield* countryNeeded(orgId));
      assert.deepStrictEqual(yield* refusedIn(yield* turn(6, "Invoice Invented Kestrel")), refused);

      yield* OwnerMoney.setCompanyProfile(people, { orgId, rev: yield* rev(), country: "GB" });
      assert.isFalse(yield* countryNeeded(orgId));
      // The list asked for before is made in pounds; so is Dates, made while waiting.
      const yes = yield* turn(7, "Yes, go ahead");
      yield* LeadMoney.define(scope, { sourceEventId: yes, proposal: expenses.proposal! });
      yield* defined(8, { template: "invoices" });
      const again = yield* turn(10, "Invoice Invented Kestrel 1,200 for the brand kit");
      yield* LeadWork.create(scope, {
        sourceEventId: again,
        records: [
          { list: "clients", title: "Invented Kestrel" },
          {
            list: "invoices",
            title: "Invented brand kit",
            client: "Invented Kestrel",
            amount: "1,200",
          },
          { list: "expenses", title: "Invented fonts", amount: "40", category: "software" },
          { list: "dates", title: "Invented licence renewal", due: "2026-12-31", amount: "90" },
        ],
      });
      yield* LeadMoney.budget(scope, { sourceEventId: again, category: "travel", limit: "500" });
      yield* goal("country-chosen-goal");
      assert.deepStrictEqual(
        yield* sql`SELECT register_id AS list, currency FROM kin_records
          WHERE amount_minor IS NOT NULL ORDER BY register_id`,
        [
          { list: "dates", currency: "GBP" },
          { list: "expenses", currency: "GBP" },
          { list: "invoices", currency: "GBP" },
        ],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT json_extract(fields_json, '$.target.currency') AS currency
          FROM kin_records WHERE register_id = 'goals'`,
        [{ currency: "GBP" }],
      );
      assert.deepStrictEqual(yield* sql`SELECT currency FROM kin_money_budgets`, [
        { currency: "GBP" },
      ]);
      assert.deepStrictEqual(
        yield* sql`SELECT register_id AS list, json_extract(definition_json, '$.currency')
            AS currency, json_extract(definition_json, '$.currencyPending') AS waiting
          FROM kin_registers WHERE built_in = 0 ORDER BY register_id`,
        [
          { list: "dates", currency: "GBP", waiting: null },
          { list: "expenses", currency: "GBP", waiting: null },
          { list: "invoices", currency: "GBP", waiting: null },
        ],
      );
      // Asked for while waiting, Expenses has no country's ways to pay: no UPI in the UK.
      assert.deepStrictEqual(yield* paidWith("expenses"), ["card", "bank", "cash"]);
      // Once chosen, it never waits again, even saved with no country.
      yield* OwnerMoney.setCompanyProfile(people, { orgId, rev: yield* rev(), country: null });
      assert.isFalse(yield* countryNeeded(orgId));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("gives a new company the currency of whichever country it chooses first", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO kin_company_profile (org_id, profile_json, rev, updated_at,
          updated_by_kind, updated_by_id)
        VALUES (${orgId}, ${yield* newCompanyProfileJson}, 1, 0, 'person', ${ownerId})`;
      yield* defined(2, { template: "dates" });
      yield* defined(6, { template: "expenses" });
      // A code that names no country is refused, and the company still waits.
      const unknown = OwnerMoney.setCompanyProfile(people, { orgId, rev: 0, country: "XX" });
      assert.strictEqual(
        (yield* Effect.flip(unknown)).message,
        "Country: XX isn't a country Kin knows. Write its two-letter code, like GB, US or IN.",
      );
      assert.isTrue(yield* countryNeeded(orgId));
      // Japan has no row of its own in Kin's regions: its yen, a calendar year and no tax.
      yield* OwnerMoney.setCompanyProfile(people, { orgId, rev: 0, country: "JP" });
      assert.deepInclude(yield* readProfile(orgId), {
        country: "JP",
        homeCurrency: "JPY",
        financialYearStartMonth: 1,
        tax: null,
      });
      const renewals = yield* turn(8, "Track the domain renewal");
      yield* LeadWork.create(scope, {
        sourceEventId: renewals,
        records: [
          { list: "dates", title: "Invented licence renewal", due: "2026-12-31", amount: "9000" },
        ],
      });
      assert.deepStrictEqual(
        yield* sql`SELECT amount_minor AS minor, currency FROM kin_records
          WHERE amount_minor IS NOT NULL`,
        [{ minor: 9_000, currency: "JPY" }],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT register_id AS list, json_extract(definition_json, '$.currency') AS currency
          FROM kin_registers WHERE built_in = 0 ORDER BY register_id`,
        [
          { list: "dates", currency: "JPY" },
          { list: "expenses", currency: "JPY" },
        ],
      );
      // Made while waiting, it keeps the ways any company pays, not the placeholder's UPI.
      assert.deepStrictEqual(yield* paidWith("expenses"), ["card", "bank", "cash"]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "reads a profile stored before countries by its currency, and a new country as its own",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const nobank = {
          accountName: null,
          accountNumber: null,
          bankName: null,
          branch: null,
          upi: null,
        };
        // Shaped as an Indian company's profile is stored today: no country, year or tax.
        const before = {
          legalName: "Ambermill Private Limited",
          tradeName: null,
          address: null,
          gstin: "29ABCDE1234F1Z5",
          pan: null,
          placeOfSupply: "Karnataka",
          sac: "998314",
          bank: { ...nobank, ifsc: "ABCD0123456" },
          homeCurrency: "INR",
          rates: [],
        };
        yield* sql`INSERT INTO kin_company_profile (org_id, profile_json, rev, updated_at,
          updated_by_kind, updated_by_id)
        VALUES (${orgId}, ${JSON.stringify(before)}, 1, ${NOW}, 'person', 'cos-owner')`;
        const read = () => OwnerMoney.companyProfile(people, { orgId });
        const filings = Effect.gen(function* () {
          const proposal = yield* proposalFor(orgId, { template: "dates" });
          assert(proposal._tag === "new");
          return {
            categories: proposal.definition.categories.slice(0, 2),
            labels: proposal.definition.categoryLabels ?? {},
          };
        });
        const year = Effect.map(OwnerMoney.money(people, { orgId }), (summary) => [
          summary.financialYear,
          summary.financialYearStartMonth,
        ]);
        assert.deepInclude(yield* read(), {
          country: "IN",
          financialYearStartMonth: 4,
          tax: null,
          homeCurrency: "INR",
        });
        assert.deepStrictEqual(yield* filings, { categories: ["gst", "tds"], labels: {} });
        assert.deepStrictEqual(yield* year, ["FY2026-27", 4]);
        // A save from a client that knows no countries stores none, so it still reads as India.
        let rev = (yield* OwnerMoney.setCompanyProfile(people, {
          orgId,
          rev: 1,
          tradeName: "Ambermill",
        })).rev;
        const [stored] = yield* sql<{ country: string | null }>`SELECT json_type(profile_json,
        '$.country') AS country FROM kin_company_profile WHERE org_id = ${orgId}`;
        assert.deepStrictEqual(stored, { country: null });
        assert.include(yield* read(), { country: "IN" });

        // A new country brings its currency and year; the tax given with it stands.
        const vat = { name: "VAT", rate: "20", pricesInclude: null };
        rev = (yield* OwnerMoney.setCompanyProfile(people, { orgId, rev, country: "GB", tax: vat }))
          .rev;
        assert.deepInclude(yield* read(), {
          country: "GB",
          homeCurrency: "GBP",
          financialYearStartMonth: 4,
          tax: vat,
        });
        assert.deepStrictEqual(yield* filings, {
          categories: ["vat", "paye"],
          labels: { vat: "VAT", paye: "PAYE" },
        });
        // An older client's save keeps what it doesn't know.
        rev = (yield* OwnerMoney.setCompanyProfile(people, {
          orgId,
          rev,
          legalName: "Ambermill Ltd",
        })).rev;
        assert.deepInclude(yield* read(), { country: "GB", tax: vat, financialYearStartMonth: 4 });
        assert.deepStrictEqual(yield* year, ["FY2026-27", 4]);

        rev = (yield* OwnerMoney.setCompanyProfile(people, { orgId, rev, country: "US" })).rev;
        assert.deepInclude(yield* read(), {
          homeCurrency: "USD",
          financialYearStartMonth: 1,
          tax: { name: "Sales tax", rate: null, pricesInclude: null },
        });
        assert.deepStrictEqual(yield* year, ["FY2026", 1]);
        yield* defined(1, { template: "invoices" });
        const asked = yield* turn(3, "Draft an invoice for Invented Acme");
        yield* LeadWork.create(scope, {
          sourceEventId: asked,
          records: [
            { list: "clients", title: "Invented Acme" },
            {
              list: "invoices",
              title: "Invented retainer",
              client: "Invented Acme",
              amount: "1,000",
            },
          ],
        });
        assert.strictEqual(
          (yield* OwnerMoney.issue(people, { orgId, key: "INV-1" })).number,
          "INV/2026/001",
        );

        // No country: no tax, a calendar year, and none of India's filings.
        yield* OwnerMoney.setCompanyProfile(people, { orgId, rev, country: null });
        assert.deepInclude(yield* read(), {
          country: null,
          homeCurrency: "USD",
          financialYearStartMonth: 1,
          tax: null,
        });
        const unset = yield* filings;
        assert.deepStrictEqual(unset.labels, {});
        assert.notInclude(unset.categories, "gst");
        assert.notInclude(unset.categories, "tds");
        // Saved with no country, it was never a company made new: its money is made as before.
        const later = yield* turn(5, "Another invoice for Invented Acme");
        yield* LeadWork.create(scope, {
          sourceEventId: later,
          records: [
            { list: "invoices", title: "Invented extra", client: "Invented Acme", amount: "500" },
          ],
        });
        assert.deepInclude(yield* OwnerMoney.issue(people, { orgId, key: "INV-2" }), {
          number: "INV/2026/002",
        });
      }).pipe(Effect.provide(layer)),
  );

  it.effect("is set by the owner, and by a lead only through a card the owner confirms", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const set = yield* OwnerMoney.setCompanyProfile(people, {
        orgId,
        rev: 0,
        legalName: "Invented Private Limited",
        gstin: "29ABCDE1234F1Z5",
        bank: { ifsc: "ABCD0123456" },
      });
      assert.strictEqual(set.rev, 1);
      const stale = yield* OwnerMoney.setCompanyProfile(people, {
        orgId,
        rev: 0,
        tradeName: "Invented",
      }).pipe(Effect.flip);
      assert.include(stale, { reason: "conflict" });
      const asked = yield* turn(1, "What is the weather?");
      const read = yield* LeadMoney.profile(scope, {});
      assert.isTrue(read.sensitive);
      // A lead's set writes nothing: it shows the owner the exact change, old beside new.
      const change = {
        pan: "ABCDE1234F",
        lutNumber: "AD2904260012345",
        lutDate: "2026-04-01",
        bank: { accountNumber: "1234567890", ifsc: "ABCD0123456" },
      };
      const proposed = yield* LeadMoney.profile(scope, { sourceEventId: asked, set: change });
      // Bank details and tax ids, which go on invoices, come first.
      assert.deepStrictEqual(proposed.proposed, [
        "Bank account number: none → 1234567890",
        "PAN: none → ABCDE1234F",
        "LUT number: none → AD2904260012345",
        "LUT date: none → 2026-04-01",
      ]);
      const unchanged = yield* OwnerMoney.companyProfile(people, { orgId });
      assert.deepStrictEqual([unchanged.pan, unchanged.rev], [null, 1]);
      // The same call again is the same card.
      yield* LeadMoney.profile(scope, { sourceEventId: asked, set: change });
      const cards = yield* sql<{ widgetId: string; detail: string }>`SELECT c.widget_id AS
          "widgetId", json_extract(w.state_json, '$.detail') AS detail
        FROM kin_profile_changes c JOIN kin_widgets w ON w.widget_id = c.widget_id`;
      assert.deepStrictEqual(
        cards.map((one) => one.detail),
        [proposed.proposed!.join("\n")],
      );
      const widgetId = cards[0]!.widgetId;
      const answer = (personId: string, confirmed: boolean) =>
        answerChange({ orgId, widgetId, personId, confirmed, via: "tap", now: NOW });

      // Nobody but the owner confirms it; Confirm applies exactly the stored change, once.
      assert.include(yield* Effect.flip(answer("mate", true)), { reason: "not_allowed" });
      const said = yield* answer(ownerId, true);
      assert.strictEqual(said?.title, "Company details changed");
      assert.strictEqual(said?.text, "Saved. Documents made from now on use these details.");
      const after = yield* OwnerMoney.companyProfile(people, { orgId });
      assert.deepStrictEqual(
        [after.legalName, after.pan, after.bank.accountNumber, after.bank.ifsc, after.rev],
        ["Invented Private Limited", "ABCDE1234F", "1234567890", "ABCD0123456", 2],
      );
      assert.deepStrictEqual([after.lutNumber, after.lutDate], ["AD2904260012345", "2026-04-01"]);
      assert.include(yield* Effect.flip(answer(ownerId, true)), { reason: "widget_changed" });

      // A newer card replaces the older one: closed as replaced, and never confirmable.
      const next = yield* turn(2, "Our trade name is Invented");
      yield* LeadMoney.profile(scope, { sourceEventId: next, set: { tradeName: "Invented" } });
      yield* LeadMoney.profile(scope, { sourceEventId: next, set: { address: "1 Invented Road" } });
      const [replaced, outdated] = (yield* sql<{ widgetId: string }>`SELECT widget_id AS
          "widgetId" FROM kin_profile_changes WHERE applied_at IS NULL ORDER BY proposed_at,
          json_extract(patch_json, '$.address') IS NOT NULL`).map((one) => one.widgetId);
      const shown = yield* sql<{ widgetId: string; closed: number; replaced: number | null }>`
        SELECT widget_id AS "widgetId", closed_at IS NOT NULL AS closed,
          json_extract(state_json, '$.replaced') AS replaced
        FROM kin_widgets WHERE widget_id IN ${sql.in([replaced!, outdated!])} ORDER BY closed DESC`;
      assert.deepStrictEqual(shown, [
        { widgetId: replaced!, closed: 1, replaced: 1 },
        { widgetId: outdated!, closed: 0, replaced: null },
      ]);
      const late = yield* Effect.flip(
        answerChange({
          orgId,
          widgetId: replaced!,
          personId: ownerId,
          confirmed: true,
          via: "tap",
          now: NOW,
        }),
      );
      assert.include(late.message, "replaced by a newer one");
      // A card made before another change is refused, not merged; Cancel changes nothing.
      yield* OwnerMoney.setCompanyProfile(people, { orgId, rev: 2, sac: "998314" });
      const refused = yield* Effect.flip(
        answerChange({
          orgId,
          widgetId: outdated!,
          personId: ownerId,
          confirmed: true,
          via: "tap",
          now: NOW,
        }),
      );
      assert.include(refused, { reason: "conflict" });
      assert.include(refused.message, "Ask for the change again");
      yield* answerChange({
        orgId,
        widgetId: outdated!,
        personId: ownerId,
        confirmed: false,
        via: "tap",
        now: NOW,
      });
      const last = yield* OwnerMoney.companyProfile(people, { orgId });
      assert.deepStrictEqual(
        [last.tradeName, last.address, last.sac, last.rev],
        [null, null, "998314", 3],
      );
      // Any other card is none of the profile's business.
      yield* answerChange({
        orgId,
        widgetId: "choice:other",
        personId: ownerId,
        confirmed: true,
        via: "tap",
        now: NOW,
      });

      // A change the card can't show whole is refused before anything is stored or asked.
      yield* OwnerMoney.setCompanyProfile(people, {
        orgId,
        rev: 3,
        legalName: "L".repeat(500),
        tradeName: "T".repeat(500),
        address: "A".repeat(500),
      });
      const long = yield* turn(3, "Update our details");
      const changes = sql`SELECT change_id FROM kin_profile_changes ORDER BY change_id`;
      const before = yield* changes;
      const tooLong = yield* LeadMoney.profile(scope, {
        sourceEventId: long,
        set: {
          legalName: "N".repeat(500),
          tradeName: "U".repeat(500),
          address: "B".repeat(500),
          bank: { accountNumber: "9999999999" },
        },
      }).pipe(Effect.flip);
      assert.include(tooLong.message, "Change fewer fields per request");
      assert.deepStrictEqual(yield* changes, before);
      assert.strictEqual(
        (yield* OwnerMoney.companyProfile(people, { orgId })).bank.accountNumber,
        "1234567890",
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "takes a logo the owner sent in this chat, only through the card, as Kin's own copy",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const fs = yield* FileSystem.FileSystem;
        const { attachmentsDir } = yield* ServerConfig;
        yield* fs.makeDirectory(attachmentsDir, { recursive: true });
        const png = pngOf(400, 120);
        const sent = yield* turn(1, "This is our logo", [
          "logo.png",
          "logo.svg",
          "huge.png",
          "cut.png",
          "cut.jpg",
          "cut.svg",
        ]);
        yield* fs.writeFile(`${attachmentsDir}/att-1-0.png`, png);
        // Files cut short in sending: their headers read, their images don't.
        yield* fs.writeFile(`${attachmentsDir}/att-1-3.png`, png.subarray(0, 60));
        yield* fs.writeFile(`${attachmentsDir}/att-1-4.jpg`, cutJpeg);
        yield* fs.writeFileString(
          `${attachmentsDir}/att-1-5.svg`,
          '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="4',
        );
        yield* fs.writeFileString(
          `${attachmentsDir}/att-1-1.svg`,
          '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
        );
        yield* fs.writeFile(`${attachmentsDir}/att-1-2.png`, pngOf(20_000, 10));
        // The same image, sent in a chat this turn doesn't answer in.
        yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
        VALUES ('elsewhere-chat', ${orgId}, 'direct', 'a:b', 1, ${at})`;
        yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind,
          person_id, role, joined_at)
        VALUES ('else-owner', ${orgId}, 'elsewhere-chat', 'person', ${ownerId}, 'owner', ${at})`;
        yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind,
          author_person_id, author_member_id, author_role, kind, body, mentions_json, status,
          created_at, attachments_json)
        VALUES ('msg-else', ${orgId}, 'elsewhere-chat', 1, 'human', ${ownerId}, 'else-owner',
          'owner', 'text', 'x', '[]', 'posted', ${at}, '[]')`;
        yield* sql`INSERT INTO kin_message_attachments (attachment_id, org_id, chat_id, message_id)
        VALUES ('att-else', ${orgId}, 'elsewhere-chat', 'msg-else')`;
        yield* fs.writeFile(`${attachmentsDir}/att-else.png`, png);
        const refused = (logo: string) =>
          LeadMoney.profile(scope, { sourceEventId: sent, set: { logo } }).pipe(
            Effect.flip,
            Effect.map((error) => error.message),
          );
        assert.match(yield* refused("att-1-1"), /an SVG with <script>\. Nothing changed/);
        assert.match(yield* refused("att-1-2"), /20000 × 10 pixels; a logo is at most 12000/);
        assert.match(yield* refused("att-else"), /not a file in this chat/);
        for (const cut of ["att-1-3", "att-1-4"])
          assert.match(yield* refused(cut), /can't be used: it is cut short or damaged/, cut);
        assert.match(yield* refused("att-1-5"), /That logo can't be used: it is an SVG with/);
        assert.lengthOf(yield* sql`SELECT 1 FROM kin_profile_changes`, 0);

        const proposed = yield* LeadMoney.profile(scope, {
          sourceEventId: sent,
          // Named as its message shows it, not by id.
          set: { logo: "logo.png", brand: { primaryColor: "#0A5C8F" } },
        });
        assert.deepStrictEqual(proposed.proposed, [
          "Logo: none → logo.png (PNG, 400 × 120 px, 1 KB)",
          "Brand colour: none → #0A5C8F",
        ]);
        assert.isNull((yield* OwnerMoney.companyProfile(people, { orgId })).logo);
        // The card shows the image itself, the owner's own file in the chat.
        const [card] = yield* sql<{ widgetId: string; image: string }>`SELECT c.widget_id AS
          "widgetId", json_extract(w.state_json, '$.image') AS image
        FROM kin_profile_changes c JOIN kin_widgets w ON w.widget_id = c.widget_id`;
        assert.deepStrictEqual(JSON.parse(card!.image), {
          attachmentId: "att-1-0",
          mimeType: "image/png",
        });
        yield* answerChange({
          orgId,
          widgetId: card!.widgetId,
          personId: ownerId,
          confirmed: true,
          via: "tap",
          now: NOW,
        });
        const profile = yield* OwnerMoney.companyProfile(people, { orgId });
        const logo = profile.logo!;
        assert.match(logo.attachmentId, /^kin-chat-[0-9a-f-]+-png$/);
        assert.deepStrictEqual(
          [logo.mimeType, logo.width, logo.height, profile.brand.primaryColor],
          ["image/png", 400, 120, "#0A5C8F"],
        );
        // Clearing the chat keeps it: the profile holds Kin's own copy, the bytes as sent.
        yield* fs.remove(`${attachmentsDir}/att-1-0.png`);
        assert.deepStrictEqual(
          yield* fs.readFile(`${attachmentsDir}/${logo.attachmentId}.png`),
          png,
        );
        // The owner clears it from the profile; a client never sets a file.
        const cleared = yield* OwnerMoney.setCompanyProfile(people, {
          orgId,
          rev: profile.rev,
          logo: null,
        });
        assert.isNull(cleared.logo);
      }).pipe(Effect.provide(layer)),
  );
});

describe("money answers", () => {
  const inr = (rupees: number) => ({ minor: rupees * 100, currency: "INR" });
  const owner = { _tag: "person" as const, personId: ownerId };
  /** Midday UTC: the same calendar day in India. */
  const on = (day: string) => Date.parse(`${day}T12:00:00.000Z`);
  const dueOn = (day: string) => endOfDay(day, "Asia/Kolkata");
  /** A read statement; confirmed unless said otherwise, adding up unless `check` says not. */
  const statement = (
    id: string,
    input: {
      readonly account: string | null;
      readonly currency: string;
      readonly to: string;
      readonly closing: number | null;
      readonly from?: string;
      readonly opening?: number;
      readonly bank?: string;
      readonly status?: string;
      readonly standing?: "confirmed" | "unconfirmed" | "undone";
      readonly check?: "adds_up" | "off";
      readonly kind?: "account" | "card";
      /** Rows as Kin read them, kept whole: what a confirmed match points at. */
      readonly readRows?: ReadonlyArray<unknown>;
      /** As a CSV export gives them: no period or balances printed, a running balance per row. */
      readonly rows?: ReadonlyArray<readonly [string, "credit" | "debit", number, number]>;
    },
  ) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const csv = input.rows !== undefined;
      const review = {
        statement: {
          kind: input.kind ?? "account",
          bank: input.bank ?? null,
          account: input.account,
          currency: input.currency,
          from: input.from ?? null,
          to: csv ? null : input.to,
          openingMinor: input.opening ?? null,
          closingMinor: input.closing,
          rows:
            input.readRows ??
            (input.rows ?? []).map(([date, direction, amountMinor, balanceMinor], index) => ({
              index,
              date,
              description: "Invented row",
              reference: null,
              amountMinor,
              direction,
              balanceMinor,
              foreign: null,
            })),
          check: { status: input.check ?? "adds_up", line: "" },
        },
        format: "csv",
        source: "file",
        known: [],
        matches: [],
      };
      const standing = input.standing ?? "confirmed";
      const readAt = Date.parse(`${input.to}T00:00:00Z`);
      yield* sql`INSERT INTO kin_bank_statements (org_id, statement_id, attachment_id, file_name,
          chat_id, agent_id, wakeup_id, status, review_json, created_at, read_at, applied_at,
          undone_at)
        VALUES (${orgId}, ${id}, ${`att-${id}`}, 'invented.csv', 'lead-chat', ${lead}, 'wake-0',
          ${input.status ?? "read"}, ${JSON.stringify(review)}, 0, ${readAt},
          ${standing === "confirmed" ? readAt : null}, ${standing === "undone" ? readAt : null})`;
    });

  it.effect(
    "estimate several currencies at the owner's rates only, and say what a budget leaves out",
    () =>
      Effect.gen(function* () {
        yield* seed;
        yield* OwnerMoney.setCompanyProfile(people, {
          orgId,
          rev: 0,
          homeCurrency: "USD",
          rates: [{ currency: "EUR", rate: "1.08", asOf: "2026-11-10" }],
        });
        yield* defined(1, { template: "invoices" });
        const asked = yield* turn(3, "Invoice Invented Brightwell in three currencies");
        yield* LeadWork.create(scope, {
          sourceEventId: asked,
          records: [
            ["Invented dollar retainer", "USD 1,000"],
            ["Invented euro retainer", "EUR 500"],
            ["Invented dirham retainer", "AED 2,000"],
          ].map(([title, amount]) => ({
            list: "invoices",
            title: title!,
            amount: amount!,
            date: "2026-11-01",
            due: "2026-12-01",
          })),
        });
        yield* issueAll("INV-1", "INV-2", "INV-3");
        const summary = yield* OwnerMoney.money(people, { orgId });
        assert.deepStrictEqual(summary.owed.total, [
          { minor: 100_000, currency: "USD" },
          { minor: 200_000, currency: "AED" },
          { minor: 50_000, currency: "EUR" },
        ]);
        // $1,000 and €500 at 1.08; no AED rate is set, so none is used.
        assert.deepStrictEqual(summary.about?.owed, {
          home: "USD",
          total: { minor: 154_000, currency: "USD" },
          missing: ["AED"],
        });
        assert.deepStrictEqual(moneySection(summary, summary.timeZone)?.about?.owedToUs, {
          home: "USD",
          total: "$1,540",
          missing: ["AED"],
        });
        // Nothing overdue and nothing received: no figure to estimate.
        assert.deepStrictEqual(
          Object.entries(summary.about ?? {}).flatMap(([key, one]) =>
            one === undefined ? [] : [key],
          ),
          ["owed"],
        );

        yield* defined(4, { template: "expenses" });
        const records = yield* KinRecords.KinRecords;
        const made = new Map<string, { recordId: string; key: string }>();
        for (const [key, money] of [
          ["flight", { minor: 30_000, currency: "USD" }],
          ["hotel", { minor: 76_800, currency: "EUR" }],
        ] as const) {
          const { row } = yield* records.create(orgId, system, {
            list: "expenses",
            title: `Invented ${key}`,
            owner,
            state: "done",
            category: "travel",
            amount: money,
            dateAt: on("2026-11-05"),
            originKey: key,
          });
          made.set(key, row);
        }
        yield* OwnerMoneyAnswers.setBudget(people, {
          orgId,
          category: "travel",
          project: null,
          currency: "USD",
          limitMinor: 50_000,
          clientRequestId: "travel-usd",
        });
        const now = yield* Clock.currentTimeMillis;
        assert.deepInclude(budgetsAnswer(yield* budgetsView(orgId, now)).budgets[0], {
          spent: "$300.00",
          notCounted: [{ currency: "EUR", spent: "€768.00" }],
        });
        assert.deepInclude((yield* OwnerMoneyAnswers.budgets(people, { orgId })).budgets[0], {
          spent: { minor: 30_000, currency: "USD" },
          notCounted: [{ currency: "EUR", spent: { minor: 76_800, currency: "EUR" } }],
        });
        assert.deepStrictEqual((yield* OwnerMoney.money(people, { orgId })).about?.spentThisMonth, {
          home: "USD",
          total: { minor: 112_900, currency: "USD" },
          missing: [],
        });
        // Once a confirmed card statement matches it to its line, the hotel counts at the $835.10
        // that line charged, not at the owner's one rate.
        yield* ensureBankList(orgId, now);
        const { row: bank } = yield* records.create(orgId, system, {
          list: "bank_transactions",
          title: "Invented card hotel charge",
          owner,
          amount: { minor: 83_510, currency: "USD" },
          dateAt: on("2026-11-06"),
          originKey: "hotel-bank",
        });
        const hotel = made.get("hotel")!;
        yield* statement("st_card", {
          kind: "card",
          account: "4321",
          currency: "USD",
          to: "2026-11-30",
          closing: 83_510,
          readRows: [
            {
              index: 0,
              date: "2026-11-06",
              amountMinor: 83_510,
              direction: "debit",
              description: "INVENTED HOTEL EUR 768.00",
              reference: null,
              balanceMinor: null,
              foreign: { currency: "EUR", amountMinor: 76_800 },
            },
          ],
        });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO kin_bank_statement_entries (org_id, statement_id, seq, row_index,
            bank_record_id, action, target_record_id)
          VALUES (${orgId}, 'st_card', 1, 0, ${bank.recordId}, 'expense_linked', ${hotel.recordId})`;
        const evidence = records.link(orgId, system, hotel.recordId, {
          kind: "record",
          target: bank.recordId,
          relation: "evidence",
        });
        const spent = (minor: number) =>
          Effect.gen(function* () {
            assert.deepStrictEqual(
              (yield* OwnerMoney.money(people, { orgId })).about?.spentThisMonth,
              { home: "USD", total: { minor, currency: "USD" }, missing: [] },
            );
          });
        yield* evidence;
        yield* spent(113_500);
        // Remove link takes the match off the expense, not the statement's entry: back to the rate.
        const [hotelLink] = yield* sql<{ shown: string; at: number }>`SELECT
            COALESCE(label, target) AS shown, created_at AS at FROM kin_record_links
          WHERE org_id = ${orgId} AND record_id = ${hotel.recordId} AND target = ${bank.recordId}`;
        assert.isTrue(
          yield* records.unlink(orgId, system, hotel.recordId, { kind: "record", ...hotelLink! }),
        );
        yield* spent(112_900);
        yield* evidence;
        yield* spent(113_500);
        // Corrected to €800 after the match, the line no longer answers it: back to the rate.
        yield* records.update(orgId, system, hotel.key, {
          amount: { minor: 80_000, currency: "EUR" },
        });
        assert.deepStrictEqual((yield* OwnerMoney.money(people, { orgId })).about?.spentThisMonth, {
          home: "USD",
          total: { minor: 116_400, currency: "USD" },
          missing: [],
        });
        // The euros have a budget of their own now, so the dollar one leaves nothing out.
        yield* OwnerMoneyAnswers.setBudget(people, {
          orgId,
          category: "travel",
          project: null,
          currency: "EUR",
          limitMinor: 100_000,
          clientRequestId: "travel-eur",
        });
        const both = budgetsAnswer(yield* budgetsView(orgId, now)).budgets;
        assert.deepStrictEqual(
          both.map((one) => [one.limit, "notCounted" in one]),
          [
            ["€1,000.00", false],
            ["$500.00", false],
          ],
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "give cash only from confirmed statements, one account per proven chain, unknown with none",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const now = yield* Clock.currentTimeMillis;
        assert.deepStrictEqual(cashAnswer(yield* cashPosition(orgId, now)).known, false);
        yield* defined(1, { template: "invoices" });
        yield* defined(3, { template: "expenses" });
        const records = yield* KinRecords.KinRecords;
        // Read but never confirmed: no balance of record, though Kin says what it read.
        yield* statement("st_unconfirmed", {
          bank: "HDFC Bank",
          account: "1234",
          currency: "INR",
          from: "2026-10-01",
          to: "2026-10-31",
          opening: 300_000_00,
          closing: 400_000_00,
          standing: "unconfirmed",
        });
        const unconfirmed = cashAnswer(yield* cashPosition(orgId, now));
        assert.isFalse(unconfirmed.known);
        // A statement read but not confirmed says nothing of how far Kin sees the bank.
        assert.isNull((yield* cashPosition(orgId, now)).bank.through);
        assert.deepStrictEqual(unconfirmed.notOfRecord, [
          {
            account: "HDFC Bank Account ••1234",
            closingBalance: "₹4,00,000.00",
            on: "2026-10-31",
            standing: "not yet confirmed",
          },
        ]);
        yield* sql`DELETE FROM kin_bank_statements`;
        // October, then November opening on October's closing: one account, its latest balance.
        yield* statement("st_oct", {
          bank: "HDFC Bank",
          account: "1234",
          currency: "INR",
          from: "2026-10-01",
          to: "2026-10-31",
          opening: 300_000_00,
          closing: 400_000_00,
        });
        yield* statement("st_nov", {
          bank: "HDFC Bank",
          account: "1234",
          currency: "INR",
          from: "2026-11-01",
          to: "2026-11-08",
          opening: 400_000_00,
          closing: 500_000_00,
        });
        // A newer read of it the owner hasn't confirmed sits beside it, never in a figure.
        yield* statement("st_nov_read", {
          bank: "HDFC Bank",
          account: "1234",
          currency: "INR",
          from: "2026-11-01",
          to: "2026-11-10",
          opening: 400_000_00,
          closing: 900_000_00,
          standing: "unconfirmed",
        });
        yield* statement("st_usd", {
          account: "9876",
          currency: "USD",
          to: "2026-10-01",
          closing: 2_000_00,
        });
        yield* statement("st_off", {
          account: "7777",
          currency: "INR",
          to: "2026-11-09",
          closing: 1,
          check: "off",
        });
        yield* statement("st_undone", {
          account: "8888",
          currency: "INR",
          to: "2026-11-09",
          closing: 2,
          standing: "undone",
        });
        yield* statement("st_scan", {
          account: "5555",
          currency: "INR",
          to: "2026-11-10",
          closing: 1,
          status: "scanned",
        });
        const { row } = yield* records.create(orgId, system, {
          list: "invoices",
          title: "Invented retainer",
          owner,
          amount: inr(50_000),
          originKey: "inv",
        });
        // Money in after the statement, and TDS the client kept, which is no cash.
        for (const [minor, withheld] of [
          [20_000_00, false],
          [2_000_00, true],
        ] as const)
          yield* records.pay(orgId, system, row.key, {
            amount: { minor, currency: "INR" },
            paidOn: "2026-11-09",
            originKey: `pay:${minor}`,
            withheld,
          });
        yield* records.create(orgId, system, {
          list: "expenses",
          title: "Invented hosting",
          owner,
          state: "done",
          category: "software",
          amount: inr(5_000),
          dateAt: on("2026-11-10"),
          originKey: "hosting",
        });
        const answer = cashAnswer(yield* cashPosition(orgId, now));
        if (!answer.known) return assert.fail(answer.note);
        assert.deepStrictEqual(answer.accounts, [
          {
            account: "HDFC Bank Account ••1234",
            closingBalance: "₹5,00,000.00",
            on: "2026-11-08",
            daysOld: 4,
            newerRead: {
              closingBalance: "₹9,00,000.00",
              on: "2026-11-10",
              standing: "not yet confirmed",
            },
          },
          {
            account: "Account ••9876",
            closingBalance: "$2,000.00",
            on: "2026-10-01",
            daysOld: 42,
            stale: "No statement covers the 42 days since 2026-10-01.",
          },
        ]);
        assert.deepStrictEqual(
          answer.notOfRecord?.map((one) => [one.account, one.standing]),
          [
            ["Account ••7777", "its totals don't check out"],
            ["Account ••8888", "its confirm was undone"],
          ],
        );
        const [rupees, dollars] = answer.byCurrency;
        assert.deepStrictEqual(rupees, {
          currency: "INR",
          accounts: 1,
          totalOfTheseAccounts: "₹5,00,000.00",
          recordedSince: {
            since: "2026-11-08",
            account: "not known",
            in: "₹20,000.00",
            out: "₹5,000.00",
          },
          estimate: {
            now: "₹5,15,000.00",
            label: "An estimate, not a bank figure.",
            assumes:
              "Every payment and paid expense recorded since 2026-11-08 moved through the account above, and the company has no other INR account.",
          },
        });
        assert.deepStrictEqual(dollars?.estimate?.now, "$2,000.00");
        // Confirmed bank lines, totals off or not, set how far Kin sees each account; undone,
        // scanned and unconfirmed reads don't. The company sees as far as its earliest account.
        const { bank } = yield* cashPosition(orgId, now);
        assert.deepStrictEqual(
          bank.accounts.map((one) => [one.label, one.from, one.through]),
          [
            ["Account ••7777", "2026-11-09", "2026-11-09"],
            ["Account ••9876", "2026-10-01", "2026-10-01"],
            ["HDFC Bank Account ••1234", "2026-10-01", "2026-11-08"],
          ],
        );
        assert.strictEqual(bank.through, "2026-10-01");
        // Every money answer an agent reads says it beside its figures, each account on cash.
        yield* turn(9, "How much cash do we have, and what is owed?");
        const seen = {
          knownThrough: "2026-10-01",
          note: "The confirmed bank statements cover every day to 2026-10-01 on the accounts Kin has; Kin can't see the bank after that day.",
        };
        const asked = yield* LeadMoney.moneyQuery(scope, { view: "cash" });
        assert.deepInclude(asked.bank, seen);
        assert.lengthOf((asked.bank?.accounts ?? []) as ReadonlyArray<unknown>, 3);
        assert.deepStrictEqual(
          (yield* LeadMoney.moneyQuery(scope, { view: "outlook" })).bank,
          seen,
        );
        assert.deepStrictEqual((yield* LeadMoney.money(scope, {})).bank, seen);

        // A second HDFC ••1234 balance Kin can't link to the first is listed apart, and INR has no
        // total, estimate or runway.
        yield* statement("st_twin", {
          bank: "HDFC Bank",
          account: "1234",
          currency: "INR",
          from: "2026-10-01",
          to: "2026-10-31",
          opening: 10_000_00,
          closing: 70_000_00,
        });
        const twins = cashAnswer(yield* cashPosition(orgId, now));
        if (!twins.known) return assert.fail(twins.note);
        assert.deepStrictEqual(
          twins.accounts.map((one) => [one.account, one.closingBalance, one.cannotTellApart]),
          [
            ["HDFC Bank Account ••1234", "₹70,000.00", true],
            ["HDFC Bank Account ••1234", "₹5,00,000.00", true],
            ["Account ••9876", "$2,000.00", undefined],
          ],
        );
        const [withheld] = twins.byCurrency;
        if (withheld === undefined || !("totalWithheld" in withheld)) return assert.fail("a total");
        assert.isUndefined(withheld.estimate);
        assert.include(withheld.totalWithheld, "can't tell");
        const [runway] = outlookAnswer(yield* outlook(orgId, now)).runway;
        assert.deepStrictEqual(
          [runway?.currency, runway?.runwayMonths, runway?.cash],
          ["INR", null, undefined],
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "read one account's monthly CSV statements as one account, whatever each said of its digits",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        yield* TestClock.setTime(Date.parse("2026-12-06T02:45:00.000Z"));
        const now = yield* Clock.currentTimeMillis;
        const october = [
          ["2026-10-01", "credit", 1_800_00, 1_800_00],
          ["2026-10-30", "credit", 47_150_00, 48_950_00],
          ["2026-10-31", "debit", 50_00, 48_900_00],
        ] as const;
        const november = [
          ["2026-11-01", "debit", 100_00, 48_800_00],
          ["2026-11-30", "debit", 40_00, 48_760_00],
        ] as const;
        const december = [
          ["2026-12-01", "debit", 110_00, 48_650_00],
          ["2026-12-31", "debit", 60_00, 48_590_00],
        ] as const;
        const csv = (
          id: string,
          account: string | null,
          rows: ReadonlyArray<readonly [string, "credit" | "debit", number, number]>,
        ) => statement(id, { account, currency: "INR", to: rows.at(-1)![0], closing: null, rows });
        const seen = Effect.gen(function* () {
          const cash = yield* cashPosition(orgId, now);
          const answer = cashAnswer(cash);
          if (!answer.known) return assert.fail(answer.note);
          return {
            accounts: answer.accounts.map((one) => [one.account, one.closingBalance, one.on]),
            apart: answer.accounts.some((one) => one.cannotTellApart === true),
            total: answer.byCurrency.map((one) =>
              "totalOfTheseAccounts" in one ? one.totalOfTheseAccounts : null,
            ),
            through: cash.bank.through,
            known: cash.bank.accounts.map((one) => [one.label, one.from, one.through]),
          };
        });
        // October stored before the file's account column was read, November with its digits.
        yield* csv("st_oct", null, october);
        yield* csv("st_nov", "1234", november);
        assert.deepStrictEqual(yield* seen, {
          accounts: [["Account ••1234", "₹48,760.00", "2026-11-30"]],
          apart: false,
          total: ["₹48,760.00"],
          through: "2026-11-30",
          known: [["Account ••1234", "2026-10-01", "2026-11-30"]],
        });
        // December runs to the 31st on the 6th: Kin sees the bank to today, not past it.
        yield* csv("st_dec", "1234", december);
        assert.deepStrictEqual(yield* seen, {
          accounts: [["Account ••1234", "₹48,590.00", "2026-12-31"]],
          apart: false,
          total: ["₹48,590.00"],
          through: "2026-12-06",
          known: [["Account ••1234", "2026-10-01", "2026-12-06"]],
        });
        // October and December without November: one account with a gap, seen to October's end.
        yield* sql`DELETE FROM kin_bank_statements`;
        yield* csv("st_oct", "1234", october);
        yield* csv("st_dec", "1234", december);
        assert.deepStrictEqual(yield* seen, {
          accounts: [["Account ••1234", "₹48,590.00", "2026-12-31"]],
          apart: false,
          total: ["₹48,590.00"],
          through: "2026-10-31",
          known: [["Account ••1234", "2026-10-01", "2026-10-31"]],
        });
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "count what partners are owed as going out, and their expenses in runway only once repaid",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
          VALUES ('meera', ${orgId}, 'meera', 'Meera', ${at}, 'co_owner'),
            ('arjun', ${orgId}, 'arjun', 'Arjun', ${at}, 'member')`;
        yield* defined(3, { template: "expenses" });
        const records = yield* KinRecords.KinRecords;
        const spend = (key: string, day: string, rupees: number, fields = {}) =>
          records.create(orgId, system, {
            owner,
            originKey: key,
            list: "expenses",
            title: `Invented ${key}`,
            state: "done",
            amount: inr(rupees),
            dateAt: on(day),
            fields,
          });
        for (const day of ["2026-08-01", "2026-09-10", "2026-10-10"])
          yield* spend(`payroll ${day}`, day, 100_000);
        yield* spend("repaid", "2026-09-12", 20_000, {
          fundedBy: "person:meera",
          reimbursement: "repaid",
          repaidOn: "2026-10-20",
        });
        yield* spend("owed", "2026-10-02", 5_000, { fundedBy: "person:meera" });
        yield* spend("given", "2026-08-03", 7_000, {
          fundedBy: "person:meera",
          reimbursement: "not reimbursable",
        });
        // As an import left them before K208: an address that paid, and nothing said yet.
        const imported = (key: string, day: string, rupees: number, address: string) =>
          Effect.gen(function* () {
            const { row } = yield* spend(key, day, rupees);
            yield* sql`UPDATE kin_records SET fields_json = json_set(fields_json,
                '$.paidPersonallyBy', ${address}) WHERE record_id = ${row.recordId}`;
            return row.key;
          });
        const first = yield* imported("domain", "2026-09-01", 3_000, "meera@invented.example");
        const second = yield* imported(
          "laptop",
          "2026-10-05",
          60_000,
          "Meera.Home@invented.example",
        );
        const figures = Effect.gen(function* () {
          const { paidPersonallyNotYetSaid: _unsaid, ...view } = outlookAnswer(
            yield* outlook(orgId, NOW),
          );
          return { view, cash: cashAnswer(yield* cashPosition(orgId, NOW)) };
        });

        // K208 again on a list it hadn't reached: no figure moves, nothing is marked owed.
        const fields = yield* sql<{ json: string }>`SELECT definition_json AS json
          FROM kin_registers WHERE org_id = ${orgId} AND register_id = 'expenses'`;
        const definition = JSON.parse(fields[0]!.json) as {
          fields: ReadonlyArray<{ key: string }>;
        };
        const before = JSON.stringify({
          ...definition,
          fields: definition.fields.filter(
            (one) => !["fundedBy", "reimbursement", "repaidOn"].includes(one.key),
          ),
        });
        yield* sql`UPDATE kin_registers SET definition_json = ${before}, built_in = 0
          WHERE org_id = ${orgId} AND register_id = 'expenses'`;
        const unmigrated = yield* figures;
        yield* sql`DELETE FROM kin_sql_migrations WHERE migration_id >= 208`;
        yield* runKinMigrations();
        assert.deepStrictEqual(yield* figures, unmigrated);

        const view = outlookAnswer(yield* outlook(orgId, NOW));
        assert.deepStrictEqual(
          view.windows.map((one) => one.expectedOut),
          ["₹5,000.00", "₹5,000.00", "₹5,000.00"],
        );
        assert.deepStrictEqual(view.owedToPartnersCountedAsGoingOut, [
          { partner: "Meera", owed: "₹5,000.00", expenses: 1 },
        ]);
        assert.deepStrictEqual(view.paidPersonallyNotYetSaid, [
          { address: "meera.home@invented.example", total: "₹60,000.00", expenses: 1 },
          { address: "meera@invented.example", total: "₹3,000.00", expenses: 1 },
        ]);
        // Repaid in October, so not September's; owed and given never left the company; an
        // import not yet said counts on its own day, as it did before.
        assert.deepStrictEqual(
          view.runway[0]?.lastThreeMonths.map((one) => [one.month, one.out]),
          [
            ["2026-08", "₹1,00,000.00"],
            ["2026-09", "₹1,03,000.00"],
            ["2026-10", "₹1,80,000.00"],
          ],
        );

        const as = (personId: string) => [
          { _tag: "person" as const, orgId, personId: KinPersonId.make(personId) },
        ];
        const match = (address: string, settled: "owed" | "repaid") => ({
          orgId,
          address,
          personId: KinPersonId.make("meera"),
          settled,
        });
        assert.strictEqual(
          (yield* Effect.flip(
            OwnerMoneyAnswers.matchPartner(as("arjun"), match("meera@invented.example", "owed")),
          ))._tag,
          "KinChatError",
        );
        // A co-owner says the first was paid back long ago: every figure stays where it was.
        assert.deepStrictEqual(
          yield* OwnerMoneyAnswers.matchPartner(
            as("meera"),
            match(" Meera@Invented.example", "repaid"),
          ),
          { matched: [first] },
        );
        const { paidPersonallyNotYetSaid: _left, ...settledView } = outlookAnswer(
          yield* outlook(orgId, NOW),
        );
        assert.deepStrictEqual(settledView, unmigrated.view);
        // The owner says the second is still owed: it goes out now and leaves October's spend.
        assert.deepStrictEqual(
          yield* OwnerMoneyAnswers.matchPartner(
            people,
            match("meera.home@invented.example", "owed"),
          ),
          { matched: [second] },
        );
        const owed = yield* OwnerMoneyAnswers.outlook(people, { orgId });
        assert.strictEqual(owed.partnersUnsaid, undefined);
        assert.deepStrictEqual(owed.owedToPartners, [
          {
            personId: KinPersonId.make("meera"),
            name: "Meera",
            address: null,
            owed: [inr(65_000)],
            expenses: 2,
            oldest: "2026-10-02",
          },
        ]);
        const after = outlookAnswer(yield* outlook(orgId, NOW));
        assert.deepStrictEqual(
          after.runway[0]?.lastThreeMonths.map((one) => [one.month, one.out]),
          [
            ["2026-08", "₹1,00,000.00"],
            ["2026-09", "₹1,03,000.00"],
            ["2026-10", "₹1,20,000.00"],
          ],
        );
        const asked = yield* LeadMoney.moneyQuery(scope, { view: "partners" });
        assert.deepStrictEqual(
          (
            asked.answer as { partners: ReadonlyArray<{ oldest: ReadonlyArray<{ key: string }> }> }
          ).partners[0]?.oldest.map((one) => one.key),
          ["EXP-5", second],
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "owe each partner the net of their list per currency, and count each expense once, when repaid",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
          VALUES ('meera', ${orgId}, 'meera', 'Meera', ${at}, 'co_owner'),
            ('dev', ${orgId}, 'dev', 'Dev Malhotra', ${at}, 'member')`;
        yield* defined(3, { template: "expenses" });
        const records = yield* KinRecords.KinRecords;
        const spend = (
          key: string,
          day: string,
          money: { minor: number; currency: string },
          fields: Record<string, string>,
          state: "done" | "dropped" = "done",
        ) =>
          records.create(orgId, system, {
            owner,
            originKey: key,
            list: "expenses",
            title: `Invented ${key}`,
            state,
            amount: money,
            dateAt: on(day),
            fields,
          });
        const meera = { fundedBy: "person:meera" };
        yield* spend("domain", "2026-09-01", inr(4_200), meera);
        yield* spend("domain refund", "2026-09-03", inr(-1_000), meera);
        yield* spend("font licence", "2026-09-04", { minor: 3_000, currency: "USD" }, meera);
        const { row: suggested } = yield* spend("suggested", "2026-09-05", inr(900), meera);
        yield* sql`UPDATE kin_records SET confirmed = 0 WHERE record_id = ${suggested.recordId}`;
        yield* spend("dropped", "2026-09-06", inr(800), meera, "dropped");
        yield* spend("train", "2026-10-01", inr(500), { fundedBy: "person:dev" });

        const partners = yield* partnersOwed(orgId, "INR");
        // Each figure is the sum of its own list, per currency, refunds taking their part off.
        for (const partner of partners)
          assert.deepStrictEqual(
            partner.owed,
            addUp(
              partner.entries.map((one) => one.money),
              "INR",
            ),
          );
        assert.deepStrictEqual(
          partners.map((one) => [one.name, one.owed, one.entries.map((entry) => entry.key)]),
          [
            ["Meera", [inr(3_200), { minor: 3_000, currency: "USD" }], ["EXP-1", "EXP-2", "EXP-3"]],
            ["Dev Malhotra", [inr(500)], ["EXP-6"]],
          ],
        );
        const outOf = Effect.gen(function* () {
          const view = yield* outlook(orgId, NOW);
          return {
            out: view.windows[0]!.expectedOut,
            spent: Object.fromEntries(
              view.runway.map((one) => [
                one.currency,
                one.months.map((month) => [month.month, Number(month.spent)]),
              ]),
            ),
          };
        });
        // Owed: going out now, in no month's spending; the suggestion and the dropped one nowhere.
        assert.deepStrictEqual(yield* outOf, {
          out: [inr(3_700), { minor: 3_000, currency: "USD" }],
          spent: {},
        });

        // Paid back on 2026-10-20: out of what is owed, into October's spending, once.
        for (const key of ["EXP-1", "EXP-2", "EXP-3", "EXP-6"])
          yield* records.update(orgId, system, key, {
            fields: { reimbursement: "repaid", repaidOn: "2026-10-20" },
          });
        assert.deepStrictEqual(yield* partnersOwed(orgId, "INR"), []);
        assert.deepStrictEqual(yield* outOf, {
          out: [],
          spent: {
            INR: [
              ["2026-08", 0],
              ["2026-09", 0],
              ["2026-10", 370_000],
            ],
            USD: [
              ["2026-08", 0],
              ["2026-09", 0],
              ["2026-10", 3_000],
            ],
          },
        });
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "count a partner's expense in the month and the week's out on the day it was repaid",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
          VALUES ('meera', ${orgId}, 'meera', 'Meera', ${at})`;
        yield* defined(3, { template: "expenses" });
        const records = yield* KinRecords.KinRecords;
        const spend = (key: string, day: string, rupees: number, fields = {}) =>
          records.create(orgId, system, {
            owner,
            originKey: key,
            list: "expenses",
            title: `Invented ${key}`,
            state: "done",
            amount: inr(rupees),
            dateAt: on(day),
            fields,
          });
        const partner = "person:meera";
        yield* spend("company", "2026-11-09", 1_000);
        yield* spend("owed", "2026-11-10", 2_000, { fundedBy: partner });
        yield* spend("repaid in the week", "2026-10-01", 4_000, {
          fundedBy: partner,
          reimbursement: "repaid",
          repaidOn: "2026-11-11",
        });
        // Repaid with no day: counted on the day it was bought, as runway does.
        yield* spend("repaid, no day", "2026-11-07", 8_000, {
          fundedBy: partner,
          reimbursement: "repaid",
        });
        yield* spend("given", "2026-11-08", 16_000, {
          fundedBy: partner,
          reimbursement: "not reimbursable",
        });

        const { series } = yield* OwnerMoney.money(people, { orgId });
        const spentIn = (month: string) => series.find((one) => one.month === month)?.spent;
        assert.deepStrictEqual(spentIn("2026-11"), [inr(13_000)]);
        assert.deepStrictEqual(spentIn("2026-10"), []);
        const figures = yield* weeklyFigures({ orgId, now: NOW });
        assert.include(figures, "Out this week: ₹13,000.00");
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "name an imported address however the import wrote it, and say when nothing is left to name",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
          VALUES ('meera', ${orgId}, 'meera', 'Meera', ${at}, 'member'),
            ('co-owner', ${orgId}, 'co', 'Co', ${at}, 'co_owner')`;
        yield* defined(3, { template: "expenses" });
        const records = yield* KinRecords.KinRecords;
        const spend = (key: string, fields = {}) =>
          records.create(orgId, system, {
            owner,
            originKey: key,
            list: "expenses",
            title: `Invented ${key}`,
            state: "done",
            amount: inr(1_000),
            dateAt: on("2026-10-05"),
            fields,
          });
        // A CSV's tab, CR and NBSP and a non-ASCII capital, which SQLite's trim and lower keep.
        const { row: imported } = yield* spend("imported");
        const raw = "\tPARTNÉR@Invented.example\u00a0\r";
        yield* sql`UPDATE kin_records SET fields_json = json_set(fields_json, '$.paidPersonallyBy',
            ${raw}) WHERE record_id = ${imported.recordId}`;
        assert.deepStrictEqual(
          (yield* OwnerMoneyAnswers.outlook(people, { orgId })).partnersUnsaid?.map(
            (one) => one.address,
          ),
          ["partnér@invented.example"],
        );
        const as = (personId: string) => [
          { _tag: "person" as const, orgId, personId: KinPersonId.make(personId) },
        ];
        // As the picker sends it: the address as Money grouped it.
        const match = {
          orgId,
          address: "partnér@invented.example",
          personId: KinPersonId.make("meera"),
        };
        const refused = (who: typeof people, input: typeof match) =>
          Effect.map(Effect.flip(OwnerMoneyAnswers.matchPartner(who, input)), (e) => e.message);
        assert.match(yield* refused(as("meera"), match), /owner|co-owner/i);
        assert.match(
          yield* refused(people, { ...match, address: "other@invented.example" }),
          /No expense owed to a partner carries that address/,
        );
        assert.match(yield* refused(people, match), /still owes them for these/);
        // Owner level: a co-owner may say who it was, and that it is still owed.
        assert.deepStrictEqual(
          yield* OwnerMoneyAnswers.matchPartner(as("co-owner"), { ...match, settled: "owed" }),
          { matched: [imported.key] },
        );
        assert.match(yield* refused(people, match), /already say who funded them/);

        // Marked owed by hand with no partner and no address: a person can still be named for it.
        const { row: nameless } = yield* spend("nameless", { reimbursement: "owed" });
        const unnamed = (yield* OwnerMoneyAnswers.outlook(people, { orgId })).owedToPartners?.find(
          (one) => one.personId === null,
        );
        assert.deepInclude(unnamed, { address: null, expenses: 1 });
        assert.deepStrictEqual(
          yield* OwnerMoneyAnswers.matchPartner(people, {
            orgId,
            personId: KinPersonId.make("meera"),
          }),
          { matched: [nameless.key] },
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "expect issued invoices in and what we owe out, never overdue or void invoices, with runway",
    () =>
      Effect.gen(function* () {
        yield* seed;
        yield* defined(1, { template: "invoices" });
        yield* defined(3, { template: "expenses" });
        yield* defined(7, { template: "quotes" });
        const records = yield* KinRecords.KinRecords;
        const create = (key: string, input: Omit<KinRecords.CreateInput, "originKey" | "owner">) =>
          records.create(orgId, system, { owner, originKey: key, ...input });
        // A quote we sent is neither owed by us nor counted as coming in.
        yield* create("quote", {
          list: "quotes",
          title: "Invented quoted work",
          amount: inr(70_000),
          state: "waiting",
          dueAt: dueOn("2026-11-20"),
          dueAllDay: true,
        });
        // Quotes add up what is out and what was won; a draft is not counted in either.
        yield* create("draft", { list: "quotes", title: "Invented draft", amount: inr(9_000) });
        const quoted = yield* records.totals(orgId, { list: "quotes" });
        assert.deepStrictEqual([quoted.sent, quoted.accepted], [[inr(70_000)], []]);
        const invoices = [
          ["Invented retainer", inr(118_000), "2026-11-30", "waiting"],
          ["Invented build", inr(50_000), "2026-12-25", "waiting"],
          ["Invented overdue", inr(30_000), "2026-10-31", "waiting"],
          ["Invented void", inr(99_000), "2026-11-20", "dropped"],
          ["Invented export", { minor: 1_000_00, currency: "USD" }, "2026-12-01", "waiting"],
        ] as const;
        for (const [title, amount, due, state] of invoices)
          yield* create(title, {
            list: "invoices",
            title,
            amount,
            state,
            dueAt: dueOn(due),
            dueAllDay: true,
          });
        yield* records.pay(orgId, system, "INV-1", {
          amount: inr(2_000),
          paidOn: "2026-11-05",
          originKey: "tds",
          withheld: true,
        });
        // Three complete months: August, September and October.
        const { row: paidLater } = yield* create("august", {
          list: "invoices",
          title: "Invented August work",
          amount: inr(50_000),
          dateAt: on("2026-08-01"),
        });
        yield* records.pay(orgId, system, paidLater.key, {
          amount: inr(50_000),
          paidOn: "2026-09-05",
          originKey: "september",
        });
        for (const day of ["2026-08-10", "2026-09-10", "2026-10-10"])
          yield* create(day, {
            list: "expenses",
            title: "Invented payroll",
            state: "done",
            category: "contractors",
            amount: inr(100_000),
            dateAt: on(day),
          });
        yield* create("rent", {
          list: "expenses",
          title: "Invented rent",
          state: "open",
          category: "rent",
          amount: inr(40_000),
          dueAt: dueOn("2026-11-15"),
          dueAllDay: true,
          repeat: { every: "month" },
        });
        yield* create("laptop", {
          list: "expenses",
          title: "Invented laptop",
          state: "open",
          category: "hardware",
          amount: inr(60_000),
          dueAt: dueOn("2026-11-01"),
          dueAllDay: true,
        });
        yield* statement("st", {
          account: "1234",
          currency: "INR",
          to: "2026-11-08",
          closing: 500_000_00,
        });

        // Older than August, but none of it is cash history: TDS, a void invoice's payment, and
        // dollars, which say nothing of rupees.
        const { row: voided } = yield* create("void-july", {
          list: "invoices",
          title: "Invented voided July work",
          amount: inr(10_000),
        });
        const { row: settled } = yield* create("tds-july", {
          list: "invoices",
          title: "Invented July work",
          amount: inr(1_000),
        });
        for (const [key, originKey, withheld] of [
          [settled.key, "tds-july", true],
          [voided.key, "void-july", false],
        ] as const)
          yield* records.pay(orgId, system, key, {
            amount: inr(1_000),
            paidOn: "2026-07-15",
            originKey,
            withheld,
          });
        yield* records.update(orgId, system, voided.key, { state: "dropped" });
        yield* create("usd-july", {
          list: "expenses",
          title: "Invented export fee",
          state: "done",
          amount: { minor: 10_00, currency: "USD" },
          dateAt: on("2026-07-01"),
        });
        // History from 10 August is no three complete months, so no runway yet.
        const partial = outlookAnswer(yield* outlook(orgId, yield* Clock.currentTimeMillis));
        assert.deepStrictEqual(
          partial.runway.map((one) => [one.currency, one.runwayMonths]),
          [["INR", null]],
        );
        assert.include(
          partial.runway[0] && "why" in partial.runway[0] ? partial.runway[0].why : "",
          "start 2026-08-10: not three complete months",
        );
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE kin_records SET date_at = ${on("2026-08-01")}
          WHERE origin_key = '2026-08-10'`;

        const asked = yield* turn(
          5,
          "What's coming in and going out, and how long does cash last?",
        );
        const result = yield* LeadMoney.moneyQuery(scope, { view: "outlook" });
        assert.strictEqual(result.sensitive, true);
        assert.isDefined(asked);
        const view = result.answer as ReturnType<typeof outlookAnswer>;
        assert.deepStrictEqual(view.windows, [
          {
            days: 30,
            through: "2026-12-12",
            expectedIn: "₹1,16,000.00 + $1,000.00",
            expectedOut: "₹1,00,000.00",
            net: "₹16,000.00 + $1,000.00",
          },
          {
            days: 60,
            through: "2027-01-11",
            expectedIn: "₹1,66,000.00 + $1,000.00",
            expectedOut: "₹1,40,000.00",
            net: "₹26,000.00 + $1,000.00",
          },
          {
            days: 90,
            through: "2027-02-10",
            expectedIn: "₹1,66,000.00 + $1,000.00",
            expectedOut: "₹1,80,000.00",
            net: "-₹14,000.00 + $1,000.00",
          },
        ]);
        assert.deepStrictEqual(
          view.overdueNotCounted.map((one) => [one.key, one.balance]),
          [["INV-3", "₹30,000.00"]],
        );
        assert.notInclude(JSON.stringify(view), "INV-4");
        assert.deepStrictEqual(
          view.goingOut.map((one) => [one.title, one.on, one.amount, one.repeats ?? false]),
          [
            ["Invented rent", "2026-11-15", "₹40,000.00", false],
            ["Invented rent", "2026-12-15", "₹40,000.00", true],
            ["Invented rent", "2027-01-15", "₹40,000.00", true],
          ],
        );
        assert.deepStrictEqual(
          view.pastDueCountedAsGoingOut?.map((one) => one.title),
          ["Invented laptop"],
        );
        assert.deepStrictEqual(view.runway, [
          {
            currency: "INR",
            lastThreeMonths: [
              { month: "2026-08", in: "₹0.00", out: "₹1,00,000.00", net: "-₹1,00,000.00" },
              { month: "2026-09", in: "₹50,000.00", out: "₹1,00,000.00", net: "-₹50,000.00" },
              { month: "2026-10", in: "₹0.00", out: "₹1,00,000.00", net: "-₹1,00,000.00" },
            ],
            averageMonthlyNet: "-₹83,333.33",
            cash: "₹5,00,000.00",
            cashAsOf: "2026-11-08",
            runwayMonths: "6.0",
          },
        ]);
        // One chosen window instead of three.
        const week = (yield* LeadMoney.moneyQuery(scope, { view: "outlook", days: 7 }))
          .answer as ReturnType<typeof outlookAnswer>;
        assert.deepStrictEqual(
          week.windows.map((one) => [one.days, one.expectedIn, one.expectedOut]),
          [[7, "none", "₹1,00,000.00"]],
        );
        // A daily charge set up two years ago still counts every day ahead: the past is skipped.
        yield* create("coffee", {
          list: "expenses",
          title: "Invented coffee",
          state: "open",
          amount: inr(10),
          dueAt: dueOn("2024-11-01"),
          dueAllDay: true,
          repeat: { every: "days", days: 1 },
        });
        yield* create("credit", {
          list: "expenses",
          title: "Invented recurring credit",
          state: "open",
          amount: inr(-500),
          dueAt: dueOn("2026-11-13"),
          dueAllDay: true,
          repeat: { every: "days", days: 1 },
        });
        const daily = (yield* LeadMoney.moneyQuery(scope, { view: "outlook", days: 7 }))
          .answer as ReturnType<typeof outlookAnswer>;
        assert.isFalse(daily.goingOut.some((one) => one.title === "Invented recurring credit"));
        assert.deepStrictEqual(
          [
            daily.goingOut.filter((one) => one.title === "Invented coffee").map((one) => one.on),
            daily.incomplete,
          ],
          [
            [
              "2026-11-12",
              "2026-11-13",
              "2026-11-14",
              "2026-11-15",
              "2026-11-16",
              "2026-11-17",
              "2026-11-18",
              "2026-11-19",
            ],
            undefined,
          ],
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "hold the owner's monthly budgets against paid expenses in the owner's month, only for the owner",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        yield* defined(1, { template: "expenses" });
        yield* presetList(orgId, "invoices", yield* Clock.currentTimeMillis);
        const records = yield* KinRecords.KinRecords;
        const { row: launch } = yield* records.create(orgId, system, {
          list: "projects",
          title: "Invented launch",
          owner,
          originKey: "launch",
        });
        const spend = (
          key: string,
          category: string,
          rupees: number,
          at: number,
          projectId?: string,
        ) =>
          records.create(orgId, system, {
            list: "expenses",
            title: `Invented ${key}`,
            owner,
            state: "done",
            category,
            amount: inr(rupees),
            dateAt: at,
            ...(projectId === undefined ? {} : { projectId }),
            originKey: key,
          });
        // 20:00 UTC on 31 October is already 1 November in India; 19:00 UTC on 30 November is December.
        yield* spend("flight", "travel", 12_000, Date.parse("2026-10-31T20:00:00.000Z"));
        yield* spend("train", "travel", 3_000, Date.parse("2026-11-30T19:00:00.000Z"));
        yield* spend("hosting", "software", 5_000, on("2026-11-10"));
        yield* spend("dinner", "meals", 20_000, on("2026-11-11"), launch.recordId);

        const asked = yield* turn(
          3,
          "Budget 10k a month for travel, 5k for software, 1 lakh for the launch",
        );
        const made = yield* LeadWork.create(scope, {
          sourceEventId: asked,
          records: [
            {
              list: "expenses",
              title: "Invented refund",
              category: "travel",
              amount: "-500",
              date: "2026-11-05",
            },
          ],
        });
        assert.strictEqual((yield* records.get(orgId, made.records[0]!.key))?.amountMinor, -50_000);
        const { row: invoice } = yield* records.create(orgId, system, {
          list: "invoices",
          title: "Invented invoice",
          owner,
          amount: inr(100),
          originKey: "invoice",
        });
        assert.include(
          yield* LeadWork.update(scope, {
            sourceEventId: asked,
            key: invoice.key,
            amount: "-500",
          }).pipe(Effect.flip),
          { reason: "invalid_state" },
        );
        assert.include(
          yield* records
            .pay(orgId, system, invoice.key, {
              amount: inr(-500),
              paidOn: "2026-11-05",
              originKey: "negative-payment",
            })
            .pipe(Effect.flip),
          { message: "A payment is more than nothing." },
        );
        assert.include(
          yield* LeadMoney.budget(scope, {
            sourceEventId: asked,
            category: "travel",
            limit: "-500",
          }).pipe(Effect.flip),
          { reason: "invalid_state" },
        );
        for (const input of [
          { category: "Travel", limit: "10k" },
          { category: "software", limit: "5,000" },
          { project: launch.key, limit: "1 lakh" },
        ])
          yield* LeadMoney.budget(scope, { sourceEventId: asked, ...input });
        const refused = yield* LeadMoney.budget(scope, {
          sourceEventId: asked,
          category: "Invented snacks",
          limit: "1k",
        }).pipe(Effect.flip);
        assert.include(refused.message, "Expenses have no category Invented snacks");

        const now = yield* Clock.currentTimeMillis;
        assert.deepStrictEqual(budgetsAnswer(yield* budgetsView(orgId, now)).budgets, [
          {
            for: "software",
            limit: "₹5,000.00",
            spent: "₹5,000.00",
            left: "₹0.00",
            expenses: 1,
            status: "near",
          },
          {
            for: "travel",
            limit: "₹10,000.00",
            spent: "₹11,500.00",
            over: "₹1,500.00",
            expenses: 2,
            status: "over",
          },
          {
            for: `Invented launch (${launch.key})`,
            limit: "₹1,00,000.00",
            spent: "₹20,000.00",
            left: "₹80,000.00",
            expenses: 1,
            status: "ok",
          },
        ]);
        assert.deepStrictEqual(
          (yield* budgetFlags(orgId, now))?.budgets.map((one) => [one.for, one.status]),
          [
            ["software", "near"],
            ["travel", "over"],
          ],
        );
        const spent = (yield* OwnerMoney.money(people, { orgId })).spent.thisMonth;
        assert.deepStrictEqual(spent.total, [{ minor: 3_650_000, currency: "INR" }]);
        const december = yield* LeadMoney.moneyQuery(scope, { view: "budgets", month: "2026-12" });
        assert.strictEqual(
          (december.answer as ReturnType<typeof budgetsAnswer>).budgets[1]?.spent,
          "₹3,000.00",
        );
        // A retry of the same message repeats its outcome; another value under it is refused.
        const retried = yield* LeadMoney.budget(scope, {
          sourceEventId: asked,
          category: "travel",
          limit: "10k",
        });
        assert.deepStrictEqual([retried.status, retried.now], ["set", "₹10,000.00"]);
        assert.include(
          yield* LeadMoney.budget(scope, {
            sourceEventId: asked,
            category: "travel",
            limit: "20k",
          }).pipe(Effect.flip),
          { reason: "not_allowed" },
        );
        // The way out: a budget the owner drops is gone, and says what it was.
        const drop = yield* turn(5, "Drop the travel budget");
        const removed = yield* LeadMoney.budget(scope, {
          sourceEventId: drop,
          category: "travel",
          limit: null,
        });
        assert.deepStrictEqual(
          [
            removed.status,
            removed.was,
            (removed.answer as ReturnType<typeof budgetsAnswer>).budgets.length,
          ],
          ["removed", "₹10,000.00", 2],
        );
        // A budget only in dollars is removed without naming its currency; with two, Kin asks.
        const dollars = yield* turn(6, "Meals $50 and software $100 too");
        for (const [category, limit] of [
          ["meals", "$50"],
          ["software", "$100"],
        ] as const)
          yield* LeadMoney.budget(scope, { sourceEventId: dollars, category, limit });
        const meals = yield* turn(7, "Remove the meals and software budgets");
        const gone = yield* LeadMoney.budget(scope, {
          sourceEventId: meals,
          category: "meals",
          limit: null,
        });
        assert.deepStrictEqual([gone.status, gone.was], ["removed", "$50.00"]);
        assert.include(
          (yield* LeadMoney.budget(scope, {
            sourceEventId: meals,
            category: "software",
            limit: null,
          }).pipe(Effect.flip)).message,
          "INR and USD",
        );
        const none = yield* LeadMoney.budget(scope, {
          sourceEventId: meals,
          category: "travel",
          limit: null,
        });
        assert.deepStrictEqual([none.status, none.was], ["none", "none"]);
        assert.deepStrictEqual(
          (yield* budgetsView(orgId, now)).budgets.map((one) => [one.category, one.currency]),
          [
            ["software", "INR"],
            ["software", "USD"],
            [null, "INR"],
          ],
        );
        assert.deepStrictEqual((yield* budgetsView(otherOrg, now)).budgets, []);

        // The owner's app sets, changes and removes one; a retry of the same tap repeats it.
        const app = (limitMinor: number | null, clientRequestId: string) =>
          OwnerMoneyAnswers.setBudget(people, {
            orgId,
            category: "Meals",
            project: launch.key,
            currency: "INR",
            limitMinor,
            clientRequestId,
          });
        const launchMeals = (view: Effect.Success<ReturnType<typeof app>>) =>
          view.budgets.find((one) => one.category === "meals" && one.project !== null);
        assert.deepInclude(launchMeals(yield* app(1_000_000, "tap-1")), {
          limit: { minor: 1_000_000, currency: "INR" },
          spent: { minor: 2_000_000, currency: "INR" },
          status: "over",
        });
        assert.deepInclude(launchMeals(yield* app(1_000_000, "tap-1")), { status: "over" });
        assert.deepInclude(launchMeals(yield* app(5_000_000, "tap-2")), { status: "ok" });
        assert.isUndefined(launchMeals(yield* app(null, "tap-3")));
        assert.include(
          yield* OwnerMoneyAnswers.setBudget(people, {
            orgId,
            category: "Invented snacks",
            project: null,
            currency: "INR",
            limitMinor: 100,
            clientRequestId: "tap-4",
          }).pipe(Effect.flip),
          { reason: "invalid_state" },
        );
        // A teammate's app reads and sets none of Money's answers.
        yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
          VALUES ('teammate', ${orgId}, 'teammate', 'Teammate', ${at})`;
        const teammate = [
          { _tag: "person" as const, orgId, personId: KinPersonId.make("teammate") },
        ];
        for (const refused of [
          Effect.asVoid(OwnerMoneyAnswers.cash(teammate, { orgId })),
          Effect.asVoid(OwnerMoneyAnswers.outlook(teammate, { orgId })),
          Effect.asVoid(OwnerMoneyAnswers.budgets(teammate, { orgId })),
          Effect.asVoid(OwnerMoneyAnswers.entryLines(teammate, { orgId, key: launch.key })),
          Effect.asVoid(
            OwnerMoneyAnswers.invoiceFromQuote(teammate, {
              orgId,
              key: launch.key,
              clientRequestId: "tap-5",
            }),
          ),
          Effect.asVoid(
            OwnerMoneyAnswers.setBudget(teammate, {
              orgId,
              category: "travel",
              project: null,
              currency: "INR",
              limitMinor: 100,
              clientRequestId: "tap-6",
            }),
          ),
        ])
          assert.include(yield* Effect.flip(refused), { reason: "not_allowed" });

        // A routine, or a request another lead passed on, sets no budget: the owner didn't ask.
        for (const [n, tag, json] of [
          [8, "routine", { routine: "morning_brief" }],
          [
            9,
            "chat.message",
            {
              chatId: "lead-chat",
              messageId: "msg-9",
              origin: { agentId: "other", chatId: "lead-chat" },
            },
          ],
        ] as const) {
          const eventId = yield* turn(n, "Set travel to 1k");
          yield* sql`UPDATE kin_events SET tag = ${tag},
              json = json_patch(json, ${JSON.stringify({ _tag: tag, ...json })})
            WHERE event_id = ${eventId}`;
          const refusal = yield* LeadMoney.budget(scope, {
            sourceEventId: eventId,
            category: "travel",
            limit: "1k",
          }).pipe(Effect.flip);
          assert.include(refusal, { reason: "not_allowed" });
          assert.include(refusal.message, "Propose it to the owner", tag);
        }

        // A turn someone besides the owner reads gets no money figure and sets no budget.
        const shared = yield* turn(4, "How much cash do we have?");
        yield* sql`UPDATE kin_wakeups SET audience = 'shared' WHERE wakeup_id = 'wake-4'`;
        for (const view of ["cash", "outlook", "budgets"] as const)
          assert.include(
            yield* LeadMoney.moneyQuery(scope, { view }).pipe(Effect.flip),
            { reason: "not_allowed" },
            view,
          );
        assert.include(
          yield* LeadMoney.budget(scope, {
            sourceEventId: shared,
            category: "travel",
            limit: "1",
          }).pipe(Effect.flip),
          { reason: "not_allowed" },
        );
      }).pipe(Effect.provide(layer)),
  );
});
