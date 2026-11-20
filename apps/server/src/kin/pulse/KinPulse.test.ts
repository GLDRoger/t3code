import { assert, describe, it } from "@effect/vitest";
import {
  KinAgentId,
  KinConnectionId,
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
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as Sqlite from "../../persistence/Sqlite.ts";
import { KinChatHub } from "../chat/KinChatHub.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import * as Chat from "../chat/layer.ts";
import { deliverHeld } from "../triggers/heldDelivery.ts";
import { reholdAfter } from "../triggers/quietHold.ts";
import { holderBody } from "./holderNotice.ts";
import { goalsNow } from "../work/goals.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import { KinRefreshObserver } from "../chat/KinRefreshHub.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as KinPulse from "./KinPulse.ts";
import { buildPulseSection } from "./prompt.ts";
import { screenFacts } from "./people.ts";
import { factSig } from "./told.ts";
import { projectLastMoved } from "./senses/projects.ts";
import { buildWeeklySection, wantsWeekly, WEEK_FIGURES_TITLE, weeklyFigures } from "./weekly.ts";

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
  yield* insert({ id: "W-10", dueAt: B + 5 * DAY, partyId: "r-C-1", category: "obligation" });
  // An agent's suggestions nobody confirmed: no chase, no contact, no goal, no brief figure,
  // even with a payment an older build let it take.
  yield* insert({
    id: "INV-7",
    list: "invoices",
    state: "waiting",
    amount: 177_000_00,
    dueAt: B + 2 * DAY,
    dateAt: B - 5 * DAY,
    partyId: "r-C-1",
    confirmed: 0,
    createdAt: B - 5 * DAY,
  });
  yield* insert({
    id: "QT-2",
    list: "quotes",
    state: "waiting",
    amount: 300_000_00,
    confirmed: 0,
    createdAt: B,
  });
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
      (${orgId}, 'pay-2', 'r-INV-6', 50_000_00, 'INR', '2026-11-02', 'pay-2', 0, 'person', 1),
      (${orgId}, 'pay-3', 'r-INV-7', 10_000_00, 'INR', '2026-11-02', 'pay-3', 0, 'person', NULL)`;
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
  // A task Finance delegated waits on a decision from B + 1 day; a closed one says nothing.
  const task = (id: string, status: string, closed: string | null) =>
    sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind, author_agent_id,
        author_owner_person_id, author_thread_id, author_member_id, author_role, kind, body,
        mentions_json, status, created_at)
      VALUES (${`m-${id}`}, ${orgId}, ${`chat-${finance}`}, ${id === "task-1" ? 1 : 2}, 'agent',
        ${finance}, ${owner}, 'thread-fin', 'member-fin', 'member', 'text', '', '[]', 'posted',
        ${stamp})`.pipe(
      Effect.andThen(
        sql`INSERT INTO kin_widgets (widget_id, org_id, chat_id, message_id, widget_class, type,
            revision, state_json, awaiting_json, closed_at, updated_at)
          VALUES (${id}, ${orgId}, ${`chat-${finance}`}, ${`m-${id}`}, 'native', 'task', 1,
            ${JSON.stringify({ threadId: `thread-${id}`, title: "Invented export", status })},
            '[]', ${closed}, ${DateTime.formatIso(DateTime.makeUnsafe(B + DAY))})`,
      ),
    );
  // The cards alone: their chat member and thread rows add nothing here.
  yield* sql`PRAGMA foreign_keys = OFF`;
  yield* task("task-1", "needs_decision", null);
  yield* task("task-2", "blocked", DateTime.formatIso(DateTime.makeUnsafe(B + DAY)));
  yield* sql`PRAGMA foreign_keys = ON`;
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
  ["task_stuck", "thread-task-1", B + DAY],
  // Lumen's last contact is INV-5, issued at B - 30 days; cold at the default 30 days.
  ["client_cold", "C-1", B],
  ["client_waiting_on_us", "C-1", B + 5 * DAY + 24 * HOUR],
  // ₹1L of ₹10L: behind once a straight line would be past ₹1.25L (20 % under it).
  ["goal_behind", "G-1", B + 3.75 * DAY],
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

/** Chat services too, for the notices Kin posts itself. */
const chatLayer = Chat.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));

