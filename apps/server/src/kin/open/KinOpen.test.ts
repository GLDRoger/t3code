// Loaded first: the chat and trigger modules import each other.
import "../chat/KinChatService.ts";
import { assert, it } from "@effect/vitest";
import { KinAgentId, KinOrgId, KinPersonId, type KinOpenRead } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Tracer from "effect/Tracer";

import * as Sqlite from "../../persistence/Sqlite.ts";
import * as KinChatRepository from "../chat/KinChatRepository.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import * as RefreshHub from "../chat/KinRefreshHub.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as KinPulse from "../pulse/KinPulse.ts";
import * as KinRecords from "../work/KinRecords.ts";
import { movePage } from "../work/workMoves.ts";
import * as KinOpen from "./KinOpen.ts";

// Invented company, people, tasks and money only: Ambermill.
const orgId = KinOrgId.make("ambermill");
const rhea = KinPersonId.make("rhea");
const arjun = KinPersonId.make("arjun");
const meera = KinPersonId.make("meera");
const dev = KinPersonId.make("dev");
const zoya = KinPersonId.make("zoya");
const chief = KinAgentId.make("chief");
const finance = KinAgentId.make("finance");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 19, 12);
const stamp = "2026-10-01T00:00:00.000Z";
const isoAt = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const identity = Layer.mock(KinIdentity)({
  owner: { _tag: "person" as const, orgId, personId: rhea },
  isAgentThread: () => false,
  isLeadThread: () => false,
});
const layer = KinRecords.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(KinChatRepository.layer, RefreshHub.layer, identity)),
  Layer.provideMerge(KinEventQueue.layer),
  Layer.provideMerge(KinPersistence.layer),
  Layer.provideMerge(Sqlite.layerMemory),
);

