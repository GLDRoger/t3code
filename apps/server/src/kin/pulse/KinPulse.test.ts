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
import { buildPulseSection } from "./prompt.ts";
import { buildWeeklySection, renderWeekly, wantsWeekly } from "./weekly.ts";

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
  readonly projectId?: string;
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
  projects: "P",
  milestones: "M",
};

const insert = Effect.fn("test.insert")(function* (entry: Entry) {
  const sql = yield* SqlClient.SqlClient;
  const created = entry.createdAt ?? B - 30 * DAY;
  yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, state, owner_kind,
      owner_id, side, category, party_id, due_at, date_at, amount_minor, currency, repeat_json, confirmed,
      team_shared, created_by_kind, created_by_id, origin_key, created_at, updated_at, fields_json,
      closed_at, project_id)
    VALUES (${orgId}, ${`r-${entry.id}`}, ${entry.list ?? "work"}, ${entry.id},
      ${entry.title ?? `Invented ${entry.id}`}, ${entry.state ?? "open"}, ${entry.ownerKind ?? "agent"},
      ${entry.ownerId ?? chief}, ${entry.side ?? "ours"}, ${entry.category ?? null}, ${entry.partyId ?? null},
      ${entry.dueAt ?? null}, ${entry.dateAt ?? null}, ${entry.amount ?? null},
      ${entry.amount === undefined ? null : "INR"}, ${entry.repeat ?? null},
      ${entry.confirmed ?? 1}, ${entry.teamShared ?? 0}, 'person', ${owner}, ${`origin-${entry.id}`},
      ${created}, ${created}, ${entry.fields ?? "{}"}, ${entry.closedAt ?? null},
      ${entry.projectId === undefined ? null : `r-${entry.projectId}`})`;
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
  // Unset, the host's zone would stand in; these lines are drawn in UTC.
  yield* sql`INSERT INTO kin_trigger_settings (org_id, time_zone, morning_brief, evening_summary,
      dream, full_rebuild_weekday, owner_check_weekday, owner_check, quiet_hours_json)
    VALUES (${orgId}, 'UTC', '08:30', '18:00', '02:00', 0, 1, '09:00', '{}')`;
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

  // The project spine: a retainer renewing on 20 Dec, a project with no plan, a milestone whose
  // task lands after it, a task whose spec section is gone, and a meeting with Meera.
  yield* insert({
    id: "P-1",
    list: "projects",
    fields: JSON.stringify({
      billing: "retainer",
      renewsOn: "2026-12-20",
      value: { minor: 40_000_00, currency: "INR" },
    }),
  });
  yield* insert({ id: "P-2", list: "projects", fields: '{"billing":"fixed"}' });
  yield* insert({
    id: "P-4",
    list: "projects",
    state: "done",
    partyId: "r-C-2",
    closedAt: B + 10 * DAY,
  });
  yield* insert({ id: "P-3", list: "projects", createdAt: B });
  yield* insert({ id: "M-1", list: "milestones", projectId: "P-3", dueAt: B + 10 * DAY });
  yield* insert({
    id: "W-12",
    projectId: "P-3",
    dueAt: B + 12 * DAY,
    fields: '{"milestone":"M-1"}',
  });
  yield* change("W-12", B);
  yield* insert({ id: "D-2", list: "docs", category: "spec", createdAt: B + 2 * DAY });
  yield* sql`INSERT INTO kin_doc_versions (org_id, record_id, version, body, title, kind, summary,
      operations_json, actor_kind, actor_id, via, origin_key, created_at)
    VALUES (${orgId}, 'r-D-2', 1, ${"# Spec\n\n## Login\nPhone and OTP.\n"}, 'Spec', 'created',
      'Seeded', '[]', 'person', ${owner}, 'owner', 'seed-D-2', 0)`;
  yield* insert({
    id: "W-13",
    createdAt: B + 2 * DAY,
    fields: '{"fromDoc":"D-2","fromSection":"payments","fromHash":"old"}',
  });
  yield* insert({
    id: "W-14",
    category: "meeting",
    ownerKind: "person",
    ownerId: mate,
    dateAt: B + 5 * DAY,
    fields: JSON.stringify({ attendees: [`person:${mate}`] }),
  });
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
  // A retainer's renews-on day, 14 days ahead by default (end of 20 Dec).
  ["renewal_due", "P-1", B + 36 * DAY - 1],
  ["project_no_plan", "P-2", B - 29 * DAY],
  // Its task is due after it: at risk 3 days out, late once its day has passed.
  ["milestone_at_risk", "M-1", B + 7 * DAY],
  ["milestone_late", "M-1", B + 10 * DAY + 1],
  ["project_quiet", "P-3", B + 7 * DAY],
  ["spec_changed", "W-13", B + 2 * DAY],
  ["meeting_soon", "W-14", B + 4 * DAY],
  ["meeting_passed", "W-14", B + 5 * DAY + 2 * HOUR],
  // C-2's silence counts from P-4, the project we finished for them, not from its creation.
  ["client_cold", "C-2", B + 40 * DAY],
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

      // The same renewal kept in Dates for the project too is one fact, not two.
      yield* insert({
        id: "DT-2",
        list: "dates",
        category: "renewal",
        projectId: "P-1",
        dueAt: Date.UTC(2026, 11, 20, 23, 59, 59, 999),
      });
      const renewals = (yield* read(B + 40 * DAY)).facts.filter(
        (fact) => fact.sense === "renewal_due" && fact.scope.projectKey === "P-1",
      );
      assert.deepStrictEqual(
        renewals.map((fact) => fact.subject.key),
        ["DT-2"],
      );

      // A void invoice never counts; a moved due date is a new episode, so a new key.
      assert.lengthOf(keyed((yield* read(B + 60 * DAY)).facts, "invoice_overdue", "INV-2"), 0);
      const [before] = keyed((yield* read(B + 11 * DAY)).facts, "task_late", "W-1");
      yield* sql`UPDATE kin_records SET due_at = ${B + 10 * DAY + HOUR} WHERE record_id = 'r-W-1'`;
      const [after] = keyed((yield* read(B + 11 * DAY)).facts, "task_late", "W-1");
      assert.notStrictEqual(before!.key, after!.key);
      // Calendar days where the owner is: due late on the 11th, read early on the 12th.
      assert.strictEqual(before!.consequence, "Was due 2026-11-11, yesterday.");
      assert.strictEqual(after!.consequence, "Was due 2026-11-11, yesterday.");

      const overdue = keyed((yield* read(B + 12 * DAY)).facts, "invoice_overdue", "INV-1")[0]!;
      assert.strictEqual(overdue.consequence, "₹1,77,000 owed, 10 days past due (2026-11-03).");
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
      // A check-in still tells the owner, with who has it; other turns leave it out.
      const shown = (when: number, checkIn: boolean) =>
        buildPulseSection({ orgId, agentId: chief, now: when, wokeFor: [], checkIn }).pipe(
          Effect.map((section) =>
            section?.byProject.flatMap((group) => group.facts).find((one) => one.key === fact.key),
          ),
        );
      assert.isUndefined(yield* shown(at, false));
      const held = yield* shown(at, true);
      assert.include(held, { sentIn: "no mail with it on record", rule: "10 days (now 10)" });
      assert.match(String(held?.inHand), /^fin until /);
      assert.notProperty(held, "toldBefore");
      // Once a check-in has had it, the next one may say it in a "still" line.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json,
          dedupe_key, received_at, queued_at, state)
        VALUES ('e-checkin', ${orgId}, ${chief}, 'pulse', 'P2', '{}',
          'checkin:checkin-morning:2026-11-13', ${at + MINUTE}, ${at + MINUTE}, 'done')`;
      assert.include(yield* shown(at + 2 * MINUTE, true), { toldBefore: true });
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
      // W-14 is Meera's own meeting: its follow-up is hers to see.
      assert.sameMembers(
        [...new Set(shown.map((fact) => fact.subject.key))],
        ["W-8", "W-9", "W-14"],
      );
      assert.isTrue(shown.every((fact) => fact.family === "work" && !fact.sensitive));
      const both = (yield* read(at, { _tag: "people", people: [mate, KinPersonId.make("other")] }))
        .facts;
      assert.deepStrictEqual([...new Set(both.map((fact) => fact.subject.key))], ["W-9"]);
      // H14: a meeting everyone sees asks only those who were in it how it went, in their words.
      const hers = keyed(shown, "meeting_passed", "W-14")[0]!.consequence;
      assert.include(hers, "no outcome is noted. How did it go?");
      // J09: Meera reads her own meeting as hers; the owner reads it by her name.
      assert.match(hers, /^Your meeting (with .+ )?was /);
      assert.match(
        keyed((yield* read(at)).facts, "meeting_passed", "W-14")[0]!.consequence,
        /^Meeting with Meera was /,
      );
      yield* sql`UPDATE kin_records SET team_shared = 1 WHERE record_id = 'r-W-14'`;
      const outside = (yield* read(at, { _tag: "people", people: [KinPersonId.make("other")] }))
        .facts;
      assert.notInclude(
        outside.map((fact) => fact.subject.key),
        "W-14",
      );
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
      assert.match(week.goals[0]!, /^G-1 .*₹1,00,000 of ₹10,00,000.*behind$/);
      assert.isTrue(
        week.money.unpaid.some((line) =>
          /^INV-1:.*days past due; no mail with it on record$/.test(line),
        ),
      );
      // Run 4: the brief called a reminder sent 45 s earlier a draft. Its lines read the record.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO kin_connections (org_id, connection_id, label, kind, url_host, auth,
          reach, state, created_at, updated_at)
        VALUES (${orgId}, 'mail', 'Outlook', 'remote', 'graph.example', 'none', 'open', 'active', 1, 1)`;
      const ask = (id: string, state: string, doneAt: number | null, attachments: unknown[]) =>
        sql`INSERT INTO kin_connection_asks (org_id, ask_id, connection_id, tool_name, pin_digest,
            payload_json, agent_id, wakeup_id, chat_id, state, result_json, proposed_at, done_at)
          VALUES (${orgId}, ${id}, 'mail', ${attachments.length > 0 ? "mail_send" : "mail_reply"},
            'pin', ${JSON.stringify({
              _tag: "email",
              from: { address: "hello@studio.example", name: null },
              to: ["accounts@client.example"],
              cc: [],
              subject: "Invoice INV-1",
              body: "Attached.",
              threadId: attachments.length > 0 ? null : "t-1",
              inReplyTo: null,
              references: null,
              attachments,
            })}, ${finance}, 'w', 'c', ${state},
            ${state === "sent" ? JSON.stringify({ threadId: "t-1" }) : null}, 0, ${doneAt})`;
      yield* ask("invoice", "sent", B, [
        {
          key: "D-1",
          recordId: "r-D-1",
          version: 1,
          attachmentId: "a",
          sha256: "s",
          name: "INV-1.pdf",
          mimeType: "application/pdf",
          bytes: 1,
          label: null,
          entryRecordId: "r-INV-1",
        },
      ]);
      const overdueLine = Effect.map(buildWeeklySection({ orgId, now: at }), (now) =>
        now.money.unpaid.find((line) => line.startsWith("INV-1:")),
      );
      assert.match(
        String(yield* overdueLine),
        /past due; sent \S+ from hello@studio.example, no reminder since$/,
      );
      yield* ask("draft", "open", null, []);
      assert.match(
        String(yield* overdueLine),
        /no reminder since, a reply waits on the owner's Confirm$/,
      );
      yield* sql`UPDATE kin_connection_asks SET state = 'sent', done_at = ${at - DAY},
          result_json = '{"threadId":"t-1"}' WHERE ask_id = 'draft'`;
      assert.match(String(yield* overdueLine), /, reminder sent \S+$/);
      // The weekly brief carries the renewal and the open quote it was missing.
      assert.include(week.money.renewalsThisMonth.join("\n"), "DT-1");
      assert.deepStrictEqual(week.money.openQuotes, ["QT-1: ₹6,00,000.00, sent, no answer yet"]);
      // Kin posts these figures itself; none of the sections the run-3 brief dropped is missing.
      const posted = renderWeekly(week);
      assert.match(posted, /\nOverdue:\n- INV-1:.*days past due/);
      assert.match(posted, /\nRenewals this month:\n- .*DT-1/);
      assert.match(posted, /\nOpen quotes:\n- QT-1/);
      assert.match(posted, /\nGoals:\n- G-1 /);
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