/** Meera may message the Chief of staff. */
const letMate = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_lead_access (org_id, agent_id, person_id, granted_by, granted_at)
    VALUES (${orgId}, ${chief}, ${mate}, ${owner}, 0)`;
});

/** What Kin posted in someone's direct chat with the Chief of staff, oldest first. */
const noticesTo = Effect.fn("test.noticesTo")(function* (personId: KinPersonId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ body: string }>`SELECT m.body FROM kin_messages m
    JOIN kin_chats c ON c.org_id = m.org_id AND c.chat_id = m.chat_id
    WHERE m.org_id = ${orgId} AND c.direct_key = ${`${personId}:${chief}`}
      AND m.author_kind = 'system' AND m.status = 'posted'
    ORDER BY m.seq`;
  return rows.map((row) => row.body);
});
const mateNotices = noticesTo(mate);

/** The wakes holders got, in order, with the facts each carried. */
const holderWakes = Effect.fn("test.holderWakes")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ agent: string; json: string }>`SELECT agent_id AS agent, json
    FROM kin_events WHERE org_id = ${orgId} AND dedupe_key LIKE 'holders:%'
    ORDER BY received_at, event_id`;
  return rows.map((row) => {
    const event = decodeEvent(JSON.parse(row.json));
    return { agent: row.agent, keys: event._tag === "pulse" ? event.factKeys : [] };
  });
});

describe("KinPulse", () => {
  it.effect("each sense is absent a minute before its line and present at it", () =>
    Effect.gen(function* () {
      yield* seed;
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

      // A suggested one on the same day is still a day to know, with no fee of its own, and
      // stands for no renewal that was kept.
      yield* insert({
        id: "DT-3",
        list: "dates",
        category: "renewal",
        projectId: "P-1",
        amount: 9_999_00,
        confirmed: 0,
        dueAt: Date.UTC(2026, 11, 20, 23, 59, 59, 999),
      });
      const guessed = (yield* read(B + 40 * DAY)).facts.filter(
        (fact) => fact.sense === "renewal_due" && fact.scope.projectKey === "P-1",
      );
      assert.deepStrictEqual(guessed.map((fact) => fact.subject.key).toSorted(), ["DT-3", "P-1"]);
      assert.notInclude(guessed.find((fact) => fact.subject.key === "DT-3")!.consequence, "9,999");
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
      assert.deepStrictEqual(renewals.map((fact) => fact.subject.key).toSorted(), ["DT-2", "DT-3"]);
      // A suggested repeating invoice's next draft names no amount and waits on Keep.
      yield* insert({
        id: "INV-17",
        list: "invoices",
        amount: 12_345_00,
        confirmed: 0,
        repeat: '{"every":"month"}',
        dateAt: B + 15 * DAY,
      });
      const [retainer] = keyed((yield* read(B + 10 * DAY)).facts, "retainer_due", "INV-17");
      assert.match(retainer!.consequence, /; it is still a draft that waits on Keep\.$/);
      assert.notInclude(retainer!.consequence, "12,345");

      // V27: our own task under a client is a late task, not something we owe the client.
      yield* insert({ id: "W-15", dueAt: B, partyId: "r-C-2", category: "task" });
      assert.lengthOf(keyed((yield* read(B + 60 * DAY)).facts, "client_waiting_on_us", "C-2"), 0);
      assert.lengthOf(keyed((yield* read(B + 60 * DAY)).facts, "task_late", "W-15"), 1);
      // A late obligation is, in days rather than hours; contact names what it counts.
      const [owed] = keyed((yield* read(B + 12 * DAY)).facts, "client_waiting_on_us", "C-1");
      assert.strictEqual(owed!.consequence, "Something we owe them has been past due for 7 days.");
      const [cold] = keyed((yield* read(B)).facts, "client_cold", "C-1");
      assert.strictEqual(
        cold!.consequence,
        "No contact for 30 days (calls, meetings, mail, invoices and payments count; the last was an invoice), and nothing open with them.",
      );

      // A void invoice never counts, nor a suggestion; a moved due date is a new episode, so a new key.
      const later = (yield* read(B + 60 * DAY)).facts;
      assert.lengthOf(keyed(later, "invoice_overdue", "INV-2"), 0);
      assert.lengthOf(keyed(later, "invoice_overdue", "INV-7"), 0);
      assert.lengthOf(keyed(later, "quote_unanswered", "QT-2"), 0);
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
      // Due at the same tick: the invoice and the task are both the Finance agent's.
      yield* sql`UPDATE kin_records SET due_at = ${at - 10 * DAY} WHERE record_id = 'r-INV-1'`;
      const first = yield* KinPulse.tick(orgId, at);
      const second = yield* KinPulse.tick(orgId, at + MINUTE);
      assert.lengthOf(second.woken, 0);
      assert.includeMembers(
        first.woken.map((key) => key.split(":")[0]),
        ["invoice_overdue", "task_stuck", "budget_over"],
      );
      const events = yield* sql<{ agent: string; tag: string }>`SELECT agent_id AS agent, tag
        FROM kin_events WHERE org_id = ${orgId} AND tag = 'pulse'
          AND dedupe_key NOT LIKE 'holders:%' ORDER BY event_id`;
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

  it.effect(
    "a record past due wakes its agent holder once, and again only when the due day changes",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const at = B + 11 * DAY;
        const lateW1 = (keys: ReadonlyArray<string>) =>
          keys.filter((key) => key.startsWith("task_late:W-1:"));
        const first = yield* KinPulse.tick(orgId, at);
        assert.deepStrictEqual(lateW1((yield* holderWakes()).flatMap((wake) => wake.keys)), [
          `task_late:W-1:due=${B + 10 * DAY}`,
        ]);
        assert.isTrue(first.told.some((one) => one.to === `agent:${chief}`));
        // Late all week: not again.
        for (const later of [at + HOUR, at + DAY, at + 6 * DAY])
          assert.lengthOf(
            lateW1((yield* KinPulse.tick(orgId, later)).told.map((one) => one.key)),
            0,
          );
        // Its due day moves: told again, once.
        yield* sql`UPDATE kin_records SET due_at = ${B + 11 * DAY} WHERE record_id = 'r-W-1'`;
        const moved = yield* KinPulse.tick(orgId, at + 7 * DAY);
        assert.deepStrictEqual(lateW1(moved.told.map((one) => one.key)), [
          `task_late:W-1:due=${B + 11 * DAY}`,
        ]);
        assert.lengthOf(
          lateW1((yield* KinPulse.tick(orgId, at + 8 * DAY)).told.map((one) => one.key)),
          0,
        );
        // Closed, then open again: told again.
        yield* sql`UPDATE kin_records SET state = 'done' WHERE record_id = 'r-W-1'`;
        yield* KinPulse.tick(orgId, at + 8 * DAY + HOUR);
        yield* sql`UPDATE kin_records SET state = 'open' WHERE record_id = 'r-W-1'`;
        const reopened = yield* KinPulse.tick(orgId, at + 8 * DAY + 2 * HOUR);
        assert.lengthOf(lateW1(reopened.told.map((one) => one.key)), 1);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("two late tasks for one agent make one wake", () =>
    Effect.gen(function* () {
      yield* seed;
      const at = B + 11 * DAY;
      yield* KinPulse.tick(orgId, at);
      const wakes = yield* holderWakes();
      assert.deepStrictEqual(
        wakes.map((wake) => wake.agent),
        [chief],
      );
      assert.includeMembers(
        [...wakes[0]!.keys],
        [
          `task_late:W-1:due=${B + 10 * DAY}`,
          `task_late:W-9:due=${B + 2 * DAY}`,
          `theirs_late:W-5:due=${B + 3 * DAY}`,
        ],
      );
      // The next pass tells only what became due since (W-12, due today now), never those again.
      const next = yield* KinPulse.tick(orgId, at + 15 * MINUTE);
      assert.deepStrictEqual(
        next.told.map((one) => one.key),
        [`task_due_soon:W-12:due=${B + 12 * DAY}`],
      );
      assert.lengthOf(yield* holderWakes(), 2);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a late task held by a teammate is Kin's one notice in their chat, and no wake", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* letMate;
      const sql = yield* SqlClient.SqlClient;
      const hub = yield* KinChatHub;
      const posted = yield* hub.subscribeAll;
      const at = B + 3 * DAY + 12 * HOUR;
      yield* TestClock.setTime(at);
      const key = `task_late:W-8:due=${B + 2 * DAY}`;
      // The owner's own late task still goes to the Chief of staff, not to a notice.
      yield* insert({ id: "W-20", dueAt: B + 2 * DAY, ownerKind: "person", ownerId: owner });
      const first = yield* KinPulse.tick(orgId, at);
      assert.deepStrictEqual(
        first.told.filter((one) => one.key === key),
        [{ agentId: chief, to: mate, key }],
      );
      const wakes = (yield* holderWakes()).flatMap((wake) => wake.keys);
      assert.notInclude(wakes, key);
      assert.include(wakes, `task_late:W-20:due=${B + 2 * DAY}`);
      assert.deepStrictEqual(yield* mateNotices, ["W-8 Invented W-8 was due yesterday."]);
      // Posted to the hub, which is what pushes it.
      const [event] = yield* Stream.runCollect(
        posted.pipe(
          Stream.filter((one) => one.type === "message.posted"),
          Stream.take(1),
        ),
      );
      assert.strictEqual(
        event?.type === "message.posted" ? event.message.body : "",
        "W-8 Invented W-8 was due yesterday.",
      );
      const ownerChats = yield* sql`SELECT 1 FROM kin_chats
        WHERE org_id = ${orgId} AND direct_key LIKE ${`${owner}:%`}`;
      assert.lengthOf(ownerChats, 0);
      // Later passes, in the same minute or the next day, add nothing.
      for (const later of [at + 1, at + MINUTE, at + DAY]) {
        yield* TestClock.setTime(later);
        const again = yield* KinPulse.tick(orgId, later);
        assert.lengthOf(
          again.told.filter((one) => one.key === key),
          0,
        );
      }
      assert.lengthOf(yield* mateNotices, 1);
      const told = yield* sql<{ person: string }>`SELECT person_id AS person FROM kin_pulse_told
        WHERE org_id = ${orgId} AND fact_key = ${key} ORDER BY told_at`;
      assert.deepStrictEqual(
        told.map((row) => row.person),
        [mate],
      );
      // Done, cleared, then reopened with the same due date: still late, so told again, once.
      yield* sql`UPDATE kin_records SET state = 'done' WHERE record_id = 'r-W-8'`;
      yield* KinPulse.tick(orgId, at + 2 * DAY);
      yield* sql`UPDATE kin_records SET state = 'open' WHERE record_id = 'r-W-8'`;
      for (const later of [at + 2 * DAY + HOUR, at + 2 * DAY + HOUR, at + 2 * DAY + 2 * HOUR]) {
        yield* TestClock.setTime(later);
        yield* KinPulse.tick(orgId, later);
      }
      assert.deepStrictEqual(yield* mateNotices, [
        "W-8 Invented W-8 was due yesterday.",
        "W-8 Invented W-8 was due 3 days ago.",
      ]);
    }).pipe(Effect.provide(chatLayer)),
  );

  it.effect("a teammate's facts are one notice of at most five lines", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* letMate;
      const at = B + 3 * DAY + 12 * HOUR;
      yield* TestClock.setTime(at);
      yield* insert({ id: "W-21", dueAt: B, ownerKind: "person", ownerId: mate });
      yield* insert({ id: "W-22", dueAt: at + 6 * HOUR, ownerKind: "person", ownerId: mate });
      yield* KinPulse.tick(orgId, at);
      assert.deepStrictEqual(yield* mateNotices, [
        [
          "3 of your tasks need you:",
          "• W-21 Invented W-21, was due 3 days ago",
          "• W-8 Invented W-8, was due yesterday",
          "• W-22 Invented W-22, due today",
        ].join("\n"),
      ]);
      const line = (n: number) => ({ key: `W-${n}`, title: "Invented", state: "due today" });
      assert.strictEqual(
        holderBody([1, 2, 3, 4, 5, 6, 7].map(line)),
        [
          "7 of your tasks need you:",
          ...[1, 2, 3, 4, 5].map((n) => `• W-${n} Invented, due today`),
          "and 2 more",
        ].join("\n"),
      );
    }).pipe(Effect.provide(chatLayer)),
  );

  it.effect("a private task is counted in its holder's notice, never named", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* letMate;
      const sql = yield* SqlClient.SqlClient;
      const at = B + 3 * DAY + 12 * HOUR;
      yield* TestClock.setTime(at);
      const zoya = KinPersonId.make("zoya");
      const dev = KinPersonId.make("dev");
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, access, created_at)
        VALUES (${zoya}, ${orgId}, 'zoya', 'Zoya', 'co_owner', ${stamp}),
          (${dev}, ${orgId}, 'dev', 'Dev', 'member', ${stamp})`;
      yield* sql`INSERT INTO kin_lead_access (org_id, agent_id, person_id, granted_by, granted_at)
        VALUES (${orgId}, ${chief}, ${dev}, ${owner}, 0)`;
      // "Only me": each marked their own due-today task private. Meera's late one is W-8.
      const onlyMe = (id: string, holder: KinPersonId) =>
        insert({ id, dueAt: at + 6 * HOUR, ownerKind: "person", ownerId: holder }).pipe(
          Effect.andThen(
            sql`UPDATE kin_records SET sensitive = 1, marked_by_person_id = ${holder}
              WHERE record_id = ${`r-${id}`}`,
          ),
        );
      yield* onlyMe("W-40", mate);
      yield* onlyMe("W-41", zoya);
      yield* onlyMe("W-42", dev);
      yield* insert({ id: "W-43", dueAt: B + 2 * DAY, ownerKind: "person", ownerId: zoya });
      yield* KinPulse.tick(orgId, at);
      const count = "1 private task of yours is due today. Open Tasks to see it.";
      assert.deepStrictEqual(yield* mateNotices, [`W-8 Invented W-8 was due yesterday.\n${count}`]);
      assert.deepStrictEqual(yield* noticesTo(zoya), [
        `W-43 Invented W-43 was due yesterday.\n${count}`,
      ]);
      assert.deepStrictEqual(yield* noticesTo(dev), [count]);
      // Counted is told: the next pass says nothing more.
      yield* KinPulse.tick(orgId, at + HOUR);
      for (const person of [mate, zoya, dev]) assert.lengthOf(yield* noticesTo(person), 1);
      assert.strictEqual(
        holderBody(
          [],
          [{ sense: "task_late" }, { sense: "task_late" }, { sense: "task_due_soon" }],
        ),
        "2 private tasks of yours are late and 1 is due today. Open Tasks to see them.",
      );
    }).pipe(Effect.provide(chatLayer)),
  );

  it.effect("an away teammate is told once they are back; a removed one never", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* letMate;
      const sql = yield* SqlClient.SqlClient;
      const chats = yield* KinChatService;
      const at = B + 3 * DAY + 12 * HOUR;
      yield* TestClock.setTime(at);
      yield* sql`UPDATE kin_people SET away_until = '2026-11-06' WHERE person_id = ${mate}`;
      yield* KinPulse.tick(orgId, at);
      yield* deliverHeld(orgId, chats);
      assert.lengthOf(yield* mateNotices, 0);
      const back = B + 5 * DAY + 12 * HOUR;
      yield* TestClock.setTime(back);
      yield* deliverHeld(orgId, chats);
      yield* KinPulse.tick(orgId, back);
      yield* deliverHeld(orgId, chats);
      assert.deepStrictEqual(yield* mateNotices, ["W-8 Invented W-8 was due yesterday."]);

      // Removed: a new late task of theirs reaches no one, by notice or by wake.
      yield* sql`UPDATE kin_people SET removed_at = ${back} WHERE person_id = ${mate}`;
      yield* insert({ id: "W-23", dueAt: B + 4 * DAY, ownerKind: "person", ownerId: mate });
      const removed = yield* KinPulse.tick(orgId, back + HOUR);
      assert.isFalse(removed.told.some((one) => one.key.startsWith("task_late:W-23:")));
      assert.lengthOf(yield* mateNotices, 1);
    }).pipe(Effect.provide(chatLayer)),
  );

  it.effect("the owner's away holds only his own wake, and his coming back lets it go", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const at = B + 3 * DAY + 12 * HOUR;
      yield* TestClock.setTime(at);
      const zoya = KinPersonId.make("zoya");
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, access, created_at)
        VALUES (${zoya}, ${orgId}, 'zoya', 'Zoya', 'co_owner', ${stamp})`;
      // Away through the 5th: back on the 6th, after his quiet hours.
      const ownerAway = (day: string | null) =>
        reholdAfter(
          orgId,
          owner,
          sql`UPDATE kin_people SET away_until = ${day} WHERE person_id = ${owner}`,
        );
      yield* ownerAway("2026-11-06");
      yield* insert({ id: "W-20", dueAt: B + 2 * DAY, ownerKind: "person", ownerId: owner });
      yield* insert({ id: "W-30", dueAt: at + 6 * HOUR, ownerKind: "person", ownerId: zoya });
      yield* KinPulse.tick(orgId, at);
      // The co-owner's work due today reaches her now, in her own chat, and wakes no one.
      assert.deepStrictEqual(yield* noticesTo(zoya), ["W-30 Invented W-30 due today."]);
      const wakes = sql<{ keys: string; at: number | null }>`SELECT
          json_extract(json, '$.factKeys') AS keys, not_before AS at
        FROM kin_events WHERE org_id = ${orgId} AND dedupe_key LIKE 'holders:%'
        ORDER BY event_id`;
      const [held] = yield* wakes;
      assert.include(held!.keys, "task_late:W-20:");
      assert.notInclude(held!.keys, "W-30");
      assert.strictEqual(held!.at, B + 5 * DAY + 7 * HOUR);
      // "I'm back": the wake for his own late work goes now, not at the old cutoff.
      yield* TestClock.setTime(at + HOUR);
      yield* ownerAway(null);
      assert.deepStrictEqual(
        (yield* wakes).map((wake) => wake.at),
        [at + HOUR],
      );
    }).pipe(Effect.provide(chatLayer)),
  );

  it.effect("a tick moves screens' pulse for a fact whose words changed, and not for nothing", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const touched: Array<string> = [];
      const observed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provideService(KinRefreshObserver, {
            touch: (_org, topic) => Effect.sync(() => void touched.push(topic)),
          }),
        );
      const at = B + 17 * DAY + 7 * MINUTE;
      yield* observed(KinPulse.tick(orgId, at));
      touched.length = 0;
      yield* observed(KinPulse.tick(orgId, at));
      assert.deepStrictEqual(touched, []);
      // The same facts, one of them now worded with the invoice's new title.
      yield* sql`UPDATE kin_records SET title = 'Invented renamed invoice' WHERE record_id = 'r-INV-1'`;
      const renamed = yield* observed(KinPulse.tick(orgId, at));
      assert.strictEqual(renamed.cleared, 0);
      assert.deepStrictEqual(touched, ["pulse"]);
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
      // A check-in given it to tell names who has it; other turns leave it out.
      const shown = (when: number, checkIn: ReadonlySet<string> | undefined) =>
        buildPulseSection({ orgId, agentId: chief, now: when, wokeFor: [], checkIn }).pipe(
          Effect.map((section) =>
            section?.byProject.flatMap((group) => group.facts).find((one) => one.key === fact.key),
          ),
        );
      assert.isUndefined(yield* shown(at, undefined));
      const held = yield* shown(at, new Set([fact.key]));
      assert.include(held, { sentIn: "no mail with it on record", rule: "10 days (now 10)" });
      assert.match(String(held?.inHand), /^fin until /);
      // A check-in not given it to tell (told before, unchanged) never sees it.
      assert.isUndefined(yield* shown(at, new Set()));
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

  // Run of two weeks: 8 of 9 unprompted messages only reminded, as the turn didn't say who to
  // write to, from which account, or which file to attach.
  it.effect("a fact carries its head start: the contact, the mail account and the made file", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const at = B + 12 * DAY;
      const other = KinOrgId.make("other-org");
      yield* sql`INSERT INTO kin_orgs VALUES (${other}, 'Invented Other', ${stamp})`;
      for (const [org, list, prefix] of [
        [orgId, "contacts", "K"],
        [other, "contacts", "K"],
        [other, "docs", "D"],
      ] as const)
        yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in, created_at)
          VALUES (${org}, ${list}, ${list}, ${prefix}, 1, 0)`;
      const contact = (org: KinOrgId, id: string, title: string, email: string | null) =>
        sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, state, owner_kind,
            owner_id, party_id, created_by_kind, created_by_id, origin_key, created_at, updated_at,
            fields_json)
          VALUES (${org}, ${`r-${id}`}, 'contacts', ${id}, ${title}, 'open', 'person', ${owner},
            'r-C-1', 'person', ${owner}, ${`origin-${id}`}, 0, 0,
            ${JSON.stringify(email === null ? {} : { email })})`;
      // Aaron sorts first but has no address; another org's contact on the same ids never shows.
      yield* contact(orgId, "K-1", "Aaron", null);
      yield* contact(orgId, "K-2", "Anita", "anita@lumen.example");
      yield* contact(other, "K-9", "Abel", "leak@other.example");
      const made = (
        org: KinOrgId,
        worker: string,
        file: string,
        draft: boolean,
        createdAt: number,
      ) =>
        Effect.gen(function* () {
          yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, state,
              owner_kind, owner_id, created_by_kind, created_by_id, origin_key, created_at,
              updated_at)
            VALUES (${org}, ${`r-${worker}`}, 'docs', ${`D-${worker}`}, ${file}, 'open', 'agent',
              ${finance}, 'agent', ${finance}, ${`origin-${worker}`}, 0, 0)`;
          yield* sql`INSERT INTO kin_doc_jobs (org_id, worker_id, agent_id, wakeup_id, mode,
              recipe_commit, entry_record_id, inputs_sha256, sensitive, doc_origin, worktree_path,
              branch, audience, created_at)
            VALUES (${org}, ${worker}, ${finance}, 'w', 'recipe', 'c', 'r-INV-5', 'h', 1, 'o', '/w',
              'b', 'owner_only', ${createdAt})`;
          yield* sql`INSERT INTO kin_doc_versions (org_id, record_id, version, body, title, kind,
              summary, operations_json, actor_kind, actor_id, via, origin_key, created_at,
              worker_id, file_json)
            VALUES (${org}, ${`r-${worker}`}, 1, '', ${file}, 'created', 'Made', '[]', 'agent',
              ${finance}, 'lead', ${`v-${worker}`}, ${createdAt}, ${worker},
              ${JSON.stringify({ name: file, draft })})`;
        });
      yield* made(orgId, "wk-5", "INV-5.pdf", true, B);
      yield* made(other, "wk-9", "LEAK.pdf", false, B + DAY);
      yield* sql`INSERT INTO kin_record_comments (org_id, comment_id, record_id, seq, author_kind,
          author_id, body, request_hash, created_at)
        VALUES (${orgId}, 'cm-1', 'r-W-1', 1, 'person', ${mate}, 'Half done; waiting on copy.',
          'h1', ${B + 9 * DAY}),
          (${other}, 'cm-9', 'r-W-1', 1, 'person', ${mate}, 'leak comment', 'h9', ${B + 11 * DAY})`;
      const connection = (org: KinOrgId, id: string, account: string, paused: number | null) =>
        sql`INSERT INTO kin_connections (org_id, connection_id, preset, label, kind, url_host, auth,
            reach, state, account_label, created_at, updated_at, paused_at)
          VALUES (${org}, ${id}, 'google', 'Google', 'builtin', 'google.example', 'oauth', 'closed',
            'active', ${account}, 1, 1, ${paused})`;
      yield* connection(orgId, "g-1", "accounts@studio.example", null);
      yield* connection(orgId, "g-2", "paused@studio.example", 1);
      yield* connection(other, "g-9", "leak@other.example", null);

      const facts = (yield* read(at)).facts;
      const pick = (sense: string, subject: string) => keyed(facts, sense, subject)[0]!.key;
      const keys = [
        pick("invoice_overdue", "INV-5"),
        pick("invoice_overdue", "INV-1"),
        pick("task_late", "W-1"),
      ];
      const section = () =>
        buildPulseSection({
          orgId,
          agentId: finance,
          now: at,
          wokeFor: [],
          checkIn: new Set(keys),
        });
      const rows = (shown: Effect.Success<ReturnType<typeof section>>) =>
        new Map(
          (shown?.byProject ?? []).flatMap((group) => group.facts).map((one) => [one.key, one]),
        );
      const first = yield* section();
      const byKey = rows(first);
      assert.deepInclude(byKey.get(keys[0]!), {
        writeTo: { name: "Anita", email: "anita@lumen.example" },
        document: { key: "D-wk-5", file: "INV-5.pdf", draft: true },
      });
      assert.deepInclude(byKey.get(keys[1]!), {
        writeTo: "no client on it, so nobody to write to",
        document: "no document made for it yet",
      });
      assert.deepInclude(byKey.get(keys[2]!), {
        lastSaid: { on: "2026-11-10", by: "Meera", text: "Half done; waiting on copy." },
      });
      assert.notProperty(byKey.get(keys[2]!), "writeTo");
      assert.deepStrictEqual(first?.mailFrom, [
        { connection: KinConnectionId.make("g-1"), account: "accounts@studio.example" },
      ]);
      assert.notInclude(JSON.stringify(first), "leak");

      // No address on file and no mail connected: each fact says so, once, in plain words.
      yield* sql`UPDATE kin_records SET fields_json = '{}' WHERE org_id = ${orgId} AND record_id = 'r-K-2'`;
      yield* sql`UPDATE kin_connections SET removed_at = 1 WHERE org_id = ${orgId}`;
      const bare = yield* section();
      assert.strictEqual(rows(bare).get(keys[0]!)?.writeTo, "Lumen has no contact with an email");
      assert.notProperty(bare, "mailFrom");
      yield* sql`UPDATE kin_records SET fields_json = '{"email":"anita@lumen.example"}'
        WHERE org_id = ${orgId} AND record_id = 'r-K-2'`;
      assert.strictEqual((yield* section())?.mailFrom, "no mail account is connected");
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
      // Her access removed, her open tasks stay hers and are the owner's to settle; no agent's.
      yield* sql`UPDATE kin_people SET removed_at = ${at} WHERE person_id = ${mate}`;
      const removed = keyed((yield* read(at)).facts, "holder_removed", "W-8")[0];
      assert.deepStrictEqual(removed?.actor, { _tag: "owner" });
      assert.match(removed?.consequence ?? "", /^Held by .+, whose access was removed\./);
      assert.notInclude(
        (yield* read(at, { _tag: "people", people: [mate] })).facts.map((fact) => fact.sense),
        "holder_removed",
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a missing month's statement is one line for the owner, its count Kin's own", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const statement = (id: string, from: string, to: string, applied: boolean) =>
        sql`INSERT INTO kin_bank_statements (org_id, statement_id, attachment_id, file_name,
            chat_id, agent_id, wakeup_id, status, review_json, created_at, read_at, applied_at)
          VALUES (${orgId}, ${id}, ${`att-${id}`}, 'invented.csv', ${`chat-${finance}`},
            ${finance}, 'w-old', 'read', ${JSON.stringify({
              statement: {
                kind: "account",
                bank: "Invented Bank",
                account: "1234",
                currency: "INR",
                from,
                to,
                rows: [],
              },
            })}, 0, 0, ${applied ? 1 : null})`;
      const missing = (at: number, viewer?: KinPulse.Viewer) =>
        read(at, viewer).pipe(
          Effect.map((pulse) => pulse.facts.filter((fact) => fact.sense === "statement_missing")),
        );
      // A company that never confirmed a statement has no month to wait on.
      assert.lengthOf(yield* missing(B + 20 * DAY), 0);
      yield* statement("st-sep", "2026-09-01", "2026-09-30", true);
      yield* insert({
        id: "INV-71",
        list: "invoices",
        state: "waiting",
        amount: 9_000_00,
        dueAt: B - 5 * DAY,
      });
      // October ended on the 31st; five days on by default, it is a line on the 6th.
      assert.lengthOf(yield* missing(B + 5 * DAY - MINUTE), 0);
      const [october] = yield* missing(B + 5 * DAY);
      assert.deepInclude(october!, {
        key: "statement_missing:2026-10",
        consequence: "October's statement isn't in yet: 1 invoice can't be confirmed until it is.",
        family: "money",
        sensitive: true,
        wake: "brief",
        actor: { _tag: "agent", agentId: finance },
      });
      // Another unpaid invoice changes its words, never its key or what it is told on: once.
      yield* insert({
        id: "INV-72",
        list: "invoices",
        state: "waiting",
        amount: 1_000_00,
        dueAt: B - 2 * DAY,
      });
      const [later] = yield* missing(B + 9 * DAY);
      assert.strictEqual(
        later!.consequence,
        "October's statement isn't in yet: 2 invoices can't be confirmed until it is.",
      );
      assert.strictEqual(later!.key, october!.key);
      assert.strictEqual(
        factSig(later!, B + 9 * DAY, "UTC"),
        factSig(october!, B + 5 * DAY, "UTC"),
      );
      // A screen of a build that can't read the sense never gets it.
      assert.lengthOf(screenFacts([october!], undefined), 0);
      assert.lengthOf(screenFacts([october!], ["statement_missing"]), 1);
      // A teammate never reads it.
      assert.lengthOf(yield* missing(B + 9 * DAY, { _tag: "people", people: [mate] }), 0);
      // Read but not confirmed, October is still missing; confirmed, the line is gone.
      yield* statement("st-oct", "2026-10-01", "2026-10-31", false);
      assert.lengthOf(yield* missing(B + 9 * DAY), 1);
      yield* sql`UPDATE kin_bank_statements SET applied_at = 1 WHERE statement_id = 'st-oct'`;
      assert.lengthOf(yield* missing(B + 9 * DAY), 0);
      // The company's playbook sets the days: November's line waits ten after the 30th.
      yield* insert({ id: "D-3", list: "docs", category: "playbook" });
      yield* sql`INSERT INTO kin_doc_versions (org_id, record_id, version, body, title, kind, summary,
          operations_json, actor_kind, actor_id, via, origin_key, created_at)
        VALUES (${orgId}, 'r-D-3', 1, ${"# Money\n\n```kin\nstatement_due_days: 10\n```\n"},
          'Money', 'created', 'Seeded', '[]', 'person', ${owner}, 'owner', 'seed-D-3', 0)`;
      assert.lengthOf(yield* missing(B + 40 * DAY - MINUTE), 0);
      const [november] = yield* missing(B + 40 * DAY);
      assert.strictEqual(november!.key, "statement_missing:2026-11");
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

      // Next week's dues: a suggested task is still due, a suggested invoice is owed nowhere.
      yield* insert({ id: "W-20", dueAt: at + 3 * DAY, confirmed: 0 });
      yield* insert({
        id: "INV-8",
        list: "invoices",
        state: "waiting",
        amount: 5_000_00,
        dueAt: at + 3 * DAY,
        confirmed: 0,
      });
      const nextWeek = (yield* buildWeeklySection({ orgId, now: at })).nextWeek;
      assert.isTrue(nextWeek.some((line) => line.includes("W-20")));
      // The weekly brief's figures lead with goals, then overdue money from the same rows.
      const week = yield* weeklyFigures({ orgId, now: at });
      assert.match(week, /^Goals:\n- G-1 .*₹1,00,000 of ₹10,00,000.*behind$/m);
      assert.match(week, /^- INV-1:.*unpaid, overdue for \d+ days; no mail with it on record$/m);
      assert.notMatch(week, /INV-7|INV-8/);
      assert.match(week, /^- Still to come in: ₹1,97,000\.00$/m);
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
      const overdueLine = Effect.map(weeklyFigures({ orgId, now: at }), (now) =>
        now.split("\n").find((line) => line.startsWith("- INV-1:")),
      );
      assert.match(
        String(yield* overdueLine),
        /overdue for \d+ days; sent \S+ from hello@studio.example, no reminder since$/,
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
      assert.match(week, /^Renewals this month:\n- .*DT-1/m);
      assert.include(week, "Open quotes:\n- QT-1: ₹6,00,000.00, sent, no answer yet");
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
            ...(scheduleId === "checkin-morning-figures" ? { figures: true } : {}),
          },
        });
      assert.isTrue(wantsWeekly([checkIn("checkin-weekly")]));
      assert.isTrue(wantsWeekly([checkIn("checkin-morning-figures")]));
      assert.isFalse(wantsWeekly([checkIn("checkin-morning")]));

      // Kin's own figures for the Monday page: one titled section, each line from these rows. The
      // agent's prompt has the rest of the week, never a row the figures show.
      const now = yield* buildWeeklySection({ orgId, now: at });
      const figures = yield* weeklyFigures({ orgId, now: at });
      assert.lengthOf(figures.split(`## ${WEEK_FIGURES_TITLE}`), 2);
      assert.isTrue(figures.startsWith(`## ${WEEK_FIGURES_TITLE}\n\n${now.week}\n\n`));
      assert.include(figures, `Overdue:\n${String(yield* overdueLine)}`);
      assert.deepStrictEqual(Object.keys(now), [
        "week",
        "projects",
        "meetingsLastWeek",
        "people",
        "nextWeek",
      ]);
      assert.notProperty(now.projects, "behind");
      for (const line of [...now.meetingsLastWeek, ...now.nextWeek])
        assert.notInclude(figures, line);
      // Any currency: the same rows kept in euros read in euros, and no rupee is left.
      yield* sql`UPDATE kin_records SET currency = 'EUR',
          fields_json = REPLACE(fields_json, '"INR"', '"EUR"')
        WHERE org_id = ${orgId}`;
      yield* sql`UPDATE kin_record_payments SET currency = 'EUR' WHERE org_id = ${orgId}`;
      const euros = yield* weeklyFigures({ orgId, now: at });
      assert.include(euros, "Open quotes:\n- QT-1: €600,000.00, sent, no answer yet");
      assert.notInclude(euros, "₹");
    }).pipe(Effect.provide(layer)),
  );
});