const task = Effect.fn("test.task")(function* (entry: {
  readonly key: string;
  readonly owner: KinPersonId;
  readonly dueAt: number;
  readonly register?: string;
  readonly state?: string;
  readonly sensitive?: number;
  readonly teamShared?: number;
  readonly amount?: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, state, owner_kind,
      owner_id, due_at, amount_minor, currency, sensitive, team_shared, created_by_kind,
      created_by_id, origin_key, created_at, updated_at)
    VALUES (${orgId}, ${`r-${entry.key}`}, ${entry.register ?? "work"}, ${entry.key},
      ${`Invented ${entry.key}`}, ${entry.state ?? "open"}, 'person', ${entry.owner},
      ${entry.dueAt}, ${entry.amount ?? null}, ${entry.amount === undefined ? null : "EUR"},
      ${entry.sensitive ?? 0}, ${entry.teamShared ?? 0}, 'person', ${entry.owner},
      ${`origin-${entry.key}`}, ${NOW - HOUR}, ${NOW - HOUR})`;
});

/** A card in a chat waiting on `person`; foreign keys are off while these are seeded. */
const waiting = Effect.fn("test.waiting")(function* (input: {
  readonly id: string;
  readonly person: KinPersonId;
  readonly chat: string;
  readonly reason?: string;
  readonly state?: object;
  readonly createdAt?: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_widgets (widget_id, org_id, chat_id, message_id, widget_class, type,
      revision, state_json, awaiting_json, updated_at)
    VALUES (${`g-${input.id}`}, ${orgId}, ${input.chat}, ${`m-${input.id}`}, 'native', 'choice', 1,
      ${JSON.stringify(input.state ?? {})}, '[]', ${stamp})`;
  yield* sql`INSERT INTO kin_waiting (waiting_id, org_id, person_id, chat_id, message_id,
      widget_id, reason, created_at)
    VALUES (${input.id}, ${orgId}, ${input.person}, ${input.chat}, NULL, ${`g-${input.id}`},
      ${input.reason ?? "decision"}, ${isoAt(input.createdAt ?? NOW - HOUR)})`;
});

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Ambermill', ${stamp})`;
  yield* sql`INSERT INTO kin_trigger_settings (org_id, time_zone, morning_brief, evening_summary,
      dream, full_rebuild_weekday, owner_check_weekday, owner_check, quiet_hours_json)
    VALUES (${orgId}, 'UTC', '08:30', '18:00', '02:00', 0, 1, '09:00', '[]')`;
  for (const [person, access, money, zone] of [
    [rhea, "owner", 1, null],
    [arjun, "co_owner", 0, null],
    [meera, "member", 0, null],
    [dev, "member", 1, null],
    // Fourteen hours ahead: her today is the company's tomorrow.
    [zoya, "member", 0, "Pacific/Kiritimati"],
  ] as const)
    yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access,
        sees_money, time_zone)
      VALUES (${person}, ${orgId}, ${person}, ${person}, ${stamp}, ${access}, ${money}, ${zone})`;
  for (const [agent, domain] of [
    [chief, "chief-of-staff"],
    [finance, "finance"],
  ] as const) {
    yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
      VALUES (${agent}, ${orgId}, ${agent}, 'lead', ${rhea}, ${stamp})`;
    yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at)
      VALUES (${`chat-${agent}`}, ${orgId}, 'team_group', 0, ${stamp})`;
    yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json,
        worker_projects_json, owner_chat_id, domain)
      VALUES (${agent}, ${orgId}, ${agent}, 0, '{}', '[]', ${`chat-${agent}`}, ${domain})`;
  }
  for (const [id, prefix] of [
    ["work", "W"],
    ["invoices", "INV"],
  ] as const)
    yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in, created_at)
      VALUES (${orgId}, ${id}, ${id}, ${prefix}, 1, 0)`;

  // Rhea's late task (a fact) and a sensitive late one; Meera's own late task.
  yield* task({ key: "W-1", owner: rhea, dueAt: NOW - 2 * DAY });
  yield* task({ key: "W-2", owner: rhea, dueAt: NOW - 2 * DAY, sensitive: 1 });
  yield* task({ key: "W-3", owner: meera, dueAt: NOW - 2 * DAY });
  // Started an hour ago, so no due-soon or stalled fact stands for them: due later today in UTC, and due in Zoya's
  // today, the company's tomorrow.
  yield* task({ key: "W-4", owner: meera, dueAt: NOW + 3 * HOUR, state: "doing" });
  yield* task({ key: "W-5", owner: zoya, dueAt: NOW + 17 * HOUR, state: "doing" });
  yield* task({ key: "W-6", owner: meera, dueAt: NOW + 17 * HOUR, state: "doing" });
  // Overdue and shared with the team; one dropped, whose Confirm card still waits.
  yield* task({
    key: "INV-1",
    register: "invoices",
    state: "waiting",
    owner: rhea,
    dueAt: NOW - 20 * DAY,
    amount: 4_000_00,
    teamShared: 1,
  });
  yield* task({
    key: "INV-2",
    register: "invoices",
    state: "dropped",
    owner: rhea,
    dueAt: NOW - 20 * DAY,
    amount: 1_000_00,
  });

  yield* sql`PRAGMA foreign_keys = OFF`;
  for (const [chat, person, left] of [
    ["chat-rhea", rhea, null],
    ["chat-dev", dev, null],
    ["chat-team", dev, stamp],
  ] as const) {
    yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at)
      VALUES (${chat}, ${orgId}, 'team_group', 0, ${stamp}) ON CONFLICT DO NOTHING`;
    yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id,
        role, joined_at, left_at)
      VALUES (${`${chat}-${person}`}, ${orgId}, ${chat}, 'person', ${person}, 'member', ${stamp},
        ${left})`;
  }
  // Dev: one card in a chat he is in, one in a chat he left.
  yield* waiting({ id: "wait-dev", person: dev, chat: "chat-dev" });
  yield* waiting({ id: "wait-left", person: dev, chat: "chat-team" });
  // Rhea: a live approval, and three whose card settled another way.
  for (const [action, expiresAt] of [
    ["act-live", NOW + HOUR],
    ["act-expired", NOW - HOUR],
  ] as const)
    yield* sql`INSERT INTO kin_pending_actions (action_id, org_id, idempotency_key, kind,
        target_json, resolved_json, target_digest, nonce, revision, reason, requested_by_agent_id,
        requested_by_thread_id, provenance_json, required_approvers_json, state, created_at,
        updated_at, expires_at)
      VALUES (${action}, ${orgId}, ${action}, 'invented', '{}', '{}', 'd', 'n', 0, 'r', ${chief},
        't', '{}', '[]', 'awaiting_approval', ${NOW - DAY}, ${NOW - DAY}, ${expiresAt})`;
  yield* waiting({
    id: "wait-approval",
    person: rhea,
    chat: "chat-rhea",
    reason: "approval",
    state: { actionId: "act-live" },
    createdAt: NOW - 3 * HOUR,
  });
  yield* waiting({
    id: "wait-expired",
    person: rhea,
    chat: "chat-rhea",
    reason: "approval",
    state: { actionId: "act-expired" },
  });
  yield* waiting({ id: "wait-send", person: rhea, chat: "chat-rhea", reason: "question" });
  yield* sql`INSERT INTO kin_connection_asks (org_id, ask_id, connection_id, tool_name, pin_digest,
      payload_json, agent_id, wakeup_id, chat_id, widget_id, entry_record_id, state, proposed_at)
    VALUES (${orgId}, 'ask-1', 'conn-1', 'send', 'p',
      '{"attachments":[{"entryRecordId":"r-INV-2"}]}', ${finance}, 'wake-1', 'chat-rhea',
      'g-wait-send', 'r-INV-2', 'open', ${NOW - DAY})`;
  yield* waiting({ id: "wait-answered", person: rhea, chat: "chat-rhea" });
  yield* sql`INSERT INTO kin_questions (question_id, org_id, agent_id, person_id, chat_id, kind,
      widget_id, question, safe, asked_at, due_at, act_at, state)
    VALUES ('q-1', ${orgId}, ${chief}, ${rhea}, 'chat-rhea', 'choice', 'g-wait-answered',
      'Invented question', 0, ${NOW - DAY}, ${NOW + DAY}, ${NOW + DAY}, 'answered')`;
  yield* sql`PRAGMA foreign_keys = ON`;
});

const open = (personId: KinPersonId, ownerLevel = false) =>
  KinOpen.compute({ orgId, viewer: { personId, ownerLevel }, at: NOW });
const ids = (read: KinOpenRead) => read.rows.map((row) => row.id);
const factsOn = (read: KinOpenRead, key: string) =>
  read.rows.filter((row) => row.item._tag === "fact" && row.item.fact.subject.key === key);

it.effect("a late task is one row: its fact stands for it, in Needs you's order", () =>
  Effect.gen(function* () {
    yield* seed;
    const read = yield* open(rhea, true);
    assert.lengthOf(factsOn(read, "W-1"), 1);
    assert.notInclude(ids(read), "task:W-1");
    assert.isTrue(factsOn(read, "W-1")[0]!.late);
    // Owner level reads the invoice's own fact, so no "invoices overdue" row beside it.
    assert.notInclude(ids(read), "money:overdue");
    assert.isTrue(read.rows.some((row) => row.id.startsWith("fact:invoice_overdue:INV-1")));
    // Urgent work facts, then money facts, then waiting.
    const kinds = read.rows.map((row) =>
      row.item._tag === "fact" ? `fact:${row.item.fact.family}` : row.item._tag,
    );
    assert.deepStrictEqual(
      kinds.filter((kind, index) => kinds.indexOf(kind) === index),
      ["fact:work", "fact:money", "waiting"],
    );
    assert.strictEqual(read.counts.needsYou, read.rows.length);
  }).pipe(Effect.provide(layer)),
);

it.effect("each role reads what it may see, and no more", () =>
  Effect.gen(function* () {
    yield* seed;
    // A co-owner sees every fact, the sensitive one too.
    const coOwner = yield* open(arjun, true);
    assert.lengthOf(factsOn(coOwner, "W-1"), 1);
    assert.lengthOf(factsOn(coOwner, "W-2"), 1);
    // What waits on Rhea, the co-owner sees marked as hers, last and counted as nobody's here.
    const others = coOwner.rows.flatMap((row) => (row.item._tag === "waiting" ? [row] : []));
    assert.deepStrictEqual(
      others.map((row) => [row.id, row.item._tag === "waiting" && row.item.waiting.waitsFor]),
      [["waiting:wait-approval", { personId: rhea, name: "rhea" }]],
    );
    assert.strictEqual(coOwner.rows.at(-1)?.id, "waiting:wait-approval");
    assert.strictEqual(coOwner.counts.waiting, 0);
    assert.strictEqual(coOwner.counts.needsYou, coOwner.rows.length - 1);
    // Meera: her own late task, today's and tomorrow's; none of Rhea's, no money fact or row.
    const member = yield* open(meera);
    assert.deepStrictEqual(
      ids(member).filter((id) => !id.startsWith("fact:")),
      ["task:W-4", "task:W-6"],
    );
    assert.lengthOf(factsOn(member, "W-3"), 1);
    assert.lengthOf(factsOn(member, "W-1"), 0);
    assert.lengthOf(factsOn(member, "W-2"), 0);
    assert.isFalse(member.rows.some((row) => row.id.includes("INV-")));
    // Dev may read money: the invoice he sees is one "overdue" row, as no money fact reaches him.
    const withMoney = yield* open(dev);
    const money = withMoney.rows.find((row) => row.id === "money:overdue");
    assert.deepStrictEqual(money?.item, { _tag: "money", invoices: 1 });
    assert.isFalse(withMoney.rows.some((row) => row.item._tag === "fact"));
    // A teammate sees nothing that waits on anyone else, owner level or not.
    for (const read of [member, withMoney])
      assert.isFalse(
        read.rows.some((row) => row.item._tag === "waiting" && row.item.waiting.waitsFor),
      );
  }).pipe(Effect.provide(layer)),
);

it.effect("waiting counts only cards still open, in chats the person is still in", () =>
  Effect.gen(function* () {
    yield* seed;
    // Dev left the team chat: its card is not his to answer.
    const devRead = yield* open(dev);
    assert.deepStrictEqual(
      ids(devRead).filter((id) => id.startsWith("waiting:")),
      ["waiting:wait-dev"],
    );
    assert.strictEqual(devRead.counts.waiting, 1);
    // Rhea: an expired approval, a send of a voided invoice and an answered question are settled.
    const from = yield* KinOpen.sources({
      orgId,
      viewer: { personId: rhea, ownerLevel: true },
      at: NOW,
    });
    assert.deepStrictEqual(
      [...from.settled].toSorted(([a], [b]) => (a < b ? -1 : 1)),
      [
        ["wait-answered", "question_settled"],
        ["wait-expired", "approval_not_live"],
        ["wait-send", "send_not_open"],
      ],
    );
    const read = KinOpen.rowsOf(from, NOW);
    assert.deepStrictEqual(
      ids(read).filter((id) => id.startsWith("waiting:")),
      ["waiting:wait-approval"],
    );
    assert.strictEqual(read.counts.waiting, 1);
  }).pipe(Effect.provide(layer)),
);

it.effect("its tasks are the ones Tasks counts under Needs you, in Tasks' order", () =>
  Effect.gen(function* () {
    yield* seed;
    // Due in ten days: on her list, not yet in Needs you. Undated and handed back: it is.
    yield* task({ key: "W-7", owner: meera, dueAt: NOW + 10 * DAY });
    yield* task({ key: "W-8", owner: meera, dueAt: NOW + 2 * DAY });
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE kin_records SET due_at = NULL, handed_back_at = ${NOW - HOUR}
      WHERE org_id = ${orgId} AND key = 'W-8'`;
    for (const [personId, ownerLevel] of [
      [rhea, true],
      [dev, false],
      [meera, false],
      [zoya, false],
    ] as const) {
      const read = yield* open(personId, ownerLevel);
      const tasks = yield* movePage({
        orgId,
        personId,
        ownerLevel,
        filter: { at: NOW, ...(ownerLevel ? {} : { team: personId }) },
        offset: 0,
        limit: 100,
        at: NOW,
      });
      const counted = tasks.moves.filter((move) => move.group === "needsYou" && !move.under);
      const late = (key: string) => tasks.rows.find((row) => row.key === key)?.late === true;
      assert.strictEqual(read.counts.tasks, tasks.counts.needsYou);
      // Each is a row of its own unless its fact stands for it.
      const covered = new Set(
        read.rows.flatMap((row) =>
          row.item._tag === "fact" && row.item.fact.subject.kind === "record"
            ? [row.item.fact.subject.key]
            : [],
        ),
      );
      assert.deepStrictEqual(
        ids(read).filter((id) => id.startsWith("task:")),
        counted
          .filter((move) => !covered.has(move.key))
          // Late ones lead the list, each part in Tasks' order.
          .toSorted((a, b) => Number(late(b.key)) - Number(late(a.key)))
          .map((move) => `task:${move.key}`),
      );
    }
    const member = yield* open(meera);
    assert.notInclude(ids(member), "task:W-7");
    const undated = member.rows.find((row) => row.id === "task:W-8")?.item;
    assert.isTrue(undated?._tag === "task" && undated.dueAt === undefined);
  }).pipe(Effect.provide(layer)),
);

