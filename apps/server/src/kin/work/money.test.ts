// Loaded first: the chat and trigger modules import each other.
import "../chat/KinChatService.ts";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  KinAgentId,
  KinOrgId,
  KinPersonId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import { KinLevelGate } from "../lead/LevelGate.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import { answerChange } from "./companyProfile.ts";
import * as KinRecords from "./KinRecords.ts";
import * as LeadMoney from "./leadMoney.ts";
import * as LeadWork from "./leadWork.ts";
import { addUp, financialYearOf, parseAmount } from "./money.ts";
import { moneySection } from "./moneyViews.ts";
import * as OwnerMoney from "./ownerMoney.ts";
import * as OwnerWork from "./ownerWork.ts";

// Invented org, people, amounts and files only; nothing here reads a real database.
const orgId = KinOrgId.make("org");
const otherOrg = KinOrgId.make("elsewhere");
const ownerId = KinPersonId.make("owner");
const lead = KinAgentId.make("lead");
const at = "2026-11-11T00:00:00.000Z";
const NOW = Date.parse("2026-11-12T06:00:00.000Z");
const people = [{ _tag: "person" as const, orgId, personId: ownerId }];
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
    }),
  ),
);
const layer = Layer.mergeAll(KinRecords.layer, identity, gate).pipe(
  Layer.provideMerge(KinEventQueue.layer),
  Layer.provideMerge(KinPersistence.layer),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
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

/** Proposes a list in one turn and creates it from the owner's yes in the next. */
const defined = (n: number, input: Omit<typeof LeadMoney.DefineInput.Type, "sourceEventId">) =>
  Effect.gen(function* () {
    const asked = yield* turn(n, "Start tracking this");
    const proposed = yield* LeadMoney.define(scope, { sourceEventId: asked, ...input });
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
    ] as const)
      assert.deepStrictEqual(parseAmount(text, "INR"), { money: { minor, currency } }, text);
    for (const text of ["12.345", "$5 and ₹5", "a lot", "JPY 1.5", "99999999999999 crore"])
      assert.isTrue("error" in parseAmount(text, "INR"), text);
  });

  it("adds awkward amounts exactly and never mixes currencies", () => {
    const tenths = Array.from({ length: 10 }, () => ({ minor: 10, currency: "INR" }));
    assert.deepStrictEqual(
      addUp([
        ...tenths,
        { minor: 1, currency: "USD" },
        { minor: Number.MAX_SAFE_INTEGER - 100, currency: "EUR" },
        { minor: 100, currency: "EUR" },
        { minor: 2, currency: "USD" },
      ]),
      [
        { minor: 100, currency: "INR" },
        { minor: Number.MAX_SAFE_INTEGER, currency: "EUR" },
        { minor: 3, currency: "USD" },
      ],
    );
    assert.throws(() =>
      addUp([
        { minor: Number.MAX_SAFE_INTEGER, currency: "INR" },
        { minor: 1, currency: "INR" },
      ]),
    );
  });

  it("puts 31 March and 1 April in different financial years", () => {
    assert.strictEqual(financialYearOf("2026-03-31"), "FY2025-26");
    assert.strictEqual(financialYearOf("2026-04-01"), "FY2026-27");
    assert.strictEqual(financialYearOf("2099-12-31"), "FY2099-00");
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
      const created = yield* LeadWork.create(scope, {
        sourceEventId: yes,
        records: [
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
        ],
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
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "take a tap only on the proposal's own card, a typed yes for all pending, and a No as final",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const asked = yield* turn(1, "Track invoices and expenses, and dates too");
        const invoices = yield* LeadMoney.define(scope, {
          sourceEventId: asked,
          template: "invoices",
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
          WHERE p.proposal_id = ${invoices.proposal!}`;
        assert.strictEqual(card!.widgetId, cardOf(`kin-list:${invoices.proposal!}`));
        assert.include(JSON.parse(card!.state).question, "Invoices");
        assert.include(JSON.parse(card!.state).detail, "Invoice number (text)");
        const define = (sourceEventId: string, proposal: string) =>
          LeadMoney.define(scope, { sourceEventId, proposal });

        // A teammate's tap is no answer, and nor is the owner's yes on some other question.
        yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
          VALUES ('mate', ${orgId}, 'mate', 'Mate', ${at})`;
        const strangers = yield* tap(2, cardOf(`kin-list:${invoices.proposal!}`), "yes", "mate");
        assert.include(yield* Effect.flip(define(strangers, invoices.proposal!)), {
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
        assert.strictEqual((yield* define(later, invoices.proposal!)).status, "defined");
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
        // The suggestion waits for the owner, who confirms it once they've read the receipt.
        const blurry = yield* records.get(orgId, kept.records[1]!.key);
        assert.strictEqual(blurry!.confirmed, 0);
        yield* OwnerWork.confirm(people, { orgId, key: blurry!.key, rev: blurry!.rev });
        assert.strictEqual((yield* records.get(orgId, blurry!.key))!.confirmed, 1);
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
      const asked = yield* turn(1, "Track invoices");
      const proposed = yield* LeadMoney.define(scope, {
        sourceEventId: asked,
        template: "invoices",
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
    }).pipe(Effect.provide(layer)),
  );
});

describe("invoices", () => {
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
            due: "2026-11-01",
          },
        ],
      });
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
      assert.strictEqual(summary.owed.byClient[0]!.oldestOverdueDays, 10);
      assert.deepStrictEqual(summary.received.thisMonth, [{ minor: 4_000_000, currency: "INR" }]);
      // The morning summary's section carries the same figures, formatted in code.
      const section = moneySection(summary, summary.timeZone);
      assert.deepStrictEqual(
        [section?.owedToUs, section?.byClient[0]?.daysOverdue],
        ["₹60,000.00", 10],
      );

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
        records: [{ list: "invoices", title: "Invented retainer", amount: "1 lakh" }],
      });
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
            due: "2026-11-01",
          },
          { list: "invoices", title: "Invented one-off", amount: "50,000", due: "2026-12-01" },
          {
            list: "invoices",
            title: "Invented old audit",
            client: "Invented Birch",
            amount: "10,000",
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
      yield* OwnerMoney.recordPayment(people, {
        orgId,
        key: "INV-1",
        amount: { minor: 4_000_000, currency: "INR" },
        paidOn: "2026-11-05",
        clientRequestId: "p1",
      });
      const summary = yield* OwnerMoney.money(people, { orgId });
      const open = (filter: Omit<Parameters<typeof OwnerWork.list>[1], "orgId" | "totalsBy">) =>
        OwnerWork.list(people, { orgId, totalsBy: "none", ...filter });
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
      const month = { paidFrom: "2026-11-01", paidTo: "2026-11-30" };
      const received = yield* open({ list: "invoices", ...month });
      assert.deepStrictEqual(
        [summary.received.thisMonth, received.totals?.received],
        [inr(4_000_000), inr(4_000_000)],
      );
      const dated = { dateFrom: "2026-11-01", dateTo: "2026-11-30" };
      const spent = yield* open({ list: "expenses", states: ["done"], ...dated });
      assert.deepStrictEqual(
        [summary.spent.thisMonth.total, spent.totals?.total],
        [inr(950_000), inr(950_000)],
      );
      // Longest overdue first, whatever the amounts.
      assert.deepStrictEqual(
        summary.owed.byClient.map((row) => [row.party?.title ?? null, row.oldestOverdueDays]),
        [
          ["Invented Birch", 71],
          ["Invented Acme", 10],
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
        [["Invented taxi"], inr(50_000)],
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
        bank: { accountNumber: "1234567890", ifsc: "ABCD0123456" },
      };
      const proposed = yield* LeadMoney.profile(scope, { sourceEventId: asked, set: change });
      // Bank details and tax ids, which go on invoices, come first.
      assert.deepStrictEqual(proposed.proposed, [
        "Bank account number: none → 1234567890",
        "PAN: none → ABCDE1234F",
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
      yield* answer(ownerId, true);
      const after = yield* OwnerMoney.companyProfile(people, { orgId });
      assert.deepStrictEqual(
        [after.legalName, after.pan, after.bank.accountNumber, after.bank.ifsc, after.rev],
        ["Invented Private Limited", "ABCDE1234F", "1234567890", "ABCD0123456", 2],
      );
      assert.include(yield* Effect.flip(answer(ownerId, true)), { reason: "widget_changed" });

      // Cancel changes nothing, and a card made before another change is refused, not merged.
      const next = yield* turn(2, "Our trade name is Invented");
      yield* LeadMoney.profile(scope, { sourceEventId: next, set: { tradeName: "Invented" } });
      yield* LeadMoney.profile(scope, { sourceEventId: next, set: { address: "1 Invented Road" } });
      const [cancelled, outdated] = (yield* sql<{ widgetId: string }>`SELECT widget_id AS
          "widgetId" FROM kin_profile_changes WHERE applied_at IS NULL ORDER BY proposed_at,
          json_extract(patch_json, '$.address') IS NOT NULL`).map((one) => one.widgetId);
      yield* answerChange({
        orgId,
        widgetId: cancelled!,
        personId: ownerId,
        confirmed: false,
        via: "tap",
        now: NOW,
      });
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
});
