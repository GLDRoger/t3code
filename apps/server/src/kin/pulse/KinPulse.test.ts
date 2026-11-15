import { assert, describe, it } from "@effect/vitest";
import {
  KinAgentId,
  KinEvent,
  KinOrgId,
  KinPersonId,
  KinWakeupId,
  type KinPulseFact,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as Sqlite from "../../persistence/Sqlite.ts";
import { goalsNow } from "../work/goals.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as KinPulse from "./KinPulse.ts";
import { buildWeeklySection, wantsWeekly } from "./weekly.ts";

// Invented org, people, entries and money only; nothing here reads a real database.
const orgId = KinOrgId.make("org");
const owner = KinPersonId.make("owner");
const mate = KinPersonId.make("mate");
const chief = KinAgentId.make("cos");
const finance = KinAgentId.make("fin");
const B = Date.UTC(2026, 10, 1);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const stamp = "2026-10-01T00:00:00.000Z";

const layer = KinEventQueue.layer.pipe(
  Layer.provideMerge(KinPersistence.layer),
  Layer.provideMerge(Sqlite.layerMemory),
);

interface Entry {
  readonly id: string;
  readonly list?: string;
  readonly state?: string;
  readonly side?: string;
  readonly category?: string;
  readonly ownerKind?: string;
  readonly ownerId?: string;
  readonly dueAt?: number;
  readonly dateAt?: number;
  readonly amount?: number;
  readonly repeat?: string;
  readonly confirmed?: number;
  readonly teamShared?: number;
  readonly createdAt?: number;
  readonly partyId?: string;
  readonly title?: string;
  readonly fields?: string;
  readonly closedAt?: number;
}

const PREFIX: Record<string, string> = {
  work: "W",
  docs: "D",
  clients: "C",
  invoices: "INV",
  quotes: "QT",
  dates: "DT",
  expenses: "EXP",
  goals: "G",
};

const insert = Effect.fn("test.insert")(function* (entry: Entry) {
  const sql = yield* SqlClient.SqlClient;
  const created = entry.createdAt ?? B - 30 * DAY;
  yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, state, owner_kind,
      owner_id, side, category, party_id, due_at, date_at, amount_minor, currency, repeat_json, confirmed,
      team_shared, created_by_kind, created_by_id, origin_key, created_at, updated_at, fields_json,
      closed_at)
    VALUES (${orgId}, ${`r-${entry.id}`}, ${entry.list ?? "work"}, ${entry.id},
      ${entry.title ?? `Invented ${entry.id}`}, ${entry.state ?? "open"}, ${entry.ownerKind ?? "agent"},
      ${entry.ownerId ?? chief}, ${entry.side ?? "ours"}, ${entry.category ?? null}, ${entry.partyId ?? null},
      ${entry.dueAt ?? null}, ${entry.dateAt ?? null}, ${entry.amount ?? null},
      ${entry.amount === undefined ? null : "INR"}, ${entry.repeat ?? null},
      ${entry.confirmed ?? 1}, ${entry.teamShared ?? 0}, 'person', ${owner}, ${`origin-${entry.id}`},
      ${created}, ${created}, ${entry.fields ?? "{}"}, ${entry.closedAt ?? null})`;
});

const change = Effect.fn("test.change")(function* (id: string, at: number, fields = "[]") {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_record_changes (org_id, record_id, rev, at, actor_kind, actor_id, via,
      kind, fields_json)
    VALUES (${orgId}, ${`r-${id}`}, 1, ${at}, 'person', ${owner}, 'owner', 'updated', ${fields})`;
});

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Invented Studio', ${stamp})`;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
    VALUES (${owner}, ${orgId}, 'owner', 'Arjun', ${stamp}), (${mate}, ${orgId}, 'mate', 'Meera', ${stamp})`;
  for (const [agent, domain] of [
    [chief, "chief-of-staff"],
    [finance, "finance"],
  ] as const) {
    yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
      VALUES (${agent}, ${orgId}, ${agent}, 'lead', ${owner}, ${stamp})`;
    yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at)
      VALUES (${`chat-${agent}`}, ${orgId}, 'team_group', 0, ${stamp})`;
    yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json,
        worker_projects_json, owner_chat_id, domain)
      VALUES (${agent}, ${orgId}, ${agent}, 0, '{}', '[]', ${`chat-${agent}`}, ${domain})`;
  }
  for (const [id, prefix] of Object.entries(PREFIX))
    yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in, created_at)
      VALUES (${orgId}, ${id}, ${id}, ${prefix}, 1, 0)`;

  yield* insert({ id: "W-1", dueAt: B + 10 * DAY });
  yield* insert({ id: "W-2", dueAt: B + 20 * DAY });
  yield* insert({ id: "W-3", state: "doing" });
  yield* change("W-3", B);
  yield* insert({ id: "W-4", state: "waiting" });
  yield* change("W-4", B, '[{"field":"state","from":"open","to":"waiting"}]');
  yield* insert({ id: "W-5", side: "theirs", dueAt: B + 3 * DAY });
  yield* insert({ id: "W-6", confirmed: 0, createdAt: B });
  yield* insert({ id: "W-7", state: "doing" });
  yield* change("W-7", B + 30 * DAY);
  yield* insert({ id: "W-8", dueAt: B + 2 * DAY, ownerKind: "person", ownerId: mate });
  yield* insert({ id: "W-9", dueAt: B + 2 * DAY, teamShared: 1 });

  yield* insert({
    id: "INV-1",
    list: "invoices",
    state: "waiting",
    amount: 177_000_00,
    dueAt: B + 2 * DAY,
  });
  yield* insert({
    id: "INV-2",
    list: "invoices",
    state: "dropped",
    amount: 50_000_00,
    dueAt: B + 2 * DAY,
  });
  yield* insert({
    id: "INV-3",
    list: "invoices",
    amount: 40_000_00,
    repeat: '{"every":"month"}',
    dateAt: B + 15 * DAY,
  });
  yield* insert({ id: "QT-1", list: "quotes", state: "waiting", amount: 600_000_00, createdAt: B });
  yield* insert({ id: "C-1", list: "clients", title: "Lumen" });
  yield* insert({ id: "D-1", list: "docs", category: "playbook", partyId: "r-C-1" });
  yield* sql`INSERT INTO kin_doc_versions (org_id, record_id, version, body, title, kind, summary,
      operations_json, actor_kind, actor_id, via, origin_key, created_at)
    VALUES (${orgId}, 'r-D-1', 1, ${"# Chasing Lumen\n\n```kin\nchase_invoice_after_days: 7\n```\n"},
      'Chasing Lumen', 'created', 'Seeded', '[]', 'person', ${owner}, 'owner', 'seed-D-1', 0)`;
  yield* insert({
    id: "INV-5",
    list: "invoices",
    state: "waiting",
    amount: 20_000_00,
    dueAt: B + 2 * DAY,
    partyId: "r-C-1",
  });
  yield* insert({ id: "W-10", dueAt: B + 5 * DAY, partyId: "r-C-1" });
  yield* insert({ id: "DT-1", list: "dates", category: "renewal", dueAt: B + 40 * DAY });
  yield* insert({
    id: "EXP-1",
    list: "expenses",
    state: "done",
    category: "software",
    amount: 850_00,
    dateAt: B + DAY,
  });
  yield* insert({
    id: "EXP-2",
    list: "expenses",
    state: "done",
    category: "travel",
    amount: 600_00,
    dateAt: B + DAY,
  });
  yield* sql`INSERT INTO kin_money_budgets (org_id, budget_id, category, currency, limit_minor,
      set_by_kind, set_by_id, set_at)
    VALUES (${orgId}, 'b-software', 'software', 'INR', 1000_00, 'person', ${owner}, 0),
      (${orgId}, 'b-travel', 'travel', 'INR', 500_00, 'person', ${owner}, 0)`;

  // Goals for November: money in counts only payments not taken back.
  yield* insert({ id: "INV-6", list: "invoices", state: "done", amount: 1_00_000_00 });
  yield* sql`INSERT INTO kin_record_payments (org_id, payment_id, record_id, amount_minor, currency,
      paid_on, origin_key, created_at, created_by_kind, voided_at)
    VALUES (${orgId}, 'pay-1', 'r-INV-6', 1_00_000_00, 'INR', '2026-11-02', 'pay-1', 0, 'person', NULL),
      (${orgId}, 'pay-2', 'r-INV-6', 50_000_00, 'INR', '2026-11-02', 'pay-2', 0, 'person', 1)`;
  const goal = (id: string, fields: object) =>
    insert({
      id,
      list: "goals",
      ownerKind: "person",
      ownerId: owner,
      dueAt: B + 30 * DAY - 1,
      fields: JSON.stringify({ startsOn: "2026-11-01", ...fields }),
    });
  yield* goal("G-1", {
    measure: "revenue_received",
    target: { minor: 10_00_000_00, currency: "INR" },
  });
  yield* goal("G-2", { measure: "clients_won", target: "4" });
  yield* goal("G-3", { measure: "tasks_done", target: "20" });
  yield* goal("G-4", { measure: "manual", target: "10", current: "3", unit: "hires" });
  yield* insert({ id: "C-2", list: "clients", createdAt: B + DAY });
  yield* insert({ id: "W-11", state: "done", closedAt: B + 2 * DAY });

  yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, model, started_at,
      status, event_ids)
    VALUES ('w-old', ${orgId}, ${finance}, 'thread-fin', 'test', 0, 'completed', '[]')`;
  yield* sql`INSERT INTO kin_workers (worker_id, org_id, agent_id, wakeup_id, kind, thread_id,
      model_json, provenance_json, status, started_at, ended_at)
    VALUES ('worker-1', ${orgId}, ${finance}, 'w-old', 'build', 'thread-worker-1', '{}', '{}',
      'failed', ${B}, ${B + DAY})`;
  yield* sql`INSERT INTO kin_record_links (org_id, record_id, kind, target, relation, created_at)
    VALUES (${orgId}, 'r-W-7', 'worker', 'worker-1', 'attempt', 0)`;
});

