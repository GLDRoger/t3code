import { assert, describe, it } from "@effect/vitest";
import {
  KinAgentId,
  KinConnectionId,
  KinEvent,
  KinEventId,
  KinOrgId,
  KinPersonId,
  KinRecordId,
  KinWakeupId,
  type KinPulseFact,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
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
import { wordOf } from "./holds.ts";
import * as KinShell from "../shell/KinShell.ts";
import * as Reach from "../lead/Reach.ts";
import * as KinPulse from "./KinPulse.ts";
import { headStarts } from "./headStart.ts";
import {
  DRAFT_CALL_NOTES,
  DRAFT_CHASE,
  DRAFT_DEAL,
  DRAFT_DOCUMENT,
  DRAFT_MEETING_PREP,
  docHeadStart,
  draftWakeGone,
  DRAFT_FROM_MAILBOX,
  draftWakeText,
} from "./draftWake.ts";
import { buildPulseSection } from "./prompt.ts";
import { screenFacts } from "./people.ts";
import { factSig, markTold, untold } from "./told.ts";
import { offTurnTexts } from "./senses/numbers.ts";
import { wakeHeldUntil } from "./prepareWake.ts";
import { morningMoneyLines } from "./morningMoney.ts";
import { KIN_OWNER_LEVEL, viewerOfPeople } from "../work/teamView.ts";
import { projectLastMoved } from "./senses/projects.ts";
import { buildWeeklySection, wantsWeekly, WEEK_FIGURES_TITLE, weeklyFigures } from "./weekly.ts";
import { ensureBankList } from "../work/statements/bankList.ts";
import { formatMoneyPlain } from "../work/money.ts";

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

const layer = KinShell.layer.pipe(
  Layer.provideMerge(KinEventQueue.layer),
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

/** Meera reads Docs, so a doc made for her task is one she can open. */
const matesDocs = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE kin_people SET sees_docs = 1 WHERE person_id = ${mate}`;
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

      yield* sql`UPDATE kin_records SET fields_json = '{"number":"AM/26-27/001"}'
        WHERE record_id = 'r-INV-1'`;
      const overdue = keyed((yield* read(B + 12 * DAY)).facts, "invoice_overdue", "INV-1")[0]!;
      assert.strictEqual(overdue.consequence, "₹1,77,000 owed, 10 days past due (2026-11-03).");
      assert.strictEqual(overdue.subject.number, "AM/26-27/001");
      assert.deepStrictEqual(overdue.actor, { _tag: "agent", agentId: finance });
      assert.deepStrictEqual(overdue.measure?.from, { _tag: "default" });
      const lumen = keyed((yield* read(B + 9 * DAY)).facts, "invoice_overdue", "INV-5")[0]!;
      assert.notProperty(lumen.subject, "number");
      assert.deepStrictEqual(lumen.measure?.from, {
        _tag: "playbook",
        key: "D-1",
        title: "Invented D-1",
      });
      yield* insert({
        id: "W-16",
        category: "meeting",
        partyId: "r-C-1",
        dateAt: B - 31 * DAY,
      });
      yield* sql`UPDATE kin_records SET party_id = 'r-C-1'
        WHERE org_id = ${orgId} AND record_id IN ('r-QT-1', 'r-INV-6')`;
      yield* sql`UPDATE kin_records SET date_at = ${B + 2 * DAY}
        WHERE org_id = ${orgId} AND record_id = 'r-QT-1'`;
      const shell = yield* KinShell.KinShell;
      let rev = (yield* shell.get(orgId)).rev;
      for (const [sections, words] of [
        [[], "calls, meetings, mail, invoices and payments count; the last was a quote"],
        [
          [{ id: "invoices", on: false }],
          "calls, meetings, mail and payments count; the last was a payment",
        ],
        [[{ id: "money", on: false }], "calls, meetings and mail count; the last was a meeting"],
      ] as const) {
        rev = (yield* shell.set(orgId, owner, rev, sections)).rev;
        const [fact] = keyed((yield* read(B + 60 * DAY)).facts, "client_cold", "C-1");
        assert.include(fact?.consequence, words);
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "a renewal is mentioned from its heads-up and handed over to draft from its draft day",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const stageOf = (subject: string, at: number) =>
          read(at).pipe(Effect.map((result) => keyed(result.facts, "renewal_due", subject)[0]));
        // DT-1 is due on the 41st day: mentioned from 14 days before, drafted from 7.
        assert.isUndefined(yield* stageOf("DT-1", B + 26 * DAY - MINUTE));
        const ahead = (yield* stageOf("DT-1", B + 33 * DAY - MINUTE))!;
        assert.strictEqual(ahead.stage, "heads_up");
        assert.include(ahead.consequence, "drafting starts 2026-12-04, not before");
        assert.isFalse((yield* headStarts(orgId, [ahead])).byFact.has(ahead.key));
        const drafting = (yield* stageOf("DT-1", B + 33 * DAY))!;
        assert.strictEqual(drafting.stage, "draft");
        assert.notInclude(drafting.consequence, "drafting starts");
        assert.isTrue((yield* headStarts(orgId, [drafting])).byFact.has(drafting.key));
        // Nobody is told to act on a heads-up; from the draft day, Finance acts.
        const told = (fact: KinPulseFact, now: number) =>
          buildPulseSection({
            orgId,
            agentId: chief,
            now,
            wokeFor: [],
            checkIn: new Set([fact.key]),
          }).pipe(Effect.map((section) => section?.byProject.flatMap((group) => group.facts)[0]));
        assert.notProperty(yield* told(ahead, B + 33 * DAY - MINUTE), "acts");
        assert.include(yield* told(drafting, B + 33 * DAY), { acts: "fin (fin)" });
        // Lumen's own playbook drafts 3 days ahead; the company's, 10.
        yield* insert({
          id: "DT-3",
          list: "dates",
          category: "renewal",
          dueAt: B + 40 * DAY,
          partyId: "r-C-1",
        });
        yield* sql`UPDATE kin_doc_versions SET body = ${"# Chasing Lumen\n\n```kin\nchase_invoice_after_days: 7\nrenewal_draft_days: 3\n```\n"}
        WHERE record_id = 'r-D-1'`;
        assert.strictEqual((yield* stageOf("DT-3", B + 37 * DAY - MINUTE))?.stage, "heads_up");
        assert.strictEqual((yield* stageOf("DT-3", B + 37 * DAY))?.stage, "draft");
        yield* insert({ id: "D-4", list: "docs", category: "playbook" });
        yield* sql`INSERT INTO kin_doc_versions (org_id, record_id, version, body, title, kind, summary,
          operations_json, actor_kind, actor_id, via, origin_key, created_at)
        VALUES (${orgId}, 'r-D-4', 1, ${"# Renewals\n\n```kin\nrenewal_draft_days: 10\n```\n"},
          'Renewals', 'created', 'Seeded', '[]', 'person', ${owner}, 'owner', 'seed-D-4', 0)`;
        assert.strictEqual((yield* stageOf("DT-1", B + 30 * DAY - MINUTE))?.stage, "heads_up");
        assert.strictEqual((yield* stageOf("DT-1", B + 30 * DAY))?.stage, "draft");
        assert.strictEqual((yield* stageOf("DT-3", B + 37 * DAY - MINUTE))?.stage, "heads_up");
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
      // Back under the same key: a new wake, once.
      yield* sql`UPDATE kin_records SET state = 'waiting' WHERE record_id = 'r-INV-1'`;
      const back = yield* KinPulse.tick(orgId, at + 3 * MINUTE);
      const overdue = first.woken.filter((key) => key.startsWith("invoice_overdue:"));
      assert.deepStrictEqual(back.woken, overdue);
      assert.lengthOf((yield* KinPulse.tick(orgId, at + 4 * MINUTE)).woken, 0);
      const wakes = yield* sql`SELECT 1 FROM kin_events WHERE org_id = ${orgId} AND tag = 'pulse'
          AND dedupe_key NOT LIKE 'holders:%'`;
      assert.lengthOf(wakes, first.woken.length + overdue.length);
      for (const [minute, retries] of [
        [3, 1],
        [5, 1],
        [7, 0],
      ] as const) {
        yield* sql`UPDATE kin_events SET state = 'failed' WHERE org_id = ${orgId}
          AND dedupe_key = ${`${overdue[0]}:${at + minute * MINUTE}`}`;
        const result = yield* KinPulse.tick(orgId, at + (minute + 2) * MINUTE);
        assert.lengthOf(
          result.woken.filter((key) => key === overdue[0]),
          retries,
        );
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "an unanswered quote, a renewal from its draft day and a client waiting on us wake once",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const PREPARED = ["quote_unanswered", "renewal_due", "client_waiting_on_us"];
        const wakes = Effect.map(
          sql<{ agent: string; key: string; at: number | null }>`SELECT agent_id AS agent,
              json_extract(json, '$.factKeys[0]') AS key, not_before AS at
            FROM kin_events WHERE org_id = ${orgId} AND tag = 'pulse'
              AND dedupe_key NOT LIKE 'holders:%' ORDER BY key`,
          (rows) => rows.filter((row) => PREPARED.includes(row.key.split(":")[0]!)),
        );
        // The owner sleeps 22:00 to 07:00 UTC: the quote waits for the morning; a client
        // waiting on us is urgent, so its agent starts now.
        yield* sql`UPDATE kin_people SET quiet_hours_json = '{"from":"22:00","to":"07:00"}'
          WHERE person_id = ${owner}`;
        const night = B + 6 * DAY + MINUTE;
        yield* KinPulse.tick(orgId, night);
        const quote = `quote_unanswered:QT-1:last=${B}`;
        const [waiting] = (yield* wakes).filter((wake) => wake.key !== quote);
        assert.deepStrictEqual(yield* wakes, [
          { agent: chief, key: waiting!.key, at: null },
          { agent: finance, key: quote, at: B + 6 * DAY + 7 * HOUR },
        ]);
        assert.match(waiting!.key, /^client_waiting_on_us:/);
        // Once per fact: later passes add nothing, even when it clears and comes back while
        // its wake still waits for the morning.
        yield* sql`UPDATE kin_records SET state = 'done' WHERE record_id = 'r-QT-1'`;
        yield* KinPulse.tick(orgId, night + MINUTE);
        yield* sql`UPDATE kin_records SET state = 'waiting' WHERE record_id = 'r-QT-1'`;
        yield* KinPulse.tick(orgId, night + 2 * MINUTE);
        assert.lengthOf(yield* wakes, 2);
        yield* KinPulse.tick(orgId, night + HOUR);
        yield* KinPulse.tick(orgId, B + 7 * DAY);
        assert.lengthOf(yield* wakes, 2);
        // A renewal is only mentioned at its heads-up, and wakes its agent from its draft day
        // (midnight: after the owner's quiet hours).
        yield* KinPulse.tick(orgId, B + 33 * DAY - MINUTE);
        assert.lengthOf(yield* wakes, 2);
        yield* KinPulse.tick(orgId, B + 33 * DAY);
        assert.deepInclude(yield* wakes, {
          agent: finance,
          key: `renewal_due:DT-1:due=${B + 40 * DAY}`,
          at: B + 33 * DAY + 7 * HOUR,
        });
        // As its turn starts it senses again: answered since the last tick, the quote has nothing.
        const live = (at: number) =>
          Effect.map(KinPulse.standingNow(orgId, [quote, quote], at), (facts) =>
            facts.map((fact) => fact.key),
          );
        assert.deepStrictEqual(yield* live(B + 33 * DAY), [quote]);
        yield* sql`UPDATE kin_records SET state = 'done' WHERE record_id = 'r-QT-1'`;
        assert.deepStrictEqual(yield* live(B + 33 * DAY + MINUTE), []);
        // A renewal before its draft day is only mentioned: no head start stands for it.
        const renewal = `renewal_due:DT-1:due=${B + 40 * DAY}`;
        assert.deepStrictEqual(
          yield* Effect.map(KinPulse.standingNow(orgId, [renewal], B + 33 * DAY - MINUTE), (f) =>
            f.map((fact) => fact.key),
          ),
          [],
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect("an agent gets at most twenty head starts a day, longest standing first", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      for (let n = 0; n < 25; n++)
        yield* insert({
          id: `QT-${100 + n}`,
          list: "quotes",
          state: "waiting",
          amount: 1_000_00,
          createdAt: B + (n + 1) * MINUTE,
        });
      const headStarts = Effect.map(
        sql<{ key: string }>`SELECT json_extract(json, '$.factKeys[0]') AS key FROM kin_events
          WHERE org_id = ${orgId} AND tag = 'pulse' AND agent_id = ${finance}
            AND json_extract(json, '$.factKeys[0]') LIKE 'quote_unanswered:%'
          ORDER BY key`,
        (rows) => rows.map((row) => row.key.split(":")[1]!),
      );
      const day = B + 20 * DAY + 9 * HOUR;
      yield* KinPulse.tick(orgId, day);
      const first = yield* headStarts;
      // With the seed's QT-1, 26 stand: the 20 oldest start today; the six quoted last wait,
      // unwoken, through the rest of the day.
      assert.lengthOf(first, 20);
      assert.include(first, "QT-1");
      assert.notInclude(first, "QT-119");
      yield* KinPulse.tick(orgId, day + HOUR);
      assert.deepStrictEqual(yield* headStarts, first);
      const unwoken = yield* sql`SELECT fact_key FROM kin_pulse_facts WHERE org_id = ${orgId}
        AND sense = 'quote_unanswered' AND woke_at IS NULL`;
      assert.lengthOf(unwoken, 6);
      yield* KinPulse.tick(orgId, day + DAY);
      assert.lengthOf(yield* headStarts, 26);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "a late task wakes its agent once per age band and again when the due day changes",
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
        yield* sql`UPDATE kin_events SET state = 'done' WHERE org_id = ${orgId}
          AND dedupe_key = ${`holders:${chief}:${at}`}`;
        for (const [offset, count] of [
          [HOUR, 0],
          [DAY, 0],
          [2 * DAY, 1],
          [3 * DAY, 0],
          [6 * DAY, 1],
        ] as const) {
          assert.lengthOf(
            lateW1((yield* KinPulse.tick(orgId, at + offset)).told.map((one) => one.key)),
            count,
          );
        }
        const [thirdDay] = yield* sql<{ eventId: string }>`SELECT event_id AS "eventId"
          FROM kin_events WHERE org_id = ${orgId} AND dedupe_key = ${`holders:${chief}:${at + 2 * DAY}`}
          ORDER BY event_id`;
        const section = yield* buildPulseSection({
          orgId,
          agentId: chief,
          now: at + 2 * DAY,
          wokeFor: [`task_late:W-1:due=${B + 10 * DAY}`],
          pulseEvents: [thirdDay!.eventId],
        });
        assert.match(
          section!.byProject
            .flatMap((group) => group.facts)
            .find((row) => row.key.startsWith("task_late:W-1:"))!.consequence,
          / Still open since 2026-11-11\.$/,
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
      yield* matesDocs;
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
      assert.deepStrictEqual(yield* noticesTo(owner), []);
      // Told of it, she also gets its head start: a wake to make its first piece, once that day.
      assert.deepInclude(first.drafted, { personId: mate, key });
      // Later passes, in the same minute or the next day, add nothing.
      for (const later of [at + 1, at + MINUTE, at + DAY]) {
        yield* TestClock.setTime(later);
        const again = yield* KinPulse.tick(orgId, later);
        assert.lengthOf(
          again.told.filter((one) => one.key === key),
          0,
        );
        // Once a day: the next day may bring its next head start.
        if (later < at + DAY) assert.notDeepInclude(again.drafted, { personId: mate, key });
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

  it.effect("a teammate's late promise reaches the person it was promised to, at its bands", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* letMate;
      const sql = yield* SqlClient.SqlClient;
      const zoya = KinPersonId.make("zoya");
      const dev = KinPersonId.make("dev");
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, access, created_at)
        VALUES (${zoya}, ${orgId}, 'zoya', 'Zoya', 'member', ${stamp}),
          (${dev}, ${orgId}, 'dev', 'Dev', 'member', ${stamp})`;
      yield* sql`INSERT INTO kin_lead_access (org_id, agent_id, person_id, granted_by, granted_at)
        VALUES (${orgId}, ${chief}, ${zoya}, ${owner}, 0), (${orgId}, ${chief}, ${dev}, ${owner}, 0)`;
      yield* sql`UPDATE kin_records SET state = 'done' WHERE record_id = 'r-W-8'`;
      const promised = (id: string, to: KinPersonId, title = `Invented ${id}`) =>
        insert({
          id,
          title,
          dueAt: B + 2 * DAY,
          ownerKind: "person",
          ownerId: zoya,
          // Recorded in the team room, so the team sees it.
          teamShared: 1,
          fields: JSON.stringify({ promisedTo: `person:${to}` }),
        });
      yield* promised("W-42", mate, "Homepage mockups");
      // Kept Only me by Zoya: Meera may not see it, so she hears nothing of it.
      yield* promised("W-50", mate);
      yield* sql`UPDATE kin_records SET sensitive = 1, marked_by_person_id = ${zoya}
        WHERE record_id = 'r-W-50'`;
      // The owner hears a teammate's late work in his check-in; Dev has left.
      yield* promised("W-51", owner);
      yield* promised("W-52", dev);
      yield* sql`UPDATE kin_people SET removed_at = 0 WHERE person_id = ${dev}`;
      const line =
        "W-42 Homepage mockups, which Zoya promised you by Tue 3 Nov, is late. Kin has told Zoya.";
      const late = (days: number) => B + (2 + days) * DAY + 12 * HOUR;
      for (const at of [late(1), late(2), late(3), late(6), late(7)]) {
        yield* TestClock.setTime(at);
        yield* KinPulse.tick(orgId, at);
      }
      assert.deepStrictEqual(yield* mateNotices, [line, line, line]);
      assert.deepStrictEqual(yield* noticesTo(owner), []);
      assert.deepStrictEqual(yield* noticesTo(dev), []);
      const told = yield* sql<{ key: string; at: number }>`SELECT fact_key AS key, told_at AS at
        FROM kin_pulse_told WHERE org_id = ${orgId} AND person_id = ${mate} ORDER BY told_at`;
      assert.deepStrictEqual(
        told.map((row) => [row.key, row.at]),
        [late(1), late(3), late(7)].map((at) => [`task_late:W-42:due=${B + 2 * DAY}`, at]),
      );
      // Zoya's own notices are as they were: she alone holds it.
      assert.include((yield* noticesTo(zoya))[0], "• W-42 Homepage mockups, was due yesterday");
    }).pipe(Effect.provide(chatLayer)),
  );

  // The sales seat, Meera with Clients on in Los Angeles and allowed to message it, and her
  // late follow-up W-30 to Lumen: 4 Nov 20:00 UTC is noon on 4 Nov in Los Angeles.
  const salesDay = Effect.gen(function* () {
    yield* seed;
    yield* letMate;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id,
        created_at)
      VALUES (${growth}, ${orgId}, 'Growth', 'lead', ${owner}, ${stamp})`;
    yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at)
      VALUES ('chat-growth', ${orgId}, 'team_group', 0, ${stamp})`;
    yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json,
        worker_projects_json, owner_chat_id, domain)
      VALUES (${growth}, ${orgId}, 'Growth', 0, '{}', '[]', 'chat-growth', 'growth')`;
    yield* sql`INSERT INTO kin_lead_access (org_id, agent_id, person_id, granted_by, granted_at)
      VALUES (${orgId}, ${growth}, ${mate}, ${owner}, 0)`;
    yield* sql`UPDATE kin_people SET sees_clients = 1, time_zone = 'America/Los_Angeles'
      WHERE person_id = ${mate}`;
    // Her other late task is done: the follow-up is all she has open.
    yield* sql`UPDATE kin_records SET state = 'done' WHERE record_id = 'r-W-8'`;
    yield* insert({
      id: "W-30",
      dueAt: B + 2 * DAY,
      ownerKind: "person",
      ownerId: mate,
      partyId: "r-C-1",
    });
    yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in, created_at)
      VALUES (${orgId}, 'contacts', 'contacts', 'CT', 1, 0)`;
    yield* insert({
      id: "CT-1",
      list: "contacts",
      title: "Ravi Menon",
      partyId: "r-C-1",
      fields: '{"email":"ravi@lumen.example"}',
    });
  });
  const growth = KinAgentId.make("growth");
  const NOON_LA = B + 3 * DAY + 20 * HOUR;
  const draftEvents = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ json: string }>`SELECT json FROM kin_events
      WHERE org_id = ${orgId} AND dedupe_key LIKE 'draft:%' ORDER BY received_at, event_id`;
    return rows.flatMap((row) => {
      const event = decodeEvent(JSON.parse(row.json));
      return event._tag === "pulse" ? [event] : [];
    });
  });
  const slots = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{ person: string; key: string; day: string }>`SELECT person_id AS person,
        fact_key AS key, sig AS day FROM kin_pulse_told
      WHERE person_id LIKE 'draft:%' ORDER BY told_at, fact_key`;
  });

  it.effect(
    "a teammate's follow-up wakes the sales agent in her chat, once per task and day in her zone",
    () =>
      Effect.gen(function* () {
        yield* salesDay;
        const sql = yield* SqlClient.SqlClient;
        // No chat with the sales agent yet: the usual path opens one.
        yield* TestClock.setTime(NOON_LA);
        const first = yield* KinPulse.tick(orgId, NOON_LA);
        assert.deepStrictEqual(first.drafted, [
          { personId: mate, key: `task_late:W-30:due=${B + 2 * DAY}` },
        ]);
        const [chat] = yield* sql<{ chatId: string }>`SELECT chat_id AS "chatId" FROM kin_chats
          WHERE direct_key = ${`${mate}:${growth}`}`;
        const [made] = yield* draftEvents;
        assert.deepStrictEqual(
          [made?.chatId, made?.origin],
          [chat?.chatId, { agentId: growth, chatId: chat?.chatId, personId: mate }],
        );
        // Later passes that day wake nothing more.
        yield* TestClock.setTime(NOON_LA + HOUR);
        assert.lengthOf((yield* KinPulse.tick(orgId, NOON_LA + HOUR)).drafted, 0);
        // The wake's turn takes the task's slot for her day; another wake that day does nothing.
        const read = yield* draftWakeText(orgId, made!);
        assert.strictEqual(read?.text, DRAFT_CALL_NOTES("Meera", false));
        assert.deepStrictEqual(read?.data, {
          task: "W-30",
          title: "Invented W-30",
          late: true,
          client: "Lumen",
          writeTo: { name: "Ravi Menon", email: "ravi@lumen.example" },
          mailbox: "none connected",
        });
        assert.deepStrictEqual(yield* slots, [
          { person: `draft:${mate}`, key: "task:r-W-30", day: "2026-11-04" },
        ]);
        const again = { ...made!, eventId: KinEventId.make("pulse-again") };
        assert.isUndefined(yield* draftWakeText(orgId, again));
        // With her own mailbox and a contact she may see: a draft from it.
        yield* sql`INSERT INTO kin_connections (org_id, connection_id, preset, label, kind,
            url_host, auth, reach, state, account_label, created_at, updated_at, person_id)
          VALUES (${orgId}, 'conn-mate', 'google', 'meera@invented.example', 'builtin',
            'gmail.googleapis.com', 'oauth', 'closed', 'active', 'meera@invented.example', 0, 0,
            ${mate})`;
        assert.strictEqual(
          (yield* draftWakeText(orgId, made!))?.text,
          DRAFT_FROM_MAILBOX("Meera", ["meera@invented.example"]),
        );
        // With two that can send, it names both and how to pick: not whichever is oldest.
        yield* sql`INSERT INTO kin_connections (org_id, connection_id, preset, label, kind,
            url_host, auth, reach, state, account_label, created_at, updated_at, person_id)
          VALUES (${orgId}, 'conn-mate-2', 'google', 'meera.home@invented.example', 'builtin',
            'gmail.googleapis.com', 'oauth', 'closed', 'active', 'meera.home@invented.example',
            1, 1, ${mate})`;
        const both = yield* draftWakeText(orgId, made!);
        assert.strictEqual(
          both?.text,
          DRAFT_FROM_MAILBOX("Meera", ["meera@invented.example", "meera.home@invented.example"]),
        );
        assert.include(both?.text, "the one earlier mail with this contact went through");
        assert.deepStrictEqual(both !== undefined && "from" in both.data ? both.data.from : null, [
          "meera@invented.example",
          "meera.home@invented.example",
        ]);
        yield* sql`DELETE FROM kin_connections WHERE connection_id = 'conn-mate-2'`;
        // Her next day in Los Angeles: one more.
        yield* TestClock.setTime(NOON_LA + DAY);
        assert.lengthOf((yield* KinPulse.tick(orgId, NOON_LA + DAY)).drafted, 1);
      }).pipe(Effect.provide(chatLayer)),
  );

  it.effect(
    "a client's late promise to a teammate gets its chase drafted on the days she is told, never within 3 days of a sent mail",
    () =>
      Effect.gen(function* () {
        yield* salesDay;
        const sql = yield* SqlClient.SqlClient;
        // Lumen owes Meera W-30; W-32 is owed to her by nobody named.
        yield* sql`UPDATE kin_records SET side = 'theirs', title = 'Signed SOW'
          WHERE record_id = 'r-W-30'`;
        yield* insert({
          id: "W-32",
          side: "theirs",
          dueAt: B + 2 * DAY,
          ownerKind: "person",
          ownerId: mate,
        });
        yield* sql`INSERT INTO kin_connections (org_id, connection_id, preset, label, kind,
            url_host, auth, reach, state, account_label, created_at, updated_at, person_id)
          VALUES (${orgId}, 'conn-mate', 'google', 'meera@invented.example', 'builtin',
            'gmail.googleapis.com', 'oauth', 'closed', 'active', 'meera@invented.example', 0, 0,
            ${mate})`;
        const key = `theirs_late:W-30:due=${B + 2 * DAY}`;
        const drafted = Effect.fn("test.drafted")(function* (at: number) {
          yield* TestClock.setTime(at);
          return (yield* KinPulse.tick(orgId, at)).drafted.map((one) => one.key);
        });
        // A day late: told, and the chase drafted from her own mailbox.
        assert.deepStrictEqual(yield* drafted(NOON_LA), [key]);
        const [made] = yield* draftEvents;
        const read = yield* draftWakeText(orgId, made!);
        assert.strictEqual(read?.text, DRAFT_CHASE("Meera", ["meera@invented.example"]));
        assert.deepStrictEqual(read?.data, {
          task: "W-30",
          title: "Signed SOW",
          owedBy: "Lumen",
          wasDue: "2026-11-02",
          writeTo: { name: "Ravi Menon", email: "ravi@lumen.example" },
          from: "meera@invented.example",
        });
        // Two days late: not told again, so no chase. Three: both.
        assert.deepStrictEqual(yield* drafted(NOON_LA + DAY), []);
        assert.deepStrictEqual(yield* drafted(NOON_LA + 2 * DAY), [key]);
        // A chase sent through her mailbox: none again until 3 days after it, in the same band.
        yield* sql`INSERT INTO kin_connection_asks (org_id, ask_id, connection_id, tool_name,
            pin_digest, payload_json, agent_id, wakeup_id, chat_id, entry_record_id, proposed_at,
            state, done_at)
          VALUES (${orgId}, 'ask-sent', 'conn-mate', 'mail_send', 'p', '{}', ${growth}, 'w', 'c',
            'r-W-30', 0, 'sent', ${NOON_LA + 3 * DAY})`;
        yield* sql`DELETE FROM kin_pulse_told WHERE person_id = ${`draft:${mate}`}`;
        assert.deepStrictEqual(yield* drafted(NOON_LA + 4 * DAY), []);
        assert.deepStrictEqual(yield* drafted(NOON_LA + 5 * DAY), []);
        assert.deepStrictEqual(yield* drafted(NOON_LA + 6 * DAY), [key]);
      }).pipe(Effect.provide(chatLayer)),
  );

  it.effect("our own late follow-up is not drafted again within 3 days of its mail going", () =>
    Effect.gen(function* () {
      yield* salesDay;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO kin_connections (org_id, connection_id, preset, label, kind,
          url_host, auth, reach, state, account_label, created_at, updated_at, person_id)
        VALUES (${orgId}, 'conn-mate', 'google', 'meera@invented.example', 'builtin',
          'gmail.googleapis.com', 'oauth', 'closed', 'active', 'meera@invented.example', 0, 0,
          ${mate})`;
      const key = `task_late:W-30:due=${B + 2 * DAY}`;
      const drafted = Effect.fn("test.drafted")(function* (at: number) {
        yield* TestClock.setTime(at);
        return (yield* KinPulse.tick(orgId, at)).drafted.map((one) => one.key);
      });
      assert.deepStrictEqual(yield* drafted(NOON_LA), [key]);
      // She confirmed its mail an hour later: the card is gone, the mail went.
      yield* sql`INSERT INTO kin_connection_asks (org_id, ask_id, connection_id, tool_name,
          pin_digest, payload_json, agent_id, wakeup_id, chat_id, entry_record_id, proposed_at,
          state, done_at)
        VALUES (${orgId}, 'ask-sent', 'conn-mate', 'mail_send', 'p', '{}', ${growth}, 'w', 'c',
          'r-W-30', 0, 'sent', ${NOON_LA + HOUR})`;
      assert.deepStrictEqual(yield* drafted(NOON_LA + DAY), []);
      assert.deepStrictEqual(yield* drafted(NOON_LA + 2 * DAY), []);
      assert.deepStrictEqual(yield* drafted(NOON_LA + 3 * DAY + HOUR), [key]);
    }).pipe(Effect.provide(chatLayer)),
  );

  it.effect(
    "a deal gone quiet gets a drafted follow-up for whoever looks after it, once a quiet stretch",
    () =>
      Effect.gen(function* () {
        yield* salesDay;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE kin_records SET state = 'done' WHERE record_id = 'r-W-30'`;
        yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in, created_at)
          VALUES (${orgId}, 'deals', 'deals', 'DL', 1, 0)`;
        yield* sql`INSERT INTO kin_connections (org_id, connection_id, preset, label, kind,
            url_host, auth, reach, state, account_label, created_at, updated_at, person_id)
          VALUES (${orgId}, 'conn-mate', 'google', 'meera@invented.example', 'builtin',
            'gmail.googleapis.com', 'oauth', 'closed', 'active', 'meera@invented.example', 0, 0,
            ${mate})`;
        // Hers; an agent's on her client; an agent's on a client nobody looks after (the owner's).
        yield* sql`UPDATE kin_records SET owner_kind = 'person', owner_id = ${mate}
          WHERE record_id = 'r-C-1'`;
        // C-2 is in the seed, held by the Chief of staff.
        yield* insert({
          id: "DL-1",
          list: "deals",
          title: "Lumen pilot",
          ownerKind: "person",
          ownerId: mate,
          partyId: "r-C-1",
        });
        yield* insert({ id: "DL-2", list: "deals", title: "Lumen refit", partyId: "r-C-1" });
        yield* insert({ id: "DL-3", list: "deals", title: "Harbor fitout", partyId: "r-C-2" });
        const comment = (id: string, seq: number, body: string, at: number) =>
          sql`INSERT INTO kin_record_comments (org_id, comment_id, record_id, seq, body,
              author_kind, author_id, request_hash, created_at)
            VALUES (${orgId}, ${id}, 'r-DL-1', ${seq}, ${body}, 'person', ${mate}, ${id}, ${at})`;
        yield* comment("cm-1", 1, "Ravi wanted the pilot scoped to two sites.", B - 20 * DAY);
        const quietKey = (deal: string, last: number) => `deal_quiet:${deal}:${last}`;
        const drafted = Effect.fn("test.drafted")(function* (at: number) {
          yield* TestClock.setTime(at);
          return (yield* KinPulse.tick(orgId, at)).drafted.map((one) => one.key).toSorted();
        });
        assert.deepStrictEqual(yield* drafted(NOON_LA), [
          quietKey("DL-1", B - 20 * DAY),
          quietKey("DL-2", B - 30 * DAY),
        ]);
        const made = (yield* draftEvents).find((one) => one.factKeys[0]!.includes("DL-1"))!;
        const read = yield* draftWakeText(orgId, made);
        assert.strictEqual(
          read?.text,
          DRAFT_DEAL(
            "Meera",
            ["meera@invented.example"],
            "has had no contact, note or move for 23 days",
          ),
        );
        assert.deepStrictEqual(read?.data, {
          deal: "DL-1",
          title: "Lumen pilot",
          quietDays: 23,
          client: "Lumen",
          lastComment: "Ravi wanted the pilot scoped to two sites.",
          writeTo: { name: "Ravi Menon", email: "ravi@lumen.example" },
          from: "meera@invented.example",
        });
        // A card its wake drew stands for it as the turn starts.
        yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, model,
            started_at, status, event_ids)
          VALUES ('w-deal', ${orgId}, ${growth}, 't-deal', 'test', 0, 'running', '[]')`;
        yield* sql`UPDATE kin_events SET wakeup_id = 'w-deal' WHERE event_id = ${made.eventId}`;
        yield* sql`INSERT INTO kin_connection_asks (org_id, ask_id, connection_id, tool_name,
            pin_digest, payload_json, agent_id, wakeup_id, chat_id, proposed_at)
          VALUES (${orgId}, 'ask-deal', 'conn-mate', 'mail_send', 'p', '{}', ${growth}, 'w-deal',
            'c', 0)`;
        assert.isUndefined(yield* draftWakeText(orgId, made));
        yield* sql`DELETE FROM kin_connection_asks`;
        // The same quiet stretch the next days: nothing more.
        assert.deepStrictEqual(yield* drafted(NOON_LA + DAY), []);
        assert.deepStrictEqual(yield* drafted(NOON_LA + 2 * DAY), []);
        // A note on it ends the stretch; once it is quiet again, one more.
        yield* comment("cm-2", 2, "Ravi is away until the 20th.", NOON_LA + 2 * DAY);
        assert.deepStrictEqual(yield* drafted(NOON_LA + 3 * DAY), []);
        assert.deepStrictEqual(yield* drafted(NOON_LA + 30 * DAY), [
          quietKey("DL-1", NOON_LA + 2 * DAY),
        ]);
        // Deals off for the company: no follow-up for a deal.
        yield* sql`INSERT INTO kin_company_shell VALUES (${orgId}, '[{"id":"deals","on":false}]',
            1, ${owner}, 0)`;
        yield* comment("cm-3", 3, "Still away.", NOON_LA + 31 * DAY);
        assert.deepStrictEqual(yield* drafted(NOON_LA + 60 * DAY), []);
      }).pipe(Effect.provide(chatLayer)),
  );

  it.effect("a deal past its expected day gets a follow-up drafted, and again a week on", () =>
    Effect.gen(function* () {
      yield* salesDay;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE kin_records SET state = 'done' WHERE record_id = 'r-W-30'`;
      yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in, created_at)
        VALUES (${orgId}, 'deals', 'deals', 'DL', 1, 0)`;
      yield* insert({
        id: "DL-1",
        list: "deals",
        title: "Lumen pilot",
        ownerKind: "person",
        ownerId: mate,
        partyId: "r-C-1",
        dueAt: B + 2 * DAY,
        createdAt: B + 2 * DAY,
      });
      const key = `deal_date_passed:DL-1:due=${B + 2 * DAY}`;
      const drafted = Effect.fn("test.drafted")(function* (at: number) {
        yield* TestClock.setTime(at);
        return (yield* KinPulse.tick(orgId, at)).drafted.map((one) => one.key);
      });
      assert.deepStrictEqual(yield* drafted(NOON_LA), [key]);
      const [made] = yield* draftEvents;
      const read = yield* draftWakeText(orgId, made!);
      // No mailbox of hers: call notes, with the day it was expected by.
      assert.strictEqual(read?.text, DRAFT_CALL_NOTES("Meera", false));
      assert.deepStrictEqual(read?.data, {
        deal: "DL-1",
        title: "Lumen pilot",
        expectedBy: "2026-11-02",
        client: "Lumen",
        writeTo: { name: "Ravi Menon", email: "ravi@lumen.example" },
        mailbox: "none connected",
      });
      for (const day of [1, 2, 6]) assert.deepStrictEqual(yield* drafted(NOON_LA + day * DAY), []);
      assert.deepStrictEqual(yield* drafted(NOON_LA + 7 * DAY), [key]);
    }).pipe(Effect.provide(chatLayer)),
  );

  it.effect("a wake checks again as it starts: holder, quiet hours, cards, a private client", () =>
    Effect.gen(function* () {
      yield* salesDay;
      const sql = yield* SqlClient.SqlClient;
      yield* TestClock.setTime(NOON_LA);
      yield* KinPulse.tick(orgId, NOON_LA);
      const [made] = yield* draftEvents;
      // In her quiet hours now: back to the queue until they end, and the slot it took as it
      // queued stays its own.
      yield* sql`UPDATE kin_people SET quiet_hours_json = '{"from":"11:00","to":"13:00"}'
        WHERE person_id = ${mate}`;
      assert.strictEqual(
        yield* wakeHeldUntil(orgId, made!.agentId, [made!], NOON_LA),
        NOON_LA + HOUR,
      );
      assert.deepStrictEqual(
        (yield* slots).map((slot) => slot.key),
        ["task:r-W-30"],
      );
      yield* sql`UPDATE kin_people SET quiet_hours_json = NULL WHERE person_id = ${mate}`;
      // Given to someone else meanwhile: nothing for her.
      // Given to someone else meanwhile, though the team still sees it: nothing for her.
      yield* sql`UPDATE kin_records SET owner_id = ${owner}, team_shared = 1
        WHERE record_id = 'r-W-30'`;
      assert.isUndefined(yield* draftWakeText(orgId, made!));
      yield* sql`UPDATE kin_records SET owner_id = ${mate} WHERE record_id = 'r-W-30'`;
      // A card from her own mailbox stands; a former holder's doesn't.
      yield* sql`INSERT INTO kin_connections (org_id, connection_id, preset, label, kind,
          url_host, auth, reach, state, created_at, updated_at, person_id)
        VALUES (${orgId}, 'conn-mate', 'google', 'm', 'builtin', 'g', 'oauth', 'closed', 'active',
            0, 0, ${mate}),
          (${orgId}, 'conn-before', 'google', 'b', 'builtin', 'g', 'oauth', 'closed', 'active',
            0, 0, ${owner})`;
      const card = (connection: string) =>
        sql`INSERT INTO kin_connection_asks (org_id, ask_id, connection_id, tool_name,
            pin_digest, payload_json, agent_id, wakeup_id, chat_id, entry_record_id, proposed_at)
          VALUES (${orgId}, ${`ask-${connection}`}, ${connection}, 'mail_send', 'p', '{}',
            ${growth}, 'w', 'c', 'r-W-30', 0)`;
      yield* card("conn-before");
      assert.isDefined(yield* draftWakeText(orgId, made!));
      yield* sql`DELETE FROM kin_pulse_told`;
      yield* card("conn-mate");
      assert.isUndefined(yield* draftWakeText(orgId, made!));
      yield* sql`DELETE FROM kin_connection_asks`;
      // Lumen marked private: her wake names neither the client nor its contact: call notes.
      yield* sql`UPDATE kin_records SET sensitive = 1 WHERE record_id IN ('r-C-1', 'r-CT-1')`;
      const read = yield* draftWakeText(orgId, made!);
      assert.strictEqual(read?.text, DRAFT_CALL_NOTES("Meera", true));
      assert.notProperty(read?.data ?? {}, "client");
      assert.notProperty(read?.data ?? {}, "writeTo");
    }).pipe(Effect.provide(chatLayer)),
  );

  it.effect("the company's switches and the sales agent's owner: who a follow-up wakes for", () =>
    Effect.gen(function* () {
      yield* salesDay;
      const sql = yield* SqlClient.SqlClient;
      // A step of a deal while Deals is off: no wake.
      yield* sql`INSERT INTO kin_company_shell VALUES (${orgId}, '[{"id":"deals","on":false}]', 1,
          ${owner}, 0)`;
      yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in, created_at)
        VALUES (${orgId}, 'deals', 'deals', 'DL', 1, 0)`;
      yield* insert({ id: "DL-1", list: "deals", partyId: "r-C-1" });
      yield* sql`INSERT INTO kin_record_links (org_id, record_id, kind, target, relation,
          created_at)
        VALUES (${orgId}, 'r-W-30', 'record', 'r-DL-1', 'relates', 0)`;
      // The owner's own follow-up wakes it too, in his chat with it.
      yield* sql`UPDATE kin_people SET access = 'owner' WHERE person_id = ${owner}`;
      yield* insert({
        id: "W-31",
        dueAt: B + 2 * DAY,
        ownerKind: "person",
        ownerId: owner,
        partyId: "r-C-1",
      });
      yield* TestClock.setTime(NOON_LA);
      const ticked = yield* KinPulse.tick(orgId, NOON_LA);
      assert.deepStrictEqual(
        ticked.drafted.map((one) => one.personId),
        [owner],
      );
    }).pipe(Effect.provide(chatLayer)),
  );

  it.effect(
    "who drafts a follow-up: its project's agent lead, else the seat that sells, else the company's",
    () =>
      Effect.gen(function* () {
        yield* salesDay;
        yield* matesDocs;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO kin_lead_access (org_id, agent_id, person_id, granted_by, granted_at)
          VALUES (${orgId}, ${finance}, ${mate}, ${owner}, 0)`;
        // W-32 is in a project Finance leads; W-33 has no client at all.
        yield* insert({ id: "P-6", list: "projects", ownerKind: "agent", ownerId: finance });
        yield* insert({
          id: "W-32",
          dueAt: B + 2 * DAY,
          ownerKind: "person",
          ownerId: mate,
          partyId: "r-C-1",
          projectId: "P-6",
        });
        yield* insert({ id: "W-33", dueAt: B + 2 * DAY, ownerKind: "person", ownerId: mate });
        const drafters = Effect.map(draftEvents, (events) =>
          events.map((event) => [event.factKeys[0]!.split(":")[1], event.agentId]),
        );
        yield* TestClock.setTime(NOON_LA);
        yield* KinPulse.tick(orgId, NOON_LA);
        assert.sameDeepMembers(yield* drafters, [
          ["W-30", growth],
          ["W-32", finance],
          ["W-33", chief],
        ]);
        // A company with no seat that sells: its own lead drafts the follow-up to a client.
        yield* sql`UPDATE kin_agents SET retired_at = 1 WHERE agent_id = ${growth}`;
        yield* TestClock.setTime(NOON_LA + DAY);
        yield* KinPulse.tick(orgId, NOON_LA + DAY);
        assert.deepInclude((yield* drafters).slice(3), ["W-30", chief]);
      }).pipe(Effect.provide(chatLayer)),
  );

  it.effect(
    "a follow-up's drafter is one she may message now and that runs; unreachable work takes no room",
    () =>
      Effect.gen(function* () {
        yield* salesDay;
        yield* matesDocs;
        const sql = yield* SqlClient.SqlClient;
        const lateOf = (id: string) => `task_late:${id}:due=${B + 2 * DAY}`;
        const agentFor = (id: string) =>
          Effect.map(draftEvents, (events) =>
            events.filter((event) => event.factKeys[0] === lateOf(id)).map((e) => e.agentId),
          );
        // She has used her chat with Growth, then was restricted from it: Growth gets no wake.
        yield* TestClock.setTime(NOON_LA);
        yield* KinPulse.tick(orgId, NOON_LA);
        assert.deepStrictEqual(yield* agentFor("W-30"), [growth]);
        const [first] = yield* draftEvents;
        const restricted = yield* Reach.setLimit({
          orgId,
          by: owner,
          a: Reach.person(mate),
          b: Reach.agent(growth),
          restricted: true,
        });
        assert.strictEqual(restricted._tag, "changed");
        // Its queued wake brings none of her task's words to Growth.
        assert.isUndefined(yield* draftWakeText(orgId, first!));
        yield* TestClock.setTime(NOON_LA + DAY);
        yield* KinPulse.tick(orgId, NOON_LA + DAY);
        assert.deepStrictEqual(yield* agentFor("W-30"), [growth, chief]);
        // A paused lead runs nothing: its project's task goes to the company's lead.
        yield* insert({ id: "P-6", list: "projects", ownerKind: "agent", ownerId: finance });
        yield* insert({
          id: "W-33",
          dueAt: B + 2 * DAY,
          ownerKind: "person",
          ownerId: mate,
          projectId: "P-6",
        });
        yield* sql`INSERT INTO kin_lead_access (org_id, agent_id, person_id, granted_by, granted_at)
          VALUES (${orgId}, ${finance}, ${mate}, ${owner}, 0)`;
        yield* sql`UPDATE kin_agents SET paused_at = 1 WHERE agent_id = ${finance}`;
        yield* TestClock.setTime(NOON_LA + 2 * DAY);
        yield* KinPulse.tick(orgId, NOON_LA + 2 * DAY);
        assert.deepStrictEqual(yield* agentFor("W-33"), [chief]);
        // Twenty tasks nobody she may message can draft leave room for the one Finance can.
        yield* sql`UPDATE kin_agents SET paused_at = NULL WHERE agent_id = ${finance}`;
        yield* sql`UPDATE kin_records SET state = 'done' WHERE record_id IN ('r-W-30', 'r-W-33')`;
        yield* insert({ id: "P-7", list: "projects", ownerKind: "agent", ownerId: growth });
        for (let n = 50; n < 70; n++)
          yield* insert({
            id: `W-${n}`,
            dueAt: B + 2 * DAY,
            ownerKind: "person",
            ownerId: mate,
            projectId: "P-7",
          });
        yield* Reach.setLimit({
          orgId,
          by: owner,
          a: Reach.person(mate),
          b: Reach.agent(chief),
          restricted: true,
        });
        yield* insert({
          id: "W-70",
          dueAt: B + 2 * DAY,
          ownerKind: "person",
          ownerId: mate,
          projectId: "P-6",
        });
        yield* TestClock.setTime(NOON_LA + 3 * DAY);
        const later = yield* KinPulse.tick(orgId, NOON_LA + 3 * DAY);
        assert.deepStrictEqual(later.drafted, [{ personId: mate, key: lateOf("W-70") }]);
        assert.deepStrictEqual(yield* agentFor("W-70"), [finance]);
      }).pipe(Effect.provide(chatLayer)),
  );

  it.effect("a follow-up to a client needs her Clients place on, whatever her access reads", () =>
    Effect.gen(function* () {
      yield* salesDay;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE kin_people SET sees_clients = 0, access = NULL WHERE person_id = ${mate}`;
      yield* TestClock.setTime(NOON_LA);
      assert.lengthOf((yield* KinPulse.tick(orgId, NOON_LA)).drafted, 0);
    }).pipe(Effect.provide(chatLayer)),
  );

  it.effect("a route that changes while its wake is held loses no tick and drafts once", () =>
    Effect.gen(function* () {
      yield* salesDay;
      const sql = yield* SqlClient.SqlClient;
      // W-32's project is Finance's, and Meera is asleep: its wake waits for her morning.
      yield* insert({ id: "P-6", list: "projects", ownerKind: "agent", ownerId: finance });
      yield* insert({
        id: "W-32",
        dueAt: B + 2 * DAY,
        ownerKind: "person",
        ownerId: mate,
        partyId: "r-C-1",
        projectId: "P-6",
      });
      yield* sql`UPDATE kin_records SET state = 'done' WHERE record_id = 'r-W-30'`;
      yield* sql`UPDATE kin_people SET quiet_hours_json = '{"from":"11:00","to":"13:00"}'
        WHERE person_id = ${mate}`;
      const w32 = Effect.map(draftEvents, (events) =>
        events.filter((event) => event.factKeys[0]!.startsWith("task_late:W-32:")),
      );
      yield* TestClock.setTime(NOON_LA);
      yield* KinPulse.tick(orgId, NOON_LA);
      const [held] = yield* w32;
      assert.strictEqual(held?.agentId, finance);
      // The project goes to the Chief of staff before it runs; an unrelated task falls late.
      yield* sql`UPDATE kin_records SET owner_id = ${chief} WHERE record_id = 'r-P-6'`;
      yield* insert({ id: "W-41", dueAt: B + 2 * DAY });
      yield* TestClock.setTime(NOON_LA + MINUTE);
      yield* KinPulse.tick(orgId, NOON_LA + MINUTE);
      const stored = yield* sql`SELECT 1 FROM kin_pulse_facts
        WHERE org_id = ${orgId} AND fact_key LIKE 'task_late:W-41:%'`;
      assert.lengthOf(stored, 1);
      assert.lengthOf(yield* w32, 1);
      // Claimed after her quiet hours, Finance may no longer draft it: dropped, its slot freed.
      yield* sql`UPDATE kin_people SET quiet_hours_json = NULL WHERE person_id = ${mate}`;
      assert.isTrue(yield* draftWakeGone(orgId, held!));
      yield* TestClock.setTime(NOON_LA + 2 * MINUTE);
      yield* KinPulse.tick(orgId, NOON_LA + 2 * MINUTE);
      yield* TestClock.setTime(NOON_LA + 3 * MINUTE);
      yield* KinPulse.tick(orgId, NOON_LA + 3 * MINUTE);
      assert.deepStrictEqual(
        (yield* w32).map((event) => event.agentId),
        [finance, chief],
      );
      const [rerouted] = (yield* w32).slice(1);
      assert.isFalse(yield* draftWakeGone(orgId, rerouted!));
    }).pipe(Effect.provide(chatLayer)),
  );

  it.effect("a due task with no client gets a document head start, and none once one exists", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* letMate;
      const sql = yield* SqlClient.SqlClient;
      const at = B + 3 * DAY + 12 * HOUR;
      yield* TestClock.setTime(at);
      const late = `task_late:W-8:due=${B + 2 * DAY}`;
      // Without Docs she could open no doc, so none is started for her.
      assert.notDeepInclude((yield* KinPulse.tick(orgId, at)).drafted, {
        personId: mate,
        key: late,
      });
      yield* matesDocs;
      assert.deepInclude((yield* KinPulse.tick(orgId, at + MINUTE)).drafted, {
        personId: mate,
        key: late,
      });
      const [made] = (yield* draftEvents).filter((event) => event.factKeys[0] === late);
      assert.strictEqual(made?.agentId, chief);
      const read = yield* draftWakeText(orgId, made!);
      assert.strictEqual(read?.text, DRAFT_DOCUMENT("Meera"));
      assert.deepStrictEqual(read?.data, { task: "W-8", title: "Invented W-8", late: true });
      // A doc linked to it that she can't open is no first piece of hers: the next day still wakes.
      yield* insert({ id: "D-9", list: "docs", createdAt: at });
      yield* sql`INSERT INTO kin_record_links (org_id, record_id, kind, target, relation,
          created_at)
        VALUES (${orgId}, 'r-D-9', 'record', 'r-W-8', 'relates', ${at + HOUR})`;
      yield* TestClock.setTime(at + DAY);
      assert.deepInclude((yield* KinPulse.tick(orgId, at + DAY)).drafted, {
        personId: mate,
        key: late,
      });
      // Shared with the team, she opens it: it is the first piece, and the next day adds nothing.
      yield* sql`UPDATE kin_records SET team_shared = 1 WHERE record_id = 'r-D-9'`;
      yield* TestClock.setTime(at + 2 * DAY);
      assert.notDeepInclude((yield* KinPulse.tick(orgId, at + 2 * DAY)).drafted, {
        personId: mate,
        key: late,
      });
      assert.isUndefined(yield* draftWakeText(orgId, { ...made!, eventId: KinEventId.make("d2") }));
      // A doc linked before it fell due is no head start: the next day it is made.
      yield* sql`UPDATE kin_record_links SET created_at = ${B} WHERE record_id = 'r-D-9'`;
      yield* TestClock.setTime(at + 3 * DAY);
      assert.deepInclude((yield* KinPulse.tick(orgId, at + 3 * DAY)).drafted, {
        personId: mate,
        key: late,
      });
    }).pipe(Effect.provide(chatLayer)),
  );

  it.effect("a client meeting coming up gets its holder a prep note, from what she sees", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* letMate;
      yield* matesDocs;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE kin_people SET access = 'owner' WHERE person_id = ${owner}`;
      yield* sql`UPDATE kin_people SET sees_clients = 1 WHERE person_id = ${mate}`;
      const at = B + 4 * DAY + 6 * HOUR;
      const meeting = (id: string, ownerId: string, dateAt: number, partyId?: string) =>
        insert({
          id,
          title: `Pilot review ${id}`,
          category: "meeting",
          ownerKind: "person",
          ownerId,
          dateAt,
          ...(partyId === undefined ? {} : { partyId }),
          fields: JSON.stringify({ attendees: [`person:${ownerId}`] }),
        });
      // Hers with Lumen tomorrow; W-14 (seeded) has no client; W-46 is in an hour; W-44 is his.
      yield* meeting("W-40", mate, B + 5 * DAY + 3 * HOUR, "r-C-1");
      yield* meeting("W-46", mate, at + HOUR, "r-C-2");
      yield* meeting("W-44", owner, B + 5 * DAY + 5 * HOUR, "r-C-1");
      yield* insert({
        id: "W-41",
        title: "Revised quote",
        ownerKind: "person",
        ownerId: owner,
        partyId: "r-C-1",
        dueAt: B + 6 * DAY,
        teamShared: 1,
      });
      yield* insert({
        id: "W-42",
        title: "Signed SOW",
        side: "theirs",
        ownerKind: "person",
        ownerId: mate,
        partyId: "r-C-1",
        dueAt: B + 2 * DAY,
      });
      yield* insert({
        id: "W-43",
        title: "Margin review",
        ownerKind: "person",
        ownerId: owner,
        partyId: "r-C-1",
        dueAt: B + 6 * DAY,
      });
      yield* insert({
        id: "INV-9",
        list: "invoices",
        state: "waiting",
        amount: 1_200_00,
        dueAt: B + DAY,
        partyId: "r-C-1",
      });
      yield* TestClock.setTime(at);
      const preps = (yield* KinPulse.tick(orgId, at)).drafted.filter((one) =>
        one.key.startsWith("meeting_soon:"),
      );
      assert.sameDeepMembers(preps, [
        { personId: owner, key: `meeting_soon:W-44:at=${B + 5 * DAY + 5 * HOUR}` },
        { personId: mate, key: `meeting_soon:W-40:at=${B + 5 * DAY + 3 * HOUR}` },
      ]);
      const events = yield* draftEvents;
      const hers = events.find((one) => one.factKeys[0]!.startsWith("meeting_soon:W-40"))!;
      const read = yield* draftWakeText(orgId, hers);
      assert.strictEqual(read?.text, DRAFT_MEETING_PREP("Meera"));
      // Only what she sees, and no money.
      assert.deepStrictEqual(read?.data, {
        meeting: "W-40",
        title: "Pilot review W-40",
        at: "Fri 6 Nov, 03:00",
        attendees: ["Meera"],
        client: "Lumen",
        open: [
          { key: "W-42", title: "Signed SOW", holder: "Meera", due: "2026-11-03", side: "theirs" },
          { key: "W-41", title: "Revised quote", holder: "Arjun", due: "2026-11-07", side: "ours" },
        ],
        lastContacts: [],
      });
      // His, at owner level: the client's overdue invoices as a count and a total.
      const his = events.find((one) => one.factKeys[0]!.startsWith("meeting_soon:W-44"))!;
      const owners = yield* draftWakeText(orgId, his);
      assert.deepInclude(owners?.data, {
        // The seed's own overdue Lumen invoice and this one.
        overdueInvoices: {
          count: 2,
          total: formatMoneyPlain({ minor: 21_200_00, currency: "INR" }),
        },
      });
      const ownersOpen =
        owners === undefined ? [] : (owners.data as { open: ReadonlyArray<{ key: string }> }).open;
      assert.includeMembers(
        ownersOpen.map((one) => one.key),
        ["W-42", "W-41", "W-43"],
      );
      // Its turn's one doc is filed for her and linked to the meeting.
      yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, model,
          started_at, status, event_ids)
        VALUES ('w-prep', ${orgId}, ${hers.agentId}, 't-prep', 'test', 0, 'running', '[]')`;
      yield* sql`UPDATE kin_events SET wakeup_id = 'w-prep' WHERE event_id = ${hers.eventId}`;
      assert.deepStrictEqual(yield* docHeadStart(orgId, hers.agentId, "w-prep"), {
        personId: mate,
        recordId: "r-W-40",
        key: "W-40",
      });
      // A doc she opens, linked to it since: the note is made, and the wake writes nothing more.
      yield* insert({ id: "D-9", list: "docs", createdAt: at, teamShared: 1 });
      yield* sql`INSERT INTO kin_record_links (org_id, record_id, kind, target, relation,
          created_at)
        VALUES (${orgId}, 'r-D-9', 'record', 'r-W-40', 'relates', ${at + MINUTE})`;
      assert.isUndefined(yield* draftWakeText(orgId, hers));
    }).pipe(Effect.provide(chatLayer)),
  );

  it.effect(
    "a doc head start that makes nothing is tried three days, then waits for the task to change",
    () =>
      Effect.gen(function* () {
        yield* seed;
        yield* letMate;
        yield* matesDocs;
        const sql = yield* SqlClient.SqlClient;
        const at = B + 3 * DAY + 12 * HOUR;
        const late = { personId: mate, key: `task_late:W-8:due=${B + 2 * DAY}` };
        const day = (n: number) =>
          Effect.gen(function* () {
            yield* TestClock.setTime(at + n * DAY);
            return (yield* KinPulse.tick(orgId, at + n * DAY)).drafted;
          });
        for (const n of [0, 1, 2]) assert.deepInclude(yield* day(n), late);
        assert.notDeepInclude(yield* day(3), late);
        assert.notDeepInclude(yield* day(4), late);
        // Its notes change: it is worth trying again.
        yield* sql`INSERT INTO kin_record_changes (org_id, record_id, rev, at, actor_kind, actor_id,
          via, kind, fields_json)
        VALUES (${orgId}, 'r-W-8', 2, ${at + 4 * DAY + HOUR}, 'person', ${mate}, 'owner', 'updated',
          '[{"field":"notes","from":"","to":"Zoya and Arjun start Monday"}]')`;
        assert.deepInclude(yield* day(5), late);
      }).pipe(Effect.provide(chatLayer)),
  );

  it.effect("with Clients off for the company, no follow-up wakes anyone", () =>
    Effect.gen(function* () {
      yield* salesDay;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO kin_company_shell VALUES (${orgId}, '[{"id":"clients","on":false}]',
          1, ${owner}, 0)`;
      yield* TestClock.setTime(NOON_LA);
      assert.lengthOf((yield* KinPulse.tick(orgId, NOON_LA)).drafted, 0);
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

  it.effect(
    "an away teammate is told when back, and again in a new band; a removed one never",
    () =>
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
        assert.deepStrictEqual(yield* mateNotices, [
          "W-8 Invented W-8 was due yesterday.",
          "W-8 Invented W-8 was due 3 days ago. Still open since 2026-11-03.",
        ]);

        // Removed: a new late task of theirs reaches no one, by notice or by wake.
        yield* sql`UPDATE kin_people SET removed_at = ${back} WHERE person_id = ${mate}`;
        yield* insert({ id: "W-23", dueAt: B + 4 * DAY, ownerKind: "person", ownerId: mate });
        const removed = yield* KinPulse.tick(orgId, back + HOUR);
        assert.isFalse(removed.told.some((one) => one.key.startsWith("task_late:W-23:")));
        assert.lengthOf(yield* mateNotices, 2);
      }).pipe(Effect.provide(chatLayer)),
  );

  it.effect("a held notice whose facts all settled overnight is never posted", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* letMate;
      const sql = yield* SqlClient.SqlClient;
      const chats = yield* KinChatService;
      const at = B + 3 * DAY + 12 * HOUR;
      yield* TestClock.setTime(at);
      yield* sql`UPDATE kin_people SET away_until = '2026-11-06' WHERE person_id = ${mate}`;
      yield* KinPulse.tick(orgId, at);
      // The held notice keeps which facts it tells, by key.
      const [held] = yield* sql<{ kind: string }>`SELECT kind FROM kin_held_posts
        WHERE org_id = ${orgId} AND person_id = ${mate} AND delivered_at IS NULL`;
      assert.deepStrictEqual(yield* sql`SELECT key FROM kin_push_about WHERE ref = ${held!.kind}`, [
        { key: `fact:task_late:W-8:due=${B + 2 * DAY}` },
      ]);
      // W-8 is done while she is away: its fact clears, and the notice has nothing left to say.
      yield* sql`UPDATE kin_records SET state = 'done' WHERE record_id = 'r-W-8'`;
      yield* KinPulse.tick(orgId, at + HOUR);
      const back = B + 5 * DAY + 12 * HOUR;
      yield* TestClock.setTime(back);
      yield* deliverHeld(orgId, chats);
      assert.deepStrictEqual(yield* mateNotices, []);
      assert.lengthOf(
        yield* sql`SELECT 1 FROM kin_held_posts WHERE org_id = ${orgId} AND person_id = ${mate}`,
        0,
      );
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
      // A handling running out moves it too: the invoice counts again on screens. Budgets and a
      // goals' pace are sensed as of now, so they would move every tick.
      yield* sql`DELETE FROM kin_money_budgets WHERE org_id = ${orgId}`;
      yield* sql`UPDATE kin_records SET state = 'done' WHERE org_id = ${orgId} AND key LIKE 'G-%'`;
      const fact = keyed((yield* read(at)).facts, "invoice_overdue", "INV-1")[0]!;
      yield* KinPulse.handle({
        orgId,
        at,
        viewer: { _tag: "owner" },
        by: { _tag: "agent", agentId: finance },
        factKey: fact.key,
        action: "got_it",
        until: at + 2 * MINUTE,
      });
      yield* observed(KinPulse.tick(orgId, at + MINUTE));
      touched.length = 0;
      yield* observed(KinPulse.tick(orgId, at + 2 * MINUTE));
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
      // No turn is given a fact in hand, a check-in's included.
      const shown = (when: number, checkIn: ReadonlySet<string> | undefined) =>
        buildPulseSection({ orgId, agentId: chief, now: when, wokeFor: [], checkIn }).pipe(
          Effect.map((section) =>
            section?.byProject.flatMap((group) => group.facts).find((one) => one.key === fact.key),
          ),
        );
      assert.isUndefined(yield* shown(at, undefined));
      assert.isUndefined(yield* shown(at, new Set([fact.key])));
      assert.include(yield* shown(at + DAY, new Set([fact.key])), {
        sentIn: "no mail with it on record",
      });
      assert.strictEqual(yield* open(at + DAY - MINUTE), 0);
      assert.strictEqual(yield* open(at + DAY), 1);
      yield* handle("got_it");
      assert.strictEqual(yield* open(at + KinPulse.GOT_IT_MS - MINUTE), 0);
      assert.strictEqual(yield* open(at + KinPulse.GOT_IT_MS), 1);
      // Still owed, it is not a problem only until the next chase is due, then counts again.
      const chase = fact.measure!.threshold * DAY;
      yield* handle("not_a_problem");
      assert.strictEqual(yield* open(at + chase - MINUTE), 0);
      assert.strictEqual(yield* open(at + chase), 1);
      yield* handle("undo");
      assert.strictEqual(yield* open(at), 1);
    }).pipe(Effect.provide(layer)),
  );

  // Run of two weeks: 8 of 9 unprompted messages only reminded, as the turn didn't say who to
  // write to, from which account, or which file to attach.
  it.effect(
    "a client set aside holds its invoice across a new key and its tasks; an invoice, only itself",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const at = B + 12 * DAY;
        const open = (when = at) =>
          KinPulse.read({ orgId, at: when, viewer: { _tag: "owner" } }).pipe(
            Effect.map((result) => result.facts.map((fact) => fact.subject.key)),
          );
        assert.includeMembers(yield* open(), ["INV-5", "W-10", "INV-1"]);
        const company = { _tag: "may" as const, forPersonId: null, onWordOf: owner };
        const aside = (recordKey: string, action: "set" | "lift", until: number | null = null) =>
          KinPulse.aside({
            orgId,
            at,
            viewer: { _tag: "owner" },
            by: { _tag: "agent", agentId: finance },
            recordKey,
            action,
            until,
            note: action === "set" ? "Invented: paying in two weeks" : null,
            holding: company,
          });
        const held = yield* aside("C-1", "set", B + 40 * DAY);
        assert.include(held, { covers: "all", mine: false, liftable: true, onWordOf: owner });
        const shown = yield* open();
        assert.notIncludeMembers(shown, ["INV-5", "W-10", "C-1"]);
        assert.include(shown, "INV-1");
        // Asked about, the held fact says so, and the read lists the hold once.
        const all = yield* read(at);
        assert.strictEqual(
          keyed(all.facts, "invoice_overdue", "INV-5")[0]?.aside?.record.key,
          "C-1",
        );
        assert.deepStrictEqual(
          all.setAside?.map((one) => one.record.key),
          ["C-1"],
        );
        // A new due date is a new fact key, and still held.
        yield* sql`UPDATE kin_records SET due_at = ${B + 3 * DAY} WHERE record_id = 'r-INV-5'`;
        assert.notInclude(yield* open(), "INV-5");
        // Nothing held wakes anyone.
        yield* KinPulse.tick(orgId, at);
        const woke = yield* sql<{ json: string }>`SELECT json FROM kin_events WHERE tag = 'pulse'
          ORDER BY event_id`;
        assert.isFalse(woke.some((event) => event.json.includes("INV-5")));
        assert.isTrue(woke.some((event) => event.json.includes("INV-1")));
        // Lifted, and only the invoice set aside: its client's task is back, the invoice not.
        assert.isNull(yield* aside("C-1", "lift"));
        // Told first since the hold ended: the reading agent's own owner is "the owner".
        const task = (yield* read(at)).facts.find((fact) => fact.subject.key === "W-10")!;
        const ended = () =>
          buildPulseSection({
            orgId,
            agentId: chief,
            now: at,
            wokeFor: [],
            checkIn: new Set([task.key]),
            checkInEvents: [],
          }).pipe(
            Effect.map(
              (section) => section?.byProject.flatMap((group) => group.facts)[0]?.setAsideEnded,
            ),
          );
        assert.match(
          (yield* ended()) ?? "",
          /^set aside by fin \(fin\) on the owner's word on \S+ until \S+; lifted by fin \(fin\) on \S+$/,
        );
        yield* sql`UPDATE kin_holds SET on_word_of = ${mate}, lifted_by_kind = 'person',
          lifted_by_id = ${owner} WHERE org_id = ${orgId}`;
        assert.match(
          (yield* ended()) ?? "",
          /^set aside by fin \(fin\) on Meera's word on \S+ until \S+; lifted by the owner on \S+$/,
        );
        yield* aside("INV-5", "set");
        const after = yield* open();
        assert.include(after, "W-10");
        assert.notInclude(after, "INV-5");
        assert.include(keyed((yield* read(at)).facts, "invoice_overdue", "INV-5")[0]?.aside ?? {}, {
          covers: "only",
          until: null,
        });
      }).pipe(Effect.provide(layer)),
  );

  it.effect("a record with no fact yet can be set aside; a teammate's hold is theirs alone", () =>
    Effect.gen(function* () {
      yield* seed;
      const at = B + 12 * DAY;
      // INV-1 is not overdue yet on the 1st: set aside then, its fact is born held.
      yield* KinPulse.aside({
        orgId,
        at: B,
        viewer: { _tag: "owner" },
        by: { _tag: "person", personId: owner },
        recordKey: "INV-1",
        action: "set",
        until: B + 20 * DAY,
        note: null,
        holding: { _tag: "may", forPersonId: null, onWordOf: null },
      });
      const keys = (when: number, viewer: KinPulse.Viewer = { _tag: "owner" }) =>
        KinPulse.read({ orgId, at: when, viewer }).pipe(
          Effect.map((result) => result.facts.map((fact) => fact.subject.key)),
        );
      assert.notInclude(yield* keys(at), "INV-1");
      assert.include(yield* keys(B + 20 * DAY), "INV-1");
      // Meera sets her own late task aside: hidden for her, not for the owner.
      const meera = { _tag: "people" as const, people: [mate] };
      const hers = yield* KinPulse.aside({
        orgId,
        at,
        viewer: meera,
        by: { _tag: "person", personId: mate },
        recordKey: "W-8",
        action: "set",
        until: null,
        note: null,
        holding: { _tag: "may", forPersonId: mate, onWordOf: null },
      });
      assert.include(hers, { mine: true, liftable: true });
      assert.notInclude(yield* keys(at, meera), "W-8");
      assert.include(yield* keys(at), "W-8");
      assert.deepStrictEqual(
        (yield* read(at)).setAside?.map((one) => one.record.key),
        ["INV-1"],
      );
      // The company's hold on W-9 hides it from her too, and she can't lift it.
      yield* KinPulse.aside({
        orgId,
        at,
        viewer: { _tag: "owner" },
        by: { _tag: "person", personId: owner },
        recordKey: "W-9",
        action: "set",
        until: null,
        note: null,
        holding: { _tag: "may", forPersonId: null, onWordOf: null },
      });
      assert.notInclude(yield* keys(at, meera), "W-9");
      const w9 = keyed((yield* read(at, meera)).facts, "task_late", "W-9")[0]!;
      assert.include(w9.aside ?? {}, { mine: false, liftable: false });
      const undone = yield* Effect.flip(
        KinPulse.handle({
          orgId,
          at,
          viewer: meera,
          by: { _tag: "person", personId: mate },
          factKey: w9.key,
          action: "undo",
          holding: { _tag: "may", forPersonId: mate, onWordOf: null },
        }),
      );
      assert.include(undone, { reason: "not_allowed" });
      // An agent with no person's word in its turn changes nothing.
      const refused = yield* Effect.flip(
        KinPulse.aside({
          orgId,
          at,
          viewer: { _tag: "owner" },
          by: { _tag: "agent", agentId: chief },
          recordKey: "W-9",
          action: "lift",
          until: null,
          note: null,
          holding: { _tag: "refused", message: "Only a person can." },
        }),
      );
      assert.strictEqual(refused.message, "Only a person can.");
      assert.notInclude(yield* keys(at), "W-9");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("an agent holds on a person's own word in its turn, beside Kin's own events only", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const event = (id: string, wakeupId: string, tag: string, json: Record<string, unknown>) =>
        sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json, received_at,
            queued_at, state, wakeup_id)
          VALUES (${id}, ${orgId}, ${chief}, ${tag}, 'P0', ${JSON.stringify(json)}, 0, 0,
            'claimed', ${wakeupId})`;
      const message = (id: string, person: KinPersonId, seq: number, kind = "text") =>
        sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind,
            author_person_id, author_member_id, author_role, kind, body, mentions_json, status,
            created_at)
          VALUES (${id}, ${orgId}, ${`chat-${chief}`}, ${seq}, 'human', ${person}, ${`m-${person}`},
            'member', ${kind}, 'Invented: leave it for a month', '[]', 'posted', 0)`;
      const said = (id: string, wakeupId: string, extra: Record<string, unknown> = {}) =>
        event(id, wakeupId, "chat.message", {
          _tag: "chat.message",
          chatId: `chat-${chief}`,
          messageId: id,
          ...extra,
        });
      for (const person of [owner, mate])
        yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind,
            person_id, role, joined_at)
          VALUES (${`m-${person}`}, ${orgId}, ${`chat-${chief}`}, 'person', ${person}, 'member', 0)`;
      for (const wakeupId of [
        "w-owner",
        "w-mate",
        "w-check",
        "w-passed",
        "w-mixed",
        "w-handoff",
        "w-two",
        "w-outside",
        "w-tap",
        "w-mate-check",
        "w-mate-assigned",
      ])
        yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, model,
            started_at, status, event_ids, audience)
          VALUES (${wakeupId}, ${orgId}, ${chief}, 'thread', 'test', 0, 'completed', '[]',
            'owner_only')`;
      yield* message("own", owner, 1);
      yield* said("own", "w-owner");
      yield* message("hers", mate, 2);
      yield* said("hers", "w-mate");
      yield* event("check", "w-check", "pulse", { _tag: "pulse", checkIn: {} });
      yield* message("passed", owner, 3);
      yield* said("passed", "w-passed", { origin: { personId: owner } });
      yield* message("mixed", owner, 4);
      yield* said("mixed", "w-mixed");
      yield* event("mixed-check", "w-mixed", "pulse", { _tag: "pulse", checkIn: {} });
      const human = (person: KinPersonId) => ({
        provenance: { _tag: "human", personId: person, memberId: `m-${person}` },
      });
      yield* message("handoff-own", owner, 5);
      yield* said("handoff-own", "w-handoff");
      yield* message("handoff", owner, 6);
      yield* said("handoff", "w-handoff", {
        origin: { agentId: finance, chatId: `chat-${finance}` },
      });
      yield* message("two-own", owner, 7);
      yield* said("two-own", "w-two");
      yield* message("two-hers", mate, 8);
      yield* said("two-hers", "w-two");
      yield* message("outside", owner, 9);
      yield* said("outside", "w-outside");
      yield* sql`INSERT INTO kin_wakeup_outside_reads (org_id, wakeup_id, read_at, source)
        VALUES (${orgId}, 'w-outside', 0, 'mail')`;
      yield* message("tap", owner, 10, "widget_action");
      yield* event("tap", "w-tap", "widget.action", {
        _tag: "widget.action",
        chatId: `chat-${chief}`,
        messageId: "tap",
        actionId: "hold",
      });
      yield* event("tap-record", "w-tap", "record.changed", {
        _tag: "record.changed",
        reason: "handed_back",
        provenance: { _tag: "system" },
      });
      yield* message("mate-check", mate, 11);
      yield* said("mate-check", "w-mate-check");
      yield* event("mate-check-pulse", "w-mate-check", "pulse", { _tag: "pulse", checkIn: {} });
      yield* message("mate-assigned", mate, 12);
      yield* said("mate-assigned", "w-mate-assigned");
      yield* event("mate-assigned-by-owner", "w-mate-assigned", "record.changed", {
        _tag: "record.changed",
        reason: "assigned",
        ...human(owner),
      });
      const word = (wakeupId: string) => wordOf({ orgId, agentId: chief, wakeupId });
      const ownersWord = { personId: owner, ownerLevel: true };
      assert.deepStrictEqual(yield* word("w-owner"), ownersWord);
      assert.deepStrictEqual(yield* word("w-mate"), { personId: mate, ownerLevel: false });
      assert.isNull(yield* word("w-check"));
      assert.isNull(yield* word("w-passed"));
      // Kin's own check-in or record change beside the person's word leaves it theirs.
      assert.deepStrictEqual(yield* word("w-mixed"), ownersWord);
      assert.deepStrictEqual(yield* word("w-tap"), ownersWord);
      assert.isNull(yield* word("w-handoff"));
      assert.isNull(yield* word("w-two"));
      assert.isNull(yield* word("w-outside"));
      // A teammate's word stays theirs: a hold on it is their own, never the company's.
      assert.deepStrictEqual(yield* word("w-mate-check"), { personId: mate, ownerLevel: false });
      assert.isNull(yield* word("w-mate-assigned"));
    }).pipe(Effect.provide(layer)),
  );

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
      const section = (
        ownAccounts: ReadonlyArray<{ readonly connection: string; readonly account: string }> = [],
      ) =>
        buildPulseSection({
          orgId,
          agentId: finance,
          now: at,
          wokeFor: [],
          checkIn: new Set(keys),
          ownAccounts,
        });
      const rows = (shown: Effect.Success<ReturnType<typeof section>>) =>
        new Map(
          (shown?.byProject ?? []).flatMap((group) => group.facts).map((one) => [one.key, one]),
        );
      yield* sql`UPDATE kin_records SET fields_json = json_set(fields_json, '$.number', 'AM/26-27/001')
        WHERE org_id = ${orgId} AND record_id = 'r-INV-1'`;
      const unnamed = yield* section();
      assert.strictEqual(
        rows(unnamed).get(keys[1]!)?.writeTo,
        "no client on it, so nobody to write to",
      );
      yield* sql`UPDATE kin_records SET fields_json = '{}' WHERE org_id = ${orgId} AND record_id = 'r-K-2'`;
      const nobody = yield* section();
      assert.notProperty(nobody, "mailFrom");
      yield* sql`UPDATE kin_records SET fields_json = '{"email":"anita@lumen.example"}'
        WHERE org_id = ${orgId} AND record_id = 'r-K-2'`;
      yield* sql`UPDATE kin_records SET fields_json = json_set(fields_json,
        '$.billToName', 'Asha Rao', '$.billToEmail', 'asha@example.com')
        WHERE org_id = ${orgId} AND record_id = 'r-INV-1'`;
      const first = yield* section();
      const byKey = rows(first);
      // Named as the owner's screen names it, with the key its tools take; a draft by its key.
      assert.match(byKey.get(keys[1]!)!.about, /^AM\/26-27\/001 \(INV-1\) /);
      assert.match(byKey.get(keys[0]!)!.about, /^INV-5 /);
      assert.deepInclude(byKey.get(keys[0]!), {
        writeTo: { name: "Anita", email: "anita@lumen.example" },
        document: { key: "D-wk-5", file: "INV-5.pdf", draft: true },
      });
      assert.deepInclude(byKey.get(keys[1]!), {
        writeTo: { name: "Asha Rao", email: "asha@example.com" },
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
      yield* insert({ id: "P-81", list: "projects", partyId: "r-C-1" });
      yield* sql`UPDATE kin_records SET project_id = 'r-P-81' WHERE org_id = ${orgId} AND record_id = 'r-INV-1'`;
      const afterProject = yield* section();
      assert.deepStrictEqual(
        rows(afterProject).get(keys[1]!)?.writeTo,
        rows(first).get(keys[1]!)?.writeTo,
      );
      assert.strictEqual(rows(afterProject).get(keys[1]!)?.rule, rows(first).get(keys[1]!)?.rule);
      yield* KinShell.set(orgId, owner, 0, [{ id: "clients", on: false }]);
      const off = yield* section();
      assert.deepStrictEqual(rows(off).get(keys[0]!)?.writeTo, {
        name: "Anita",
        email: "anita@lumen.example",
      });
      const offFacts = (yield* read(at)).facts;
      const oldClient = keyed(offFacts, "invoice_overdue", "INV-5")[0]!;
      assert.strictEqual(oldClient.scope.clientTitle, "Lumen");
      assert.notProperty(oldClient.scope, "clientKey");

      // Money owed goes to the client's billing contact ahead of the first by name.
      yield* contact(orgId, "K-3", "Zara", "zara@lumen.example");
      yield* sql`UPDATE kin_records SET fields_json = json_set(fields_json, '$.billing', 'true')
        WHERE org_id = ${orgId} AND record_id = 'r-K-3'`;
      assert.deepInclude(rows(yield* section()).get(keys[0]!), {
        writeTo: { name: "Zara", email: "zara@lumen.example", billing: true },
      });
      yield* sql`DELETE FROM kin_records WHERE org_id = ${orgId} AND record_id = 'r-K-3'`;

      // No address on file and no mail connected: each fact says so, once, in plain words.
      yield* sql`UPDATE kin_records SET fields_json = '{}' WHERE org_id = ${orgId} AND record_id = 'r-K-2'`;
      yield* sql`UPDATE kin_connections SET removed_at = 1 WHERE org_id = ${orgId}`;
      const bare = yield* section();
      assert.strictEqual(rows(bare).get(keys[0]!)?.writeTo, "Lumen has no contact with an email");
      assert.strictEqual(bare?.mailFrom, "no mail account is connected");
      yield* sql`UPDATE kin_records SET fields_json = '{"email":"anita@lumen.example"}'
        WHERE org_id = ${orgId} AND record_id = 'r-K-2'`;
      assert.strictEqual((yield* section())?.mailFrom, "no mail account is connected");
      // In a turn that may use the owner's own mailboxes, those are where a draft can go from.
      const own = { connection: "conn-own", account: "rhea.home@ambermill.example" };
      assert.deepStrictEqual((yield* section([own]))?.mailFrom, [{ ...own, own: true }]);
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
      assert.match(november!.consequence, /^November's statement isn't in yet/);
      // A second account that is further on: the line names the account still waited on.
      yield* sql`INSERT INTO kin_bank_statements (org_id, statement_id, attachment_id, file_name,
          chat_id, agent_id, wakeup_id, status, review_json, created_at, read_at, applied_at)
        VALUES (${orgId}, 'st-other', 'att-st-other', 'invented.csv', ${`chat-${finance}`},
          ${finance}, 'w-old', 'read', ${JSON.stringify({
            statement: {
              kind: "account",
              bank: "Invented Bank",
              account: "5678",
              currency: "INR",
              from: "2026-10-01",
              to: "2026-11-30",
              rows: [],
            },
          })}, 0, 0, 1)`;
      const [named] = yield* missing(B + 40 * DAY);
      assert.strictEqual(named!.key, "statement_missing:2026-11");
      assert.match(
        named!.consequence,
        /^November's statement for Invented Bank Account ••1234 isn't in yet/,
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("unreadable bank alerts are one changing Money fact until recorded or too old", () =>
    Effect.gen(function* () {
      yield* seed;
      const at = B + 20 * DAY;
      const zone = "America/Los_Angeles";
      yield* TestClock.setTime(at);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE kin_trigger_settings SET time_zone = ${zone} WHERE org_id = ${orgId}`;
      const insertAlert = (id: string, sentAt: number) =>
        sql`INSERT INTO kin_bank_alerts (org_id, alert_id, connection_id, thread_id, sent_at, seen_at, outcome)
          VALUES (${orgId}, ${id}, 'invented-connection', ${id}, ${sentAt}, ${at}, 'unparsed')`;
      const facts = (viewer?: KinPulse.Viewer) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) => read(now, viewer)),
          Effect.map((pulse) =>
            pulse.facts.filter((fact) => fact.sense === "bank_alerts_unreadable"),
          ),
        );
      const advice =
        "Money may have arrived that is not in Bank transactions. Open the mail to see the amount; it can be recorded by hand.";
      assert.isEmpty(yield* facts());
      yield* insertAlert("old", at - 15 * DAY);
      yield* insertAlert("future", at + DAY);
      assert.isEmpty(yield* facts());
      yield* insertAlert("first", at - 3 * DAY);
      const [one, ...others] = yield* facts();
      assert.isEmpty(others);
      assert.equal(one?.subject.title, "1 bank alert could not be read");
      assert.deepInclude(one!, {
        consequence: `Sent Tue 17 Nov. ${advice}`,
        family: "money",
        scope: {},
        sensitive: true,
        wake: "brief",
        actor: { _tag: "agent", agentId: finance },
      });
      assert.isEmpty(yield* facts({ _tag: "people", people: [mate] }));
      assert.isEmpty(screenFacts([one!], undefined));

      yield* insertAlert("second", at - DAY);
      const [two, ...more] = yield* facts();
      assert.isEmpty(more);
      assert.equal(two?.key, one!.key);
      assert.equal(two?.subject.title, "2 bank alerts could not be read");
      assert.equal(two?.consequence, `Sent between Tue 17 Nov and Thu 19 Nov. ${advice}`);
      assert.notEqual(factSig(one!, at, zone), factSig(two!, at, zone));

      const told = { orgId, personId: owner, at, zone };
      yield* markTold({ ...told, eventId: "first-checkin", facts: [one!] });
      yield* markTold({ ...told, at: at + 1, eventId: "next-checkin", facts: [two!] });
      assert.isEmpty(yield* untold({ ...told, anyState: true, facts: [two!] }));
      yield* sql`UPDATE kin_bank_alerts SET outcome = 'recorded'
        WHERE org_id = ${orgId} AND alert_id = 'second'`;
      assert.deepEqual(yield* untold({ ...told, anyState: true, facts: yield* facts() }), [one]);
      yield* sql`UPDATE kin_bank_alerts SET outcome = 'recorded'
        WHERE org_id = ${orgId} AND alert_id IN ('first', 'future')`;
      assert.isEmpty(yield* facts());
      yield* insertAlert("ages-out", at - 14 * DAY);
      assert.lengthOf(yield* facts(), 1);
      yield* TestClock.adjust(1);
      assert.isEmpty(yield* facts());
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "a bank credit that looks like an invoice's payment wakes Finance once, until settled",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const at = B + 10 * DAY;
        yield* ensureBankList(orgId, B);
        yield* insert({ id: "C-9", list: "clients", title: "Harbourline Logistics" });
        const invoice = (id: string, rupees: number, issued: number, number: string) =>
          insert({
            id,
            list: "invoices",
            state: "waiting",
            title: "Invented retainer",
            amount: rupees * 100,
            dateAt: issued,
            dueAt: issued + 30 * DAY,
            partyId: "r-C-9",
            fields: JSON.stringify({ number }),
          });
        const credit = (id: string, rupees: number, day: number, title: string) =>
          insert({
            id,
            list: "bank_transactions",
            title,
            amount: rupees * 100,
            dateAt: B + day * DAY,
            ownerKind: "person",
            ownerId: owner,
            fields: '{"direction":"credit"}',
          });
        const seen = (viewer?: KinPulse.Viewer, when = at) =>
          read(when, viewer).pipe(
            Effect.map((pulse) => pulse.facts.filter((fact) => fact.sense === "payment_seen")),
          );
        const factOf = (bank: string, when = at) =>
          seen(undefined, when).pipe(
            Effect.map((facts) => facts.find((fact) => fact.key === `payment_seen:${bank}`)),
          );
        const wakes = sql<{ agent: string; json: string }>`SELECT agent_id AS agent, json
          FROM kin_events WHERE org_id = ${orgId} AND tag = 'pulse'
            AND dedupe_key LIKE 'payment_seen:%' ORDER BY event_id`;
        // Both credits came in before the invoice was issued, so nothing is told of them yet.
        yield* credit("BNK-1", 95_000, 0, "NEFT CR-HARBOURLINE LOGISTICS-INV/26-27/020");
        yield* credit("BNK-2", 95_000, 8, "NEFT CR-HARBOURLINE LOGISTICS-INV/26-27/020");
        assert.isEmpty(yield* seen());
        // Issued later and dated the 2nd: the credit after that day is told; the one before the
        // invoice's own day is never its payment.
        yield* invoice("INV-20", 95_000, B + DAY, "INV/26-27/020");
        const [fact, ...others] = yield* seen();
        assert.isEmpty(others);
        assert.deepInclude(fact!, {
          key: "payment_seen:BNK-2",
          family: "money",
          subject: {
            kind: "record",
            key: "INV-20",
            title: "Invented retainer",
            recordId: KinRecordId.make("r-INV-20"),
            number: "INV/26-27/020",
          },
          scope: { clientKey: "C-9", clientTitle: "Harbourline Logistics" },
          consequence:
            "BNK-2, ₹95,000 received 9 Nov, looks like this invoice's payment: cites INV/26-27/020. It isn't recorded as paid until the owner confirms.",
          actor: { _tag: "agent", agentId: finance },
          sensitive: true,
          wake: "now",
          handled: null,
        });
        // Only owner-level people hear of it, and only a build that knows the sense shows it.
        assert.isEmpty(yield* seen({ _tag: "people", people: [mate] }));
        assert.isEmpty(screenFacts([fact!], undefined));
        assert.lengthOf(screenFacts([fact!], ["payment_seen"]), 1);

        // Finance wakes once for it, on the pass that finds it; a later pass leaves it be.
        const first = yield* KinPulse.tick(orgId, at);
        assert.include(first.woken, fact!.key);
        const [woke] = yield* wakes;
        assert.strictEqual(woke!.agent, finance);
        assert.deepInclude(JSON.parse(woke!.json), { factKeys: [fact!.key] });
        assert.notInclude((yield* KinPulse.tick(orgId, at + MINUTE)).woken, fact!.key);

        // A second invoice it fits as closely: both are named, about the credit itself with no
        // client, so a client set aside hides neither; and it is the same credit, so no new wake.
        yield* invoice("INV-21", 95_000, B + DAY, "INV/26-27/021");
        yield* sql`UPDATE kin_records SET title = 'NEFT CR-HARBOURLINE LOGISTICS'
          WHERE record_id = 'r-BNK-2'`;
        const both = yield* factOf("BNK-2");
        assert.deepInclude(both!, {
          subject: {
            kind: "record",
            key: "BNK-2",
            title: "Bank credit",
            recordId: KinRecordId.make("r-BNK-2"),
          },
          scope: {},
          consequence:
            "BNK-2, ₹95,000 received 9 Nov, fits 2 open invoices equally, and Kin can't tell which: INV/26-27/020 (INV-20): same amount from Harbourline Logistics; INV/26-27/021 (INV-21): same amount from Harbourline Logistics. Nothing is recorded until the owner says which.",
        });
        assert.notInclude((yield* KinPulse.tick(orgId, at + 2 * MINUTE)).woken, both!.key);
        assert.lengthOf(yield* wakes, 1);
        const asideClient = (action: "set" | "lift") =>
          KinPulse.aside({
            orgId,
            at,
            viewer: { _tag: "owner" },
            by: { _tag: "person", personId: owner },
            recordKey: "C-9",
            action,
            until: null,
            note: null,
            holding: { _tag: "may", forPersonId: null, onWordOf: null },
          });
        yield* asideClient("set");
        assert.isUndefined((yield* factOf("BNK-2"))!.aside);
        yield* asideClient("lift");

        // Two credits that fit one invoice: one fact each, each naming the other.
        yield* sql`UPDATE kin_records SET state = 'dropped' WHERE record_id = 'r-INV-21'`;
        yield* credit("BNK-3", 95_000, 9, "NEFT CR-HARBOURLINE LOGISTICS-INV/26-27/020");
        assert.strictEqual(
          (yield* factOf("BNK-2"))!.consequence,
          "BNK-2, ₹95,000 received 9 Nov, looks like this invoice's payment: same amount from Harbourline Logistics. BNK-3 (₹95,000, 10 Nov) fits this invoice as well. It isn't recorded as paid until the owner confirms.",
        );
        const third = yield* factOf("BNK-3");
        assert.strictEqual(
          third!.consequence,
          "BNK-3, ₹95,000 received 10 Nov, looks like this invoice's payment: cites INV/26-27/020. BNK-2 (₹95,000, 9 Nov) fits this invoice as well. It isn't recorded as paid until the owner confirms.",
        );

        // The owner says it isn't: told no more, and no wake, whatever invoices come later.
        yield* KinPulse.handle({
          orgId,
          at,
          viewer: { _tag: "owner" },
          by: { _tag: "person", personId: owner },
          factKey: third!.key,
          action: "not_a_problem",
        });
        assert.notInclude((yield* KinPulse.tick(orgId, at + 3 * MINUTE)).woken, third!.key);
        yield* invoice("INV-22", 95_000, B + 2 * DAY, "INV/26-27/022");
        assert.isNotNull((yield* factOf("BNK-3", at + 30 * DAY))!.handled);
        assert.notInclude((yield* KinPulse.tick(orgId, at + 4 * MINUTE)).woken, third!.key);
        yield* sql`UPDATE kin_records SET state = 'dropped' WHERE record_id = 'r-INV-22'`;

        // Explained, voided or paid, it is no longer told.
        yield* sql`UPDATE kin_records SET state = 'done' WHERE record_id IN ('r-BNK-2', 'r-BNK-3')`;
        assert.isEmpty(yield* seen());
        yield* sql`UPDATE kin_records SET state = 'open' WHERE record_id IN ('r-BNK-2', 'r-BNK-3')`;
        assert.lengthOf(yield* seen(), 2);
        yield* sql`UPDATE kin_records SET state = 'dropped' WHERE record_id = 'r-INV-20'`;
        assert.isEmpty(yield* seen());
        yield* sql`UPDATE kin_records SET state = 'waiting' WHERE record_id = 'r-INV-20'`;
        yield* sql`INSERT INTO kin_record_payments (org_id, payment_id, record_id, amount_minor,
            currency, paid_on, origin_key, created_at, created_by_kind)
          VALUES (${orgId}, 'pay-20', 'r-INV-20', 95_000_00, 'INR', '2026-11-09', 'pay-20', 0,
            'person')`;
        assert.isEmpty(yield* seen());

        // Two ₹50,000 invoices, one credit: once one of them is marked paid by hand, the credit
        // may be that money, so it is not called the other's payment.
        yield* invoice("INV-30", 50_000, B + DAY, "INV/26-27/030");
        yield* invoice("INV-31", 50_000, B + DAY, "INV/26-27/031");
        yield* credit("BNK-9", 50_000, 9, "NEFT CR-HARBOURLINE LOGISTICS");
        assert.match((yield* factOf("BNK-9"))!.consequence, /fits 2 open invoices equally/);
        yield* sql`INSERT INTO kin_record_payments (org_id, payment_id, record_id, amount_minor,
            currency, paid_on, origin_key, created_at, created_by_kind)
          VALUES (${orgId}, 'pay-30', 'r-INV-30', 50_000_00, 'INR', '2026-11-10', 'pay-30', 0,
            'person')`;
        assert.isUndefined(yield* factOf("BNK-9"));
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "a debit that pays a partner back exactly wakes Finance once; a short one is a line",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const at = B + 25 * DAY;
        yield* ensureBankList(orgId, B);
        // Meera paid three bills from her own card; the company owes her for them.
        const owedTo = JSON.stringify({ fundedBy: `person:${mate}`, reimbursement: "owed" });
        for (const [id, rupees, day] of [
          ["EXP-4", 5_000, 1],
          ["EXP-7", 4_200, 8],
          ["EXP-9", 3_200, 15],
        ] as const)
          yield* insert({
            id,
            list: "expenses",
            state: "done",
            amount: rupees * 100,
            dateAt: B + day * DAY,
            fields: owedTo,
          });
        const debit = (id: string, rupees: number, day: number) =>
          insert({
            id,
            list: "bank_transactions",
            title: "UPI/Meera/reimb",
            amount: rupees * 100,
            dateAt: B + day * DAY,
            ownerKind: "person",
            ownerId: owner,
            fields: '{"direction":"debit"}',
          });
        const seen = (viewer?: KinPulse.Viewer) =>
          read(at, viewer).pipe(
            Effect.map((pulse) => pulse.facts.filter((fact) => fact.sense === "repaid_seen")),
          );
        yield* debit("BNK-9", 12_400, 23);
        yield* debit("BNK-11", 9_000, 24);
        const facts = yield* seen();
        const exact = facts.find((fact) => fact.key === "repaid_seen:BNK-9");
        assert.deepInclude(exact!, {
          family: "money",
          subject: {
            kind: "record",
            key: "BNK-9",
            title: "Bank debit",
            recordId: KinRecordId.make("r-BNK-9"),
          },
          scope: {},
          consequence:
            "BNK-9, ₹12,400 paid 24 Nov, names Meera and adds up exactly to their 3 oldest owed expenses: EXP-4, EXP-7 and EXP-9. They aren't marked repaid until the owner confirms.",
          actor: { _tag: "agent", agentId: finance },
          sensitive: true,
          wake: "now",
          handled: null,
        });
        // One that doesn't add up is told once, as a line: Kin marks nothing and offers no card.
        assert.deepInclude(
          facts.find((fact) => fact.key === "repaid_seen:BNK-11:short")!,
          {
            consequence:
              "BNK-11, ₹9,000 paid 25 Nov, names Meera but doesn't add up to their oldest owed expenses (₹12,400 over 3 expenses), so Kin marks nothing. Mark what it repaid on the expenses in Money.",
            actor: { _tag: "agent", agentId: finance },
            wake: "brief",
          },
        );
        assert.lengthOf(facts, 2);
        // Only owner-level people hear of it, and only a build that knows the sense shows it.
        assert.isEmpty(yield* seen({ _tag: "people", people: [mate] }));
        assert.isEmpty(screenFacts([exact!], undefined));
        assert.lengthOf(screenFacts([exact!], ["repaid_seen"]), 1);

        // Finance wakes once for the exact one, and never for the short one.
        const first = yield* KinPulse.tick(orgId, at);
        assert.include(first.woken, exact!.key);
        assert.notInclude(first.woken, "repaid_seen:BNK-11:short");
        const [woke, ...more] = yield* sql<{ agent: string; json: string }>`SELECT
          agent_id AS agent, json FROM kin_events WHERE org_id = ${orgId} AND tag = 'pulse'
          AND dedupe_key LIKE 'repaid_seen:%' ORDER BY event_id`;
        assert.isEmpty(more);
        assert.strictEqual(woke!.agent, finance);
        assert.deepInclude(JSON.parse(woke!.json), { factKeys: [exact!.key] });
        assert.notInclude((yield* KinPulse.tick(orgId, at + MINUTE)).woken, exact!.key);

        // Explained, it is no longer told.
        yield* sql`UPDATE kin_records SET state = 'done' WHERE record_id IN ('r-BNK-9', 'r-BNK-11')`;
        assert.isEmpty(yield* seen());
      }).pipe(Effect.provide(layer)),
  );

  it.effect("the morning Money section includes an offered unreadable bank alert once", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO kin_bank_alerts (org_id, alert_id, connection_id, thread_id, sent_at, seen_at, outcome)
        VALUES (${orgId}, 'invented-alert', 'invented-connection', 'invented-thread', ${B}, ${B}, 'unparsed')`;
      const title = "1 bank alert could not be read";
      const expected = `${title}. Sent Sun 1 Nov. Money may have arrived that is not in Bank transactions. Open the mail to see the amount; it can be recorded by hand.`;
      const input = { orgId, now: B, viewer: KIN_OWNER_LEVEL };
      const offered = { ...input, offeredFacts: new Set(["bank_alerts_unreadable"]) };
      assert.isEmpty(yield* morningMoneyLines(input));
      assert.deepEqual(yield* morningMoneyLines(offered), [expected]);
      assert.isEmpty(yield* morningMoneyLines({ ...offered, said: title }));
      assert.isEmpty(yield* morningMoneyLines({ ...offered, viewer: viewerOfPeople([mate]) }));
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
      // Once issued, an invoice or quote is named by its number, then the key its tools take.
      yield* sql`UPDATE kin_records SET fields_json = json_set(fields_json, '$.number', 'AM/26-27/001')
        WHERE org_id = ${orgId} AND record_id = 'r-INV-1'`;
      yield* sql`UPDATE kin_records SET fields_json = json_set(fields_json, '$.number', 'Q 2026 7')
        WHERE org_id = ${orgId} AND record_id = 'r-QT-1'`;
      yield* insert({
        id: "INV-9",
        list: "invoices",
        state: "waiting",
        amount: 2_000_00,
        dueAt: at + 2 * DAY,
        fields: '{"number":"AM/26-27/002"}',
      });
      const named = yield* weeklyFigures({ orgId, now: at });
      assert.match(named, /^- AM\/26-27\/001 \(INV-1\):.*unpaid, overdue for \d+ days/m);
      assert.include(named, "Open quotes:\n- Q 2026 7 (QT-1): €600,000.00, sent, no answer yet");
      assert.include(named, "Invoices not yet due:\n- AM/26-27/002 (INV-9): ₹2,000.00 due");
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "the week's Behind is a project off track, less what Overdue and Quiet clients say",
    () =>
      Effect.gen(function* () {
        yield* seed;
        // P-5's task has waited since it was added; P-6's invoice is overdue; P-7's client has had
        // no contact since they were added a month and a half ago.
        yield* insert({ id: "P-5", list: "projects", title: "Invented waiting build" });
        yield* insert({ id: "W-30", state: "waiting", projectId: "P-5" });
        yield* insert({ id: "P-6", list: "projects", title: "Invented billed build" });
        yield* insert({
          id: "INV-9",
          list: "invoices",
          state: "waiting",
          amount: 1_000_00,
          dueAt: B,
          projectId: "P-6",
        });
        yield* insert({ id: "C-5", list: "clients", title: "Invented Quiet Co" });
        yield* insert({
          id: "P-7",
          list: "projects",
          title: "Invented quiet build",
          partyId: "r-C-5",
        });
        const figures = yield* weeklyFigures({ orgId, now: B + 15 * DAY });
        const behind = figures.split("\n\n").find((block) => block.startsWith("Behind:")) ?? "";
        assert.match(behind, /^- P-5 Invented waiting build, 1 open, 1 waiting over a week$/m);
        assert.notMatch(behind, /P-6|P-7|overdue|contact/);
        assert.match(figures, /^Overdue:\n(- .*\n)*- INV-9/m);
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

describe("watched numbers", () => {
  const SOURCE = "Invented analytics";
  const watchedNumber = (id: string, fields: object) =>
    insert({
      id,
      list: "goals",
      ownerId: finance,
      title: id === "G-11" ? "Daily users" : `Invented ${id}`,
      fields: JSON.stringify({ measure: "manual", ...fields }),
    });
  const recordValue = (id: string, day: string, value: string, seq = 1) =>
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) => sql`INSERT INTO kin_number_values (org_id, record_id, as_of, seq, value, agent_id,
          recorder_name, source, created_at)
        VALUES (${orgId}, ${`r-${id}`}, ${day}, ${seq}, ${value}, ${finance}, 'Finance', ${SOURCE}, 0)`,
    );
  const factsOf = (sense: string) =>
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) => sql<{ key: string; cleared: number; woke: number }>`SELECT fact_key AS key,
          cleared_at IS NOT NULL AS cleared, woke_at IS NOT NULL AS woke
        FROM kin_pulse_facts WHERE org_id = ${orgId} AND sense = ${sense} ORDER BY first_seen_at`,
    );
  const offWakes = Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ agent: string; json: string }>`SELECT agent_id AS agent, json FROM kin_events
      WHERE org_id = ${orgId} AND tag = 'pulse'
        AND json LIKE '%"number_off:%'
      ORDER BY received_at, event_id`,
  );
  const noon = (day: number) => Date.UTC(2026, 9, day, 12);

  it.effect(
    "a number outside its limit wakes its keeper once a time, told what to do in the owner's chat",
    () =>
      Effect.gen(function* () {
        yield* seed;
        yield* watchedNumber("G-11", {
          unit: "users",
          below: "1000",
          every: "day",
          source: SOURCE,
        });
        // Three days under the limit: one fact, one wake.
        for (const [day, value] of [
          [29, "950"],
          [30, "930"],
          [31, "920"],
        ] as const) {
          yield* recordValue("G-11", `2026-10-${day}`, value);
          yield* KinPulse.tick(orgId, noon(day + 1));
        }
        const first = "number_off:G-11:below=1000:since=2026-10-29#1";
        assert.deepStrictEqual(yield* factsOf("number_off"), [{ key: first, cleared: 0, woke: 1 }]);
        // Back inside clears it; under again is a new time, and a new wake.
        yield* recordValue("G-11", "2026-11-01", "1100");
        yield* KinPulse.tick(orgId, noon(33));
        yield* recordValue("G-11", "2026-11-02", "980");
        const again = yield* KinPulse.tick(orgId, noon(34));
        const second = "number_off:G-11:below=1000:since=2026-11-02#1";
        assert.includeMembers(again.woken, [second]);
        assert.deepStrictEqual(yield* factsOf("number_off"), [
          { key: first, cleared: 1, woke: 1 },
          { key: second, cleared: 0, woke: 1 },
        ]);
        // Each wake is the keeper's, from Kin with no person's chat: its reply is in its own
        // direct chat with the owner.
        const wakes = yield* offWakes;
        assert.deepStrictEqual(
          wakes.map(({ agent, json }) => {
            const event = JSON.parse(json) as { factKeys: Array<string>; origin?: unknown };
            return { agent, factKeys: event.factKeys, origin: event.origin };
          }),
          [first, second].map((key) => ({ agent: finance, factKeys: [key], origin: undefined })),
        );
        assert.deepStrictEqual(yield* offTurnTexts(orgId, [second], noon(34)), [
          '"Daily users" (G-11) is 980 "users" as of 2026-11-02, below its limit of 1,000 "users". Look at what moved (numbers_read gives the days before), then do the first useful thing yourself: a suggested task, a mail drafted on a Confirm card, or a list entry. Post one line to the owner saying what moved and what you drafted. Don\'t ask a question and don\'t assign anyone.',
        ]);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("a second crossing on the same day, after the first was handled, wakes again", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* watchedNumber("G-11", { below: "1000" });
      yield* recordValue("G-11", "2026-10-30", "900", 1);
      yield* KinPulse.tick(orgId, noon(30));
      // The owner says it is not a problem.
      yield* sql`UPDATE kin_pulse_facts SET handled_by_kind = 'person', handled_by_id = ${owner},
          handled_at = ${noon(30)} WHERE org_id = ${orgId} AND sense = 'number_off'`;
      yield* recordValue("G-11", "2026-10-30", "1100", 2);
      yield* KinPulse.tick(orgId, noon(30) + HOUR);
      yield* recordValue("G-11", "2026-10-30", "800", 3);
      const again = yield* KinPulse.tick(orgId, noon(30) + 2 * HOUR);
      assert.lengthOf(yield* factsOf("number_off"), 2);
      assert.isTrue(again.woken.some((key) => key.startsWith("number_off:G-11:")));
      assert.lengthOf(yield* offWakes, 2);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a queued wake says nothing once its section is off or its episode is over", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* watchedNumber("G-14", { spec: '{"count":"deals","states":["open"]}', below: "5" });
      const queued = (yield* KinPulse.tick(orgId, noon(30))).woken.filter((key) =>
        key.startsWith("number_off:"),
      );
      assert.lengthOf(queued, 1);
      assert.lengthOf(yield* offTurnTexts(orgId, queued, noon(30)), 1);
      // Deals switched off before the turn starts: the wake carries no instruction.
      yield* KinShell.set(orgId, owner, 0, [{ id: "deals", on: false }]);
      assert.deepStrictEqual(yield* offTurnTexts(orgId, queued, noon(30)), []);
      // On again, but the episode was handled meanwhile: still nothing.
      yield* KinShell.set(orgId, owner, 1, [{ id: "deals", on: true }]);
      assert.lengthOf(yield* offTurnTexts(orgId, queued, noon(30)), 1);
      yield* sql`UPDATE kin_pulse_facts SET handled_by_kind = 'person', handled_by_id = ${owner},
          handled_at = ${noon(30)} WHERE org_id = ${orgId} AND fact_key = ${queued[0]!}`;
      assert.deepStrictEqual(yield* offTurnTexts(orgId, queued, noon(30)), []);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a number counted from any list follows that list's section switch", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* watchedNumber("G-15", { spec: '{"count":"clients","states":["open"]}', below: "50" });
      yield* sql`INSERT INTO kin_company_shell VALUES (${orgId}, '[{"id":"clients","on":false}]',
          1, ${owner}, 0)`;
      const off = yield* KinPulse.tick(orgId, noon(30));
      assert.isFalse(off.woken.some((key) => key.startsWith("number_off:")));
      assert.lengthOf(yield* offWakes, 0);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a feed two periods behind tells the owner once, only while it is meant to run", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* watchedNumber("G-12", { every: "day", source: SOURCE });
      yield* watchedNumber("G-13", {});
      yield* recordValue("G-12", "2026-10-28", "12");
      yield* recordValue("G-13", "2026-10-01", "3");
      yield* KinPulse.tick(orgId, noon(30));
      assert.deepStrictEqual(yield* factsOf("number_stale"), [], "one period missed is not stale");
      // Two periods behind with no feed running for its source: nobody is meant to fetch it.
      yield* KinPulse.tick(orgId, noon(31));
      assert.deepStrictEqual(yield* factsOf("number_stale"), []);
      yield* sql`INSERT INTO kin_profile_changes (org_id, change_id, agent_id, wakeup_id,
          patch_json, base_rev, widget_id, proposed_at, applied_at)
        VALUES (${orgId}, 'nw_feed', ${finance}, 'earlier', ${JSON.stringify({
          numbers: [],
          feed: { source: SOURCE, every: "day", at: "08:00" },
          base: "invented",
        })}, 0, NULL, 0, 0)`;
      yield* sql`INSERT INTO kin_schedules (task_id, org_id, schedule_id, agent_id, chat_id,
          source_event, said_by, audience, content_sha256, inbox_thread_id, created_at, updated_at)
        VALUES ('task-feed', ${orgId}, 'feed-invented', ${finance}, ${`chat-${finance}`},
          'kin-numbers:nw_feed', ${owner}, 'owner_only', 'hash', 'inbox', 0, 0)`;
      yield* KinPulse.tick(orgId, noon(31) + HOUR);
      yield* KinPulse.tick(orgId, noon(31) + 2 * HOUR);
      assert.deepStrictEqual(yield* factsOf("number_stale"), [
        { key: "number_stale:G-12:asOf=2026-10-28", cleared: 0, woke: 0 },
      ]);
      const [fact] = (yield* KinPulse.read({
        orgId,
        at: noon(31) + 2 * HOUR,
        viewer: { _tag: "owner" },
      })).facts.filter((one) => one.sense === "number_stale");
      assert.deepInclude(fact, {
        consequence: `No new value since 2026-10-28; it comes from ${SOURCE}.`,
        actor: { _tag: "owner" },
        wake: "sweep",
      });
      // A person paused the feed: no notice.
      yield* sql`UPDATE kin_schedules SET pending_enabled = 0 WHERE task_id = 'task-feed'`;
      yield* KinPulse.tick(orgId, noon(31) + 3 * HOUR);
      assert.deepStrictEqual(
        (yield* factsOf("number_stale")).map((row) => row.cleared),
        [1],
      );
      // Running again, then a newer value clears it.
      yield* sql`UPDATE kin_schedules SET pending_enabled = NULL WHERE task_id = 'task-feed'`;
      yield* KinPulse.tick(orgId, noon(31) + 4 * HOUR);
      assert.deepStrictEqual(
        (yield* factsOf("number_stale")).map((row) => row.cleared),
        [0],
      );
      yield* recordValue("G-12", "2026-10-30", "14");
      yield* KinPulse.tick(orgId, noon(31) + 5 * HOUR);
      assert.deepStrictEqual(yield* factsOf("number_stale"), [
        { key: "number_stale:G-12:asOf=2026-10-28", cleared: 1, woke: 0 },
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a number counted from Deals says nothing while Deals is off, nor once it is on", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* watchedNumber("G-14", { spec: '{"count":"deals","states":["open"]}', below: "5" });
      yield* sql`INSERT INTO kin_company_shell VALUES (${orgId}, '[{"id":"deals","on":false}]',
          1, ${owner}, 0)`;
      const off = yield* KinPulse.tick(orgId, noon(30));
      assert.isFalse(off.woken.some((key) => key.startsWith("number_off:")));
      yield* sql`UPDATE kin_company_shell SET shell_json = '[{"id":"deals","on":true}]', rev = 2`;
      const on = yield* KinPulse.tick(orgId, noon(30) + HOUR);
      assert.isFalse(on.woken.some((key) => key.startsWith("number_off:")));
      assert.lengthOf(yield* offWakes, 0);
      // It was sensed all along, and marked told while Deals was off.
      assert.deepStrictEqual(yield* factsOf("number_off"), [
        { key: "number_off:G-14:below=5:since=2026-10-30#g0", cleared: 0, woke: 1 },
      ]);
    }).pipe(Effect.provide(layer)),
  );
});

describe("list sections", () => {
  /** A company's own list, as `list_define` stores it. */
  const defineList = (id: string, prefix: string, more: object) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const definition = {
        noun: id,
        states: ["open", "doing", "done", "dropped"],
        stateLabels: {},
        defaultState: "open",
        categories: [],
        sensitive: false,
        amount: false,
        currency: "INR",
        ...more,
      };
      yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in,
          created_at, definition_json)
        VALUES (${orgId}, ${id}, ${id}, ${prefix}, 0, 0, ${JSON.stringify(definition)})`;
    });
  const showLists = (rev: number, sections: ReadonlyArray<{ id: string; on: boolean }>) =>
    KinShell.set(orgId, owner, rev - 1, sections);
  const entryFacts = (at: number, viewer?: KinPulse.Viewer) =>
    read(at, viewer).pipe(
      Effect.map(({ facts }) =>
        facts
          .filter((fact) => fact.sense.startsWith("entry_"))
          .map((fact) => ({ key: fact.key, actor: fact.actor, consequence: fact.consequence })),
      ),
    );

  it.effect(
    "a section's late and due entries reach their holder once; off, or no section, nothing",
    () =>
      Effect.gen(function* () {
        yield* seed;
        yield* letMate;
        yield* defineList("bookings", "BK", {
          fields: [{ key: "bookedFor", label: "Booked for", type: "date", sensitive: false }],
          remindOn: "bookedFor",
        });
        yield* defineList("visits", "VIS", { fields: [] });
        // Meera sees the list's shared entries with Money on, as Lists shows them to her.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE kin_people SET sees_money = 1 WHERE person_id = ${mate}`;
        const booking = (id: string, day: string, more: Partial<Entry> = {}) =>
          insert({ id, list: "bookings", fields: JSON.stringify({ bookedFor: day }), ...more });
        yield* booking("BK-1", "2026-11-02", { ownerKind: "person", ownerId: mate, teamShared: 1 });
        yield* booking("BK-2", "2026-11-04");
        yield* booking("BK-3", "2026-11-01", { state: "done" });
        // Its own due day counts only where the list names no date to remind on.
        yield* booking("BK-4", "2026-12-30", { dueAt: B });
        yield* insert({ id: "VIS-1", list: "visits", dueAt: B + DAY });
        const at = B + 3 * DAY + 12 * HOUR;
        yield* TestClock.setTime(at);
        assert.deepStrictEqual(yield* entryFacts(at), []);
        yield* showLists(1, [
          { id: "list:bookings", on: true },
          { id: "list:visits", on: false },
        ]);
        const late = `entry_late:BK-1:due=${B + 2 * DAY - 1}`;
        const soon = `entry_late:BK-2:soon=${B + 4 * DAY - 1}`;
        assert.deepStrictEqual(yield* entryFacts(at), [
          {
            key: late,
            actor: { _tag: "person", personId: mate },
            consequence: "Was due 2026-11-02, 2 days ago.",
          },
          {
            key: soon,
            actor: { _tag: "agent", agentId: chief },
            consequence: "Due 2026-11-04, in 11 hours.",
          },
        ]);
        // The holder sees it on their own screen too.
        assert.deepStrictEqual(
          (yield* entryFacts(at, { _tag: "people", people: [mate] })).map((fact) => fact.key),
          [late],
        );
        const first = yield* KinPulse.tick(orgId, at);
        assert.deepStrictEqual(
          first.told.filter((one) => one.key.startsWith("entry_")),
          [
            { agentId: chief, to: mate, key: late },
            { agentId: chief, to: `agent:${chief}`, key: soon },
          ],
        );
        // In one notice with her late task, by the entry's name and its list's date.
        assert.deepStrictEqual(yield* mateNotices, [
          [
            "2 things need you:",
            "• BK-1 Invented BK-1, was due 2026-11-02, 2 days ago",
            "• W-8 Invented W-8, was due yesterday",
          ].join("\n"),
        ]);
        const again = yield* KinPulse.tick(orgId, at + HOUR);
        assert.lengthOf(
          again.told.filter((one) => one.key.startsWith("entry_")),
          0,
        );
        // Off: nothing is said, and on again nothing old is said either.
        yield* showLists(2, [{ id: "list:bookings", on: false }]);
        yield* booking("BK-5", "2026-11-03", { ownerKind: "person", ownerId: mate, teamShared: 1 });
        assert.deepStrictEqual(yield* entryFacts(at + 2 * HOUR), []);
        const off = yield* KinPulse.tick(orgId, at + 2 * HOUR);
        assert.lengthOf(
          off.told.filter((one) => one.key.startsWith("entry_")),
          0,
        );
        yield* showLists(3, [{ id: "list:bookings", on: true }]);
        const on = yield* KinPulse.tick(orgId, at + 3 * HOUR);
        assert.lengthOf(
          on.told.filter((one) => one.key.startsWith("entry_")),
          0,
        );
        assert.lengthOf(yield* mateNotices, 1);
        assert.include(
          (yield* entryFacts(at + 3 * HOUR)).map((fact) => fact.key),
          `entry_late:BK-5:due=${B + 3 * DAY - 1}`,
        );
        // Still open three days late, it comes back to her as a late task does.
        const aged = yield* KinPulse.tick(orgId, at + 2 * DAY);
        assert.deepInclude(aged.told, { agentId: chief, to: mate, key: late });
        assert.strictEqual(
          (yield* mateNotices).at(-1),
          [
            "2 things need you:",
            "• BK-1 Invented BK-1, was due 2026-11-02, 4 days ago. Still open since 2026-11-02.",
            "• W-8 Invented W-8, was due 3 days ago. Still open since 2026-11-03.",
          ].join("\n"),
        );
      }).pipe(Effect.provide(chatLayer)),
  );

  it.effect(
    "each entry off its list's check is one fact; a fifth that drops later is a fifth",
    () =>
      Effect.gen(function* () {
        yield* seed;
        yield* letMate;
        yield* defineList("stock", "STK", {
          fields: [
            { key: "onHand", label: "On hand", type: "number", sensitive: false },
            { key: "reorderPoint", label: "Reorder point", type: "number", sensitive: false },
          ],
          check: { field: "onHand", below: "reorderPoint" },
        });
        yield* showLists(1, [{ id: "list:stock", on: true }]);
        const item = (id: string, onHand: string, more: Partial<Entry> = {}) =>
          insert({
            id,
            list: "stock",
            fields: JSON.stringify({ onHand, reorderPoint: "10" }),
            ...more,
          });
        for (const [id, onHand] of [
          ["STK-1", "3"],
          ["STK-2", "0"],
          ["STK-3", "9.5"],
          ["STK-4", "-1"],
          ["STK-6", "10"],
          ["STK-7", "40"],
        ] as const)
          yield* item(id, onHand);
        // Held by Meera, who can't see Stock: she is never told of it.
        yield* item("STK-5", "20", { ownerKind: "person", ownerId: mate, teamShared: 1 });
        const at = B + 3 * DAY;
        const checked = (when: number) =>
          entryFacts(when).pipe(Effect.map((facts) => facts.map((fact) => fact.key)));
        const keyOf = (id: string) => `entry_check:${id}:onHand:below=reorderPoint`;
        assert.deepStrictEqual(yield* checked(at), ["STK-1", "STK-2", "STK-3", "STK-4"].map(keyOf));
        assert.strictEqual(
          (yield* entryFacts(at))[0]!.consequence,
          "On hand is 3, below Reorder point (10).",
        );
        const first = yield* KinPulse.tick(orgId, at);
        assert.deepStrictEqual(
          (yield* holderWakes())
            .flatMap((wake) => wake.keys)
            .filter((key) => key.startsWith("entry_")),
          ["STK-1", "STK-2", "STK-3", "STK-4"].map(keyOf),
        );
        assert.deepStrictEqual(
          first.told.filter((one) => one.key.startsWith("entry_")).map((one) => one.to),
          ["STK-1", "STK-2", "STK-3", "STK-4"].map(() => `agent:${chief}`),
        );
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE kin_records SET fields_json = json_set(fields_json, '$.onHand', '2')
        WHERE record_id = 'r-STK-5'`;
        assert.deepStrictEqual(
          yield* checked(at + HOUR),
          ["STK-1", "STK-2", "STK-3", "STK-4", "STK-5"].map(keyOf),
        );
        const fifth = yield* KinPulse.tick(orgId, at + HOUR);
        assert.deepStrictEqual(
          fifth.told.filter((one) => one.key.startsWith("entry_")),
          [],
        );
        assert.deepStrictEqual(yield* mateNotices, []);
        // Back inside: it clears; off again later, it is a new episode, told again.
        yield* sql`UPDATE kin_records SET fields_json = json_set(fields_json, '$.onHand', '50')
        WHERE record_id = 'r-STK-1'`;
        const cleared = yield* KinPulse.tick(orgId, at + 2 * HOUR);
        assert.strictEqual(cleared.cleared, 1);
        yield* sql`UPDATE kin_records SET fields_json = json_set(fields_json, '$.onHand', '1')
        WHERE record_id = 'r-STK-1'`;
        const back = yield* KinPulse.tick(orgId, at + 3 * HOUR);
        assert.deepStrictEqual(
          back.told.filter((one) => one.key.startsWith("entry_")),
          [{ agentId: chief, to: `agent:${chief}`, key: keyOf("STK-1") }],
        );
      }).pipe(Effect.provide(chatLayer)),
  );
});
