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
import * as KinPersistence from "../persistence/KinPersistence.ts";
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
const layer = Layer.mergeAll(KinRecords.layer, identity).pipe(
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
    "take the owner's Yes tap on the agent's question as the answer, and nobody else's",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const asked = yield* turn(1, "Track our invoices");
        const proposed = yield* LeadMoney.define(scope, {
          sourceEventId: asked,
          template: "invoices",
        });
        // The agent's question, as a card in the chat after the proposal.
        yield* sql`UPDATE kin_chats SET last_seq = 2 WHERE chat_id = 'lead-chat'`;
        yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind,
          author_agent_id, author_owner_person_id, author_thread_id, author_member_id,
          author_role, kind, body, mentions_json, status, created_at)
        VALUES ('card', ${orgId}, 'lead-chat', 2, 'agent', ${lead}, ${ownerId}, 'lead-thread',
          'lead-chat-lead', 'member', 'text', 'Set up Invoices?', '[]', 'posted', ${at})`;
        const tap = (n: number, personId: string) =>
          Effect.gen(function* () {
            yield* sql`UPDATE kin_wakeups SET status = 'completed' WHERE status = 'running'`;
            yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, model,
              started_at, status, event_ids, audience)
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
              messageId: "card",
              actionId: "yes",
            };
            yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json,
              received_at, queued_at, state, wakeup_id)
            VALUES (${`event-${n}`}, ${orgId}, ${lead}, 'widget.action', 'P0',
              ${JSON.stringify(event)}, 0, 0, 'claimed', ${`wake-${n}`})`;
            return `event-${n}`;
          });
        const strangers = yield* tap(3, "mate");
        assert.include(
          yield* Effect.flip(
            LeadMoney.define(scope, { sourceEventId: strangers, proposal: proposed.proposal! }),
          ),
          { reason: "not_allowed" },
        );
        const owners = yield* tap(4, ownerId);
        const made = yield* LeadMoney.define(scope, {
          sourceEventId: owners,
          proposal: proposed.proposal!,
        });
        assert.strictEqual(made.status, "defined");
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
  it.effect("is set by the owner, or by a lead only when the owner asked in this turn", () =>
    Effect.gen(function* () {
      yield* seed;
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
      const asked = yield* turn(1, "Our PAN is ABCDE1234F");
      const read = yield* LeadMoney.profile(scope, {});
      assert.isTrue(read.sensitive);
      yield* LeadMoney.profile(scope, { sourceEventId: asked, set: { pan: "ABCDE1234F" } });
      const after = yield* OwnerMoney.companyProfile(people, { orgId });
      assert.deepStrictEqual(
        [after.legalName, after.pan, after.bank.ifsc, after.rev],
        ["Invented Private Limited", "ABCDE1234F", "ABCD0123456", 2],
      );
    }).pipe(Effect.provide(layer)),
  );
});