it.effect("a handled fact leaves the list with its task, and its Undo brings both back", () =>
  Effect.gen(function* () {
    yield* seed;
    const before = yield* open(rhea, true);
    const fact = factsOn(before, "W-1")[0]!;
    if (fact.item._tag !== "fact") return yield* Effect.die(new Error("No fact."));
    const factKey = fact.item.fact.key;
    const handle = (action: "not_a_problem" | "undo") =>
      KinPulse.handle({
        orgId,
        at: NOW,
        viewer: { _tag: "owner" },
        by: { _tag: "person", personId: rhea },
        factKey,
        action,
      });
    yield* handle("not_a_problem");
    const handled = yield* open(rhea, true);
    assert.notInclude(ids(handled), fact.id);
    assert.notInclude(ids(handled), "task:W-1");
    assert.strictEqual(handled.counts.needsYou, before.counts.needsYou - 1);
    yield* handle("undo");
    assert.deepStrictEqual(ids(yield* open(rhea, true)), ids(before));
  }).pipe(Effect.provide(layer)),
);

it.effect("counts stay whole past the 200 rows sent, in the same number of queries", () =>
  Effect.gen(function* () {
    yield* seed;
    const statements: Array<string> = [];
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        const end = span.end.bind(span);
        span.end = (endTime, exit) => {
          end(endTime, exit);
          const query = span.attributes.get("db.query.text");
          if (typeof query === "string") statements.push(query);
        };
        return span;
      },
    });
    const counted = Effect.fn("test.counted")(function* () {
      statements.length = 0;
      const read = yield* open(arjun, true).pipe(Effect.withTracer(tracer));
      return { read, queries: statements.length };
    });
    const small = yield* counted();
    // 21 of Arjun's tasks due later today, with no cap of 20 on them.
    for (let index = 0; index < 21; index += 1)
      yield* task({
        key: `W-${100 + index}`,
        owner: arjun,
        dueAt: NOW + HOUR + index,
        state: "doing",
      });
    const some = yield* counted();
    assert.strictEqual(
      some.read.rows.filter((row) => row.item._tag === "task").length,
      21 + small.read.rows.filter((row) => row.item._tag === "task").length,
    );
    for (let index = 21; index < 300; index += 1)
      yield* task({
        key: `W-${100 + index}`,
        owner: arjun,
        dueAt: NOW + HOUR + index,
        state: "doing",
      });
    const many = yield* counted();
    assert.lengthOf(many.read.rows, 200);
    assert.strictEqual(many.read.counts.needsYou, small.read.counts.needsYou + 300);
    assert.strictEqual(many.read.counts.tasks, small.read.counts.tasks! + 300);
    assert.strictEqual(many.queries, some.queries);
  }).pipe(Effect.provide(layer)),
);