describe("project_quiet's last change", () => {
  // A seeded generator, so a failing company can be built again from its number.
  const random = (seed: number) => {
    let state = seed;
    return (below: number) => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return state % below;
    };
  };

  it.effect(
    "is what one query over the project and its entries together says, for any company",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        for (let company = 0; company < 25; company += 1) {
          const next = random(company + 1);
          const projects = Array.from({ length: 1 + next(6) }, (_, n) => `PX${company}-${n}`);
          for (const id of projects) {
            yield* insert({ id, list: "projects", state: next(4) === 0 ? "done" : "open" });
            if (next(3) === 0) yield* change(id, B - next(40) * DAY);
            for (let task = 0; task < next(5); task += 1) {
              const taskId = `${id}-W${task}`;
              yield* insert({ id: taskId, projectId: id, state: next(3) === 0 ? "done" : "open" });
              for (let moved = 0; moved < next(4); moved += 1)
                yield* change(taskId, B - next(60) * DAY - next(DAY));
            }
          }
          const ours = yield* sql<{ key: string; lastAt: number }>`SELECT r.key,
            ${projectLastMoved(sql)} AS "lastAt"
          FROM kin_records r WHERE r.org_id = ${orgId} AND r.register_id = 'projects'
          ORDER BY r.key`;
          // How project_quiet read it before: right, but a scan of every change per project.
          const reference = yield* sql<{ key: string; lastAt: number | null }>`SELECT r.key,
            (SELECT MAX(ch.at) FROM kin_record_changes ch
              JOIN kin_records t ON t.org_id = ch.org_id AND t.record_id = ch.record_id
              WHERE ch.org_id = r.org_id AND (t.record_id = r.record_id OR t.project_id = r.record_id))
              AS "lastAt"
          FROM kin_records r WHERE r.org_id = ${orgId} AND r.register_id = 'projects'
          ORDER BY r.key`;
          assert.deepStrictEqual(
            ours.map((row) => [row.key, row.lastAt === -1 ? null : row.lastAt]),
            reference.map((row) => [row.key, row.lastAt]),
            `company ${company}`,
          );
        }
      }).pipe(Effect.provide(layer)),
  );
});
