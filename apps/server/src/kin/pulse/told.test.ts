import { assert, describe, it } from "@effect/vitest";
import {
  KinAgentId,
  KinChatId,
  KinMemoryItemId,
  KinWakeupId,
  type KinPulseFact,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { leadWakeup } from "../lead/LeadDelivery.testkit.ts";
import { fixture, orgId, seed } from "../triggers/routines.testkit.ts";
import { queueCheckIn } from "./checkIn.ts";
import * as KinPulse from "./KinPulse.ts";
import { factSig, settleCheckInTold, toldBy } from "./told.ts";

// Invented facts only.
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MONDAY = Date.UTC(2026, 10, 16, 9);
const iso = (ms: number) => DateTime.makeUnsafe(ms);
const fact = (over: Partial<KinPulseFact>): KinPulseFact => ({
  sense: "invoice_overdue",
  family: "money",
  key: "invoice_overdue:INV-9",
  subject: { kind: "record", key: "INV-9", title: "Invented invoice" },
  scope: {},
  since: iso(MONDAY - 10 * DAY),
  consequence: "Invented amount owed",
  actor: { _tag: "owner" },
  sensitive: true,
  wake: "sweep",
  handled: null,
  ...over,
});

it.effect.each([
  { body: "W-62 is waiting.", kept: ["W-62"] },
  { body: "Please SEND THE ERP FOLLOW-UP. W-620 is separate.", kept: ["W-62"] },
  { body: "Pay is too short a title, and W-620 is another task.", kept: [] },
  { body: "One decision is ready.", card: "Can we start W-62?", kept: ["W-62"] },
  { body: "AMBERMILL STUDIO needs a decision.", client: "Ambermill Studio", kept: ["W-62"] },
  { body: "One decision is ready.", handle: true, kept: ["W-62"] },
  { body: undefined, handle: true, kept: [] },
])("records only what a check-in names or handles ($body, handle $handle)", (row) =>
  Effect.gen(function* () {
    yield* seed();
    yield* TestClock.setTime(MONDAY);
    const sql = yield* SqlClient.SqlClient;
    const agentId = KinAgentId.make("lead-a");
    const chatId = KinChatId.make("chat-a");
    yield* sql`INSERT INTO kin_trigger_settings VALUES (${orgId}, 'UTC', '08:30', '18:30',
      '03:00', 0, 1, '09:00', '[]')`;
    yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in, created_at)
      VALUES (${orgId}, 'work', 'Work', 'W', 1, 0), (${orgId}, 'clients', 'Clients', 'C', 1, 0)`;
    if (row.client !== undefined)
      yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, state,
          owner_kind, owner_id, fields_json, created_by_kind, origin_key, created_at, updated_at)
        VALUES (${orgId}, 'client', 'clients', 'C-1', ${row.client}, 'open', 'agent', ${agentId},
          '{}', 'person', 'client', ${MONDAY}, ${MONDAY})`;
    const keys = ["W-62", "W-7"];
    for (const [index, title] of [" Send the ERP follow-up ", "Pay"].entries()) {
      const key = keys[index]!;
      yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, state,
          owner_kind, owner_id, party_id, due_at, fields_json, created_by_kind, origin_key, created_at, updated_at)
        VALUES (${orgId}, ${key}, 'work', ${key}, ${title}, 'open', 'agent', ${agentId},
          ${index === 0 && row.client !== undefined ? "client" : null},
          ${MONDAY - DAY}, '{}', 'person', ${key}, 0, 0)`;
    }
    const queue = (at: number) =>
      queueCheckIn({
        orgId,
        agentId,
        scheduleId: KinMemoryItemId.make("checkin-afternoon"),
        title: "Afternoon check-in",
        what: "Afternoon check-in.",
        dueAt: at,
        looseAt: null,
        at,
        zone: "UTC",
        outside: { lines: [], seen: [] },
      });
    assert.include(yield* queue(MONDAY), { _tag: "queued", facts: 2 });
    const [event] = yield* sql<{ eventId: string }>`SELECT event_id AS "eventId" FROM kin_events
      WHERE org_id = ${orgId} AND tag = 'pulse' ORDER BY queued_at`;
    const eventId = event!.eventId;
    const wakeupId = KinWakeupId.make(`wakeup-${eventId}`);
    const messageId = yield* leadWakeup({
      orgId,
      eventId,
      chatId,
      ...(row.body === undefined ? {} : { body: row.body }),
    });
    yield* sql`UPDATE kin_wakeups SET thread_id = 'thread-fixture'
      WHERE org_id = ${orgId} AND wakeup_id = ${wakeupId}`;
    if (row.card !== undefined) {
      yield* sql`INSERT INTO kin_widgets (org_id, chat_id, widget_id, message_id, widget_class,
        type, revision, state_json, awaiting_json, updated_at)
        VALUES (${orgId}, ${chatId}, 'choice', ${messageId}, 'native', 'choice', 1,
          json_object('question', ${row.card}), '[]', '2026-11-16T09:00:01.000Z')`;
    }
    const factKeys = yield* toldBy(orgId, [eventId]);
    const keyOf = (key: string) => [...factKeys].find((factKey) => factKey.split(":")[1] === key)!;
    if (row.handle === true) {
      yield* sql`UPDATE kin_wakeups SET status = 'running', ended_at = NULL
        WHERE org_id = ${orgId} AND wakeup_id = ${wakeupId}`;
      yield* sql`UPDATE kin_events SET state = 'claimed'
        WHERE org_id = ${orgId} AND event_id = ${eventId}`;
      yield* KinPulse.handle({
        orgId,
        at: MONDAY + 1_000,
        viewer: { _tag: "owner" },
        by: { _tag: "agent", agentId },
        factKey: keyOf("W-62"),
        action: "got_it",
        wakeupId,
      });
    }
    yield* settleCheckInTold({
      orgId,
      wakeupId,
      chatId,
      completed: true,
      readFacts: (factKeys) =>
        KinPulse.read({
          orgId,
          at: MONDAY + 2_000,
          viewer: { _tag: "owner" },
          includeHandled: true,
          factKeys,
        }).pipe(Effect.map((result) => result.facts)),
    });
    yield* sql`UPDATE kin_events SET state = 'done'
      WHERE org_id = ${orgId} AND event_id = ${eventId}`;
    assert.deepStrictEqual(yield* toldBy(orgId, [eventId]), new Set(row.kept.map(keyOf)));
    assert.include(yield* queue(MONDAY + DAY), { _tag: "queued" });
    const next = yield* sql<{ eventId: string }>`SELECT event_id AS "eventId" FROM kin_events
      WHERE org_id = ${orgId} AND tag = 'pulse' AND event_id <> ${eventId} ORDER BY queued_at`;
    const offered = yield* toldBy(
      orgId,
      next.map((one) => one.eventId),
    );
    assert.isTrue(offered.has(keyOf("W-7")));
    assert.strictEqual(
      offered.has(keyOf("W-62")),
      row.handle !== true && !row.kept.includes("W-62"),
    );
  }).pipe(Effect.provide(fixture())),
);
const overdue = (days: number) =>
  fact({ measure: { value: days, unit: "days", threshold: 7, from: { _tag: "default" } } });
const dueIn = (hours: number) =>
  fact({
    sense: "task_due_soon",
    measure: { value: hours, unit: "hours", threshold: 24, from: { _tag: "default" } },
  });

const held = (agentId: string) => ({
  by: { _tag: "agent" as const, agentId: KinAgentId.make(agentId) },
  at: iso(MONDAY),
  until: iso(MONDAY + DAY),
  note: null,
});

describe("what a told fact is compared on", () => {
  it.each([
    { name: "a day older, same chase interval", a: overdue(8), b: overdue(13), same: true },
    { name: "past another chase interval", a: overdue(13), b: overdue(14), same: false },
    { name: "due tomorrow, then due today", a: dueIn(30), b: dueIn(5), same: false },
    { name: "due later today, an hour on", a: dueIn(6), b: dueIn(5), same: true },
    {
      name: "a hold changing hands",
      a: fact({
        measure: { value: 8, unit: "days", threshold: 7, from: { _tag: "default" } },
        handled: held("fin"),
      }),
      b: fact({
        measure: { value: 8, unit: "days", threshold: 7, from: { _tag: "default" } },
        handled: held("chief"),
      }),
      same: true,
    },
    {
      name: "a renewal into the days to draft it",
      a: fact({ sense: "renewal_due", stage: "heads_up" }),
      b: fact({ sense: "renewal_due", stage: "draft" }),
      same: false,
    },
  ])("$name", ({ a, b, same }) => {
    const at = MONDAY - (a.sense === "task_due_soon" && same === false ? DAY : 0);
    assert.strictEqual(factSig(a, at, "UTC") === factSig(b, MONDAY, "UTC"), same);
  });

  it("a hold that ran out reads as open again", () => {
    const held = fact({
      handled: {
        by: { _tag: "agent", agentId: KinAgentId.make("fin") },
        at: iso(MONDAY - DAY),
        until: iso(MONDAY - HOUR),
        note: null,
      },
    });
    assert.strictEqual(factSig(held, MONDAY, "UTC"), factSig(fact({}), MONDAY, "UTC"));
  });
});