// Open PRs as webhooks left them: #1 opened at B with a review asked at B + 2 days and failing
// checks; #2 approved and green from B + 1 day.
const seedPulls = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_pull_requests (org_id, repo, number, title, author, url, state,
      head_sha, opened_at, review_requested_at, review, checks, checks_sha, ready_at, updated_at)
    VALUES (${orgId}, 'acme/app', 1, 'Invented fix', 'mate', 'https://github.com/acme/app/pull/1',
      'open', 'sha-1', ${B}, ${B + 2 * DAY}, NULL, 'failure', 'sha-1', NULL, ${B}),
      (${orgId}, 'acme/app', 2, 'Invented feature', 'mate', 'https://github.com/acme/app/pull/2',
      'open', 'sha-2', ${B}, NULL, 'approved', 'success', 'sha-2', ${B + DAY}, ${B})`;
});

const read = (at: number, viewer: KinPulse.Viewer = { _tag: "owner" }) =>
  KinPulse.read({ orgId, at, viewer, includeHandled: true, limit: 200 });

const keyed = (facts: ReadonlyArray<KinPulseFact>, sense: string, subject: string) =>
  facts.filter((fact) => fact.sense === sense && fact.subject.key === subject);

// One row per sense: the subject it is about and the instant it becomes true.
const SENSES: ReadonlyArray<readonly [string, string, number]> = [
  ["task_late", "W-1", B + 10 * DAY],
  ["task_due_soon", "W-2", B + 20 * DAY - 24 * HOUR],
  ["task_stalled", "W-3", B + 3 * DAY],
  ["waiting_long", "W-4", B + 5 * DAY],
  ["theirs_late", "W-5", B + 3 * DAY],
  ["to_confirm", "W-6", B + DAY],
  ["invoice_overdue", "INV-1", B + 12 * DAY],
  ["quote_unanswered", "QT-1", B + 5 * DAY],
  ["retainer_due", "INV-3", B + 10 * DAY],
  ["renewal_due", "DT-1", B + 26 * DAY],
  // Lumen's own playbook chases at 7 days, not the company's 10.
  ["invoice_overdue", "INV-5", B + 9 * DAY],
  // Budgets read this month's spending, so they turn on when the month does.
  ["budget_near", "b-software", B],
  ["budget_over", "b-travel", B],
  ["worker_failed", "worker-1", B + DAY],
  // Lumen's last contact is INV-5, issued at B - 30 days; cold at the default 30 days.
  ["client_cold", "C-1", B],
  ["client_waiting_on_us", "C-1", B + 5 * DAY + 24 * HOUR],
  // ₹1L of ₹10L: behind once a straight line would be past ₹1.25L (20 % under it).
  ["goal_behind", "G-1", B + 3.75 * DAY],
  // PRs: open past the playbook's 72 hours, a review asked 24 hours ago, failing, ready.
  ["pr_open_long", "acme/app#1", B + 72 * HOUR],
  ["pr_review_waiting", "acme/app#1", B + 3 * DAY],
  ["pr_failing", "acme/app#1", B],
  ["pr_ready", "acme/app#2", B + DAY],
];

const decodeEvent = Schema.decodeUnknownSync(KinEvent);

describe("KinPulse", () => {
  it.effect("each sense is absent a minute before its line and present at it", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* seedPulls;
      for (const [sense, subject, at] of SENSES) {
        assert.lengthOf(
          keyed((yield* read(at - MINUTE)).facts, sense, subject),
          0,
          `${sense} early`,
        );
        assert.lengthOf(keyed((yield* read(at)).facts, sense, subject), 1, `${sense} at its line`);
      }
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json,
          received_at, queued_at, budget_deferred)
        VALUES ('held', ${orgId}, ${chief}, 'github', 'P2', '{}', 0, 0, 1)`;
      assert.lengthOf(keyed((yield* read(B)).facts, "work_held", chief), 1);

      // A void invoice never counts; a moved due date is a new episode, so a new key.
      assert.lengthOf(keyed((yield* read(B + 60 * DAY)).facts, "invoice_overdue", "INV-2"), 0);
      const [before] = keyed((yield* read(B + 11 * DAY)).facts, "task_late", "W-1");
      yield* sql`UPDATE kin_records SET due_at = ${B + 10 * DAY + HOUR} WHERE record_id = 'r-W-1'`;
      const [after] = keyed((yield* read(B + 11 * DAY)).facts, "task_late", "W-1");
      assert.notStrictEqual(before!.key, after!.key);

      const overdue = keyed((yield* read(B + 12 * DAY)).facts, "invoice_overdue", "INV-1")[0]!;
      assert.strictEqual(overdue.consequence, "₹1,77,000.00 owed, 10 days past due (2026-11-03).");
      assert.deepStrictEqual(overdue.actor, { _tag: "agent", agentId: finance });
      assert.deepStrictEqual(overdue.measure?.from, { _tag: "default" });
      const lumen = keyed((yield* read(B + 9 * DAY)).facts, "invoice_overdue", "INV-5")[0]!;
      assert.deepStrictEqual(lumen.measure?.from, {
        _tag: "playbook",
        key: "D-1",
        title: "Invented D-1",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("ticking twice wakes each agent once, and one agent's facts claim as one batch", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const queue = yield* KinEventQueue.KinEventQueue;
      const at = B + DAY + 12 * HOUR;
      // Due at the same tick: the invoice and the worker are both the Finance agent's.
      yield* sql`UPDATE kin_records SET due_at = ${at - 10 * DAY} WHERE record_id = 'r-INV-1'`;
      const first = yield* KinPulse.tick(orgId, at);
      const second = yield* KinPulse.tick(orgId, at + MINUTE);
      assert.lengthOf(second.woken, 0);
      assert.includeMembers(
        first.woken.map((key) => key.split(":")[0]),
        ["invoice_overdue", "worker_failed", "budget_over"],
      );
      const events = yield* sql<{ agent: string; tag: string }>`SELECT agent_id AS agent, tag
        FROM kin_events WHERE org_id = ${orgId} AND tag = 'pulse' ORDER BY event_id`;
      assert.lengthOf(events, first.woken.length);
      assert.isTrue(events.every((event) => event.agent === finance));
      const claim = yield* Effect.scoped(
        queue.claim({
          orgId,
          agentId: finance,
          wakeupId: KinWakeupId.make("w-pulse"),
          model: "test",
        }),
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("30 seconds");
      assert.lengthOf(yield* Fiber.join(claim), first.woken.length);

      // A fact that stops being true is cleared.
      yield* sql`UPDATE kin_records SET state = 'done' WHERE record_id = 'r-INV-1'`;
      const later = yield* KinPulse.tick(orgId, at + 2 * MINUTE);
      assert.isAtLeast(later.cleared, 1);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a handled fact hides until its date, or for three days, and undo brings it back", () =>
    Effect.gen(function* () {
      yield* seed;
      const at = B + 12 * DAY;
      const fact = keyed((yield* read(at)).facts, "invoice_overdue", "INV-1")[0]!;
      const by = { _tag: "agent" as const, agentId: finance };
      const open = (when: number) =>
        KinPulse.read({ orgId, at: when, viewer: { _tag: "owner" } }).pipe(
          Effect.map((result) => keyed(result.facts, "invoice_overdue", "INV-1").length),
        );
      const handle = (action: "got_it" | "not_a_problem" | "undo", until?: number) =>
        KinPulse.handle({
          orgId,
          at,
          viewer: { _tag: "owner" },
          by,
          factKey: fact.key,
          action,
          until,
        });
      const handled = yield* handle("got_it", at + DAY);
      assert.strictEqual(DateTime.toEpochMillis(handled.handled!.until!), at + DAY);
      assert.strictEqual(yield* open(at + DAY - MINUTE), 0);
      assert.strictEqual(yield* open(at + DAY), 1);
      yield* handle("got_it");
      assert.strictEqual(yield* open(at + KinPulse.GOT_IT_MS - MINUTE), 0);
      assert.strictEqual(yield* open(at + KinPulse.GOT_IT_MS), 1);
      yield* handle("not_a_problem");
      assert.strictEqual(yield* open(at + 30 * DAY), 0);
      yield* handle("undo");
      assert.strictEqual(yield* open(at), 1);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("people see only facts on tasks all of them may see, and only their own holds", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const at = B + 12 * DAY;
      // G02: with Clients on, a client's facts are still owner-level.
      yield* sql`UPDATE kin_people SET sees_clients = 1 WHERE person_id = ${mate}`;
      assert.isNotEmpty(keyed((yield* read(at)).facts, "client_waiting_on_us", "C-1"));
      const shown = (yield* read(at, { _tag: "people", people: [mate] })).facts;
      assert.sameMembers([...new Set(shown.map((fact) => fact.subject.key))], ["W-8", "W-9"]);
      assert.isTrue(shown.every((fact) => fact.family === "work" && !fact.sensitive));
      const both = (yield* read(at, { _tag: "people", people: [mate, KinPersonId.make("other")] }))
        .facts;
      assert.deepStrictEqual([...new Set(both.map((fact) => fact.subject.key))], ["W-9"]);
      // G10: the check-in snoozing Meera's late task hides it from the owner's view, not hers.
      const late = keyed(shown, "task_late", "W-8")[0]!;
      yield* KinPulse.handle({
        orgId,
        at,
        viewer: { _tag: "owner" },
        by: { _tag: "agent", agentId: chief },
        factKey: late.key,
        action: "got_it",
      });
      const handledFor = (viewer: KinPulse.Viewer) =>
        read(at, viewer).pipe(
          Effect.map((result) => keyed(result.facts, "task_late", "W-8")[0]?.handled ?? null),
        );
      assert.isNotNull(yield* handledFor({ _tag: "owner" }));
      assert.isNull(yield* handledFor({ _tag: "people", people: [mate] }));
      // Her own "I've got it" is hers alone.
      yield* KinPulse.handle({
        orgId,
        at,
        viewer: { _tag: "people", people: [mate] },
        by: { _tag: "person", personId: mate },
        factKey: late.key,
        action: "got_it",
      });
      assert.isNotNull(yield* handledFor({ _tag: "people", people: [mate] }));
      assert.isNull(yield* handledFor({ _tag: "owner" }));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("goals count their progress from Kin's rows, and money goals only for money", () =>
    Effect.gen(function* () {
      yield* seed;
      const at = B + 15 * DAY;
      const { goals } = yield* goalsNow(orgId, at, { money: true });
      const by = new Map(goals.map((one) => [one.key, one]));
      assert.strictEqual(by.get("G-1")!.current, 1_00_000_00);
      assert.isTrue(by.get("G-1")!.behind);
      assert.strictEqual(by.get("G-2")!.current, 1);
      assert.strictEqual(by.get("G-3")!.current, 1);
      assert.deepInclude(by.get("G-4")!, { current: 3, unit: "hires", target: 10 });
      const shown = (yield* goalsNow(orgId, at, { money: false })).goals;
      assert.notInclude(
        shown.map((one) => one.key),
        "G-1",
      );
      const people = (yield* read(at, { _tag: "people", people: [mate] })).facts;
      assert.isFalse(people.some((fact) => fact.sense === "goal_behind"));

      // The weekly brief leads with goals, then overdue money from the same rows.
      const week = yield* buildWeeklySection({ orgId, now: at });
      assert.match(week.goals[0]!, /^G-1 .*₹1,00,000\.00 of ₹10,00,000\.00.*behind$/);
      assert.isTrue(week.money.overdue.some((line) => line.startsWith("INV-1")));
      // The seeded weekly check-in arrives as a pulse and gets the same section.
      const checkIn = (scheduleId: string) =>
        decodeEvent({
          _tag: "pulse",
          orgId,
          eventId: `pulse-${scheduleId}`,
          agentId: "agent-1",
          receivedAt: "2026-11-16T03:30:00.000Z",
          dedupeKey: null,
          provenance: { _tag: "system" },
          factKeys: [],
          checkIn: {
            scheduleId,
            title: "Check-in",
            what: "Look over the week.",
            slot: "2026-11-16",
          },
        });
      assert.isTrue(wantsWeekly([checkIn("checkin-weekly")]));
      assert.isFalse(wantsWeekly([checkIn("checkin-morning")]));
    }).pipe(Effect.provide(layer)),
  );
});
