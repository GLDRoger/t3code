import { assert, describe, expect, it, vi } from "@effect/vitest";
import {
  KinAgentId,
  KinChatId,
  KinMemoryItemId,
  KinOrgId,
  KinPersonId,
  KinWakeupId,
  type KinPulseOutsideLine,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Fiber from "effect/Fiber";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ArrivalStore from "../arrivals/ArrivalStore.ts";
import { classify, type ArrivalHeaders } from "../arrivals/classify.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import { coveredToday, looseOffsetMs, queueCheckIn } from "./checkIn.ts";
import { toolAdmitted } from "../lead/SharedTools.ts";
import { PulseHandleInput, runHandle } from "./mcp.ts";
import { buildPulseSection } from "./prompt.ts";
import { toldBy } from "./told.ts";
import { missedSlot } from "./checkInCatchUp.ts";
import * as KinSchedules from "../triggers/kinSchedules.ts";
import { followOwnerZone, onHostClock } from "./checkInSeeds.ts";
import * as KinPulse from "./KinPulse.ts";
import { deliverHeld } from "../triggers/heldDelivery.ts";
import { holdIfQuiet } from "../triggers/quietHold.ts";
import { inHoursAt, nudge } from "./nudge.ts";
import {
  mailLine,
  type OutsideRead,
  type OutsideSource,
  outsideKey,
  poll,
  wakeMatches,
} from "./outside.ts";

// Invented company, people, mail and calendar only; nothing here reads a real database or service.
const orgId = KinOrgId.make("org");
const owner = KinPersonId.make("owner");
const mate = KinPersonId.make("mate");
const chief = KinAgentId.make("cos");
const finance = KinAgentId.make("fin");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// Monday 16 November 2026, 15:25 UTC: the afternoon check-in's window opens.
const MONDAY = Date.UTC(2026, 10, 16);
const SLOT = MONDAY + 15 * HOUR + 25 * MINUTE;
const stamp = "2026-10-01T00:00:00.000Z";
const afternoon = KinMemoryItemId.make("checkin-afternoon");

const layer = KinEventQueue.layer.pipe(
  Layer.provideMerge(KinPersistence.layer),
  Layer.provideMerge(Sqlite.layerMemory),
);

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Invented Studio', ${stamp})`;
  // The company keeps UTC, as the host the tests pass does, whatever clock runs them.
  yield* sql`INSERT INTO kin_trigger_settings VALUES (${orgId}, 'UTC', '08:30', '18:30', '03:00',
    0, 1, '09:00', '[]')`;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at,
      time_zone, work_hours_json)
    VALUES (${owner}, ${orgId}, 'owner', 'Arjun', ${stamp}, NULL, NULL),
      (${mate}, ${orgId}, 'mate', 'Meera', ${stamp}, 'UTC',
        '{"days":[1,2,3,4,5],"start":"09:00","end":"18:00"}')`;
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
  for (const [id, prefix] of [
    ["work", "W"],
    ["clients", "C"],
    ["contacts", "CT"],
    ["invoices", "INV"],
  ] as const)
    yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in, created_at)
      VALUES (${orgId}, ${id}, ${id}, ${prefix}, 1, 0)`;
});

const companyClock = Effect.fn("test.companyClock")(function* (zone: string, quiet = "[]") {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE kin_trigger_settings SET time_zone = ${zone}, quiet_hours_json = ${quiet}
    WHERE org_id = ${orgId}`;
});

const record = Effect.fn("test.record")(function* (row: {
  readonly key: string;
  readonly list: string;
  readonly title: string;
  readonly state?: string;
  readonly ownerId?: string;
  readonly ownerKind?: string;
  readonly dueAt?: number;
  readonly partyId?: string;
  readonly fields?: string;
  readonly origin?: string;
  readonly createdAt?: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, state, owner_kind,
      owner_id, party_id, due_at, fields_json, created_by_kind, created_by_id, origin_key,
      created_at, updated_at)
    VALUES (${orgId}, ${`r-${row.key}`}, ${row.list}, ${row.key}, ${row.title},
      ${row.state ?? "open"}, ${row.ownerKind ?? "agent"}, ${row.ownerId ?? chief},
      ${row.partyId ?? null}, ${row.dueAt ?? null}, ${row.fields ?? "{}"}, 'person', ${owner},
      ${row.origin ?? `origin-${row.key}`}, ${row.createdAt ?? MONDAY - 30 * DAY},
      ${row.createdAt ?? MONDAY - 30 * DAY})`;
});

const mail = (id: string, who: string, subject: string): KinPulseOutsideLine => ({
  source: "mail",
  connection: "Google",
  id,
  at: "Mon, 16 Nov 2026 10:41:00 +0000",
  who,
  subject,
  where: null,
});
const mailbox = "company-mail";
const companyMail = "hello@tidewater.example";
const addMailbox = Effect.fn("test.addMailbox")(function* (connectionId = mailbox) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_connections (org_id, connection_id, preset, label, kind, url_host,
      auth, reach, state, created_at, updated_at)
    VALUES (${orgId}, ${connectionId}, 'google', 'Google', 'builtin', 'google.example',
      'oauth', 'closed', 'active', 0, 0)`;
});

const storeArrival = Effect.fn("test.storeArrival")(function* (
  line: KinPulseOutsideLine,
  fromAddress: string,
  options: {
    readonly connectionId?: string;
    readonly messageId?: string;
    readonly receivedAt?: number;
    readonly headers?: Partial<ArrivalHeaders>;
  } = {},
) {
  const connectionId = options.connectionId ?? mailbox;
  const threadId = line.thread!;
  const messageId = options.messageId ?? line.id;
  const classified = classify(
    {
      threadId,
      from: line.who,
      fromAddress,
      to: line.to === undefined ? [] : [line.to],
      cc: [],
      subject: line.subject!,
      authResults: [],
      listUnsubscribe: false,
      precedence: null,
      autoSubmitted: null,
      bulk: false,
      hasFile: false,
      ...options.headers,
    },
    yield* ArrivalStore.rowsFor(orgId, connectionId, [companyMail]),
  );
  assert.isTrue(
    yield* ArrivalStore.claim(
      orgId,
      {
        arrivalId: ArrivalStore.arrivalIdOf(orgId, connectionId, messageId),
        connectionId,
        messageId,
        threadId,
        mailKey: null,
        fromAddress,
        receivedAt: options.receivedAt ?? SLOT - MINUTE,
        class: classified.class,
        reason: classified.reason,
        needsLook: classified.look !== undefined,
        hasFile: null,
        senderCheck: null,
      },
      SLOT,
      false,
    ),
  );
});

const outsideMail = (id: string, who: string, subject: string, to?: string) => ({
  ...mail(id, who, subject),
  thread: id.split(":")[0]!,
  ...(to === undefined ? {} : { to }),
});

const mailOutside = (lines: ReadonlyArray<KinPulseOutsideLine>, identified = lines) => ({
  lines,
  seen: [],
  mailThreads: new Map(
    identified.map((line) => [line, { connectionId: mailbox, threadId: line.thread! }]),
  ),
});
const source = (lines: ReadonlyArray<KinPulseOutsideLine>): OutsideSource => ({
  read: () => Effect.succeed({ lines, seen: [] }),
  seen: () => Effect.void,
});
const nothingOutside: OutsideRead = { lines: [], seen: [] };

const checkIn = (dueAt: number, outside: OutsideRead = nothingOutside, at = dueAt) =>
  queueCheckIn({
    orgId,
    agentId: chief,
    scheduleId: afternoon,
    title: "Afternoon check-in",
    what: "Afternoon check-in.",
    dueAt,
    looseAt: "15:30",
    zone: "UTC",
    at,
    outside,
  });

const zoya = KinPersonId.make("zoya");
const arjun = KinPersonId.make("arjun");
const declineAt = MONDAY + 11 * HOUR;
const tomorrow = MONDAY + DAY + 12 * HOUR;
const declineTurn = { orgId, agentId: chief, wakeupId: "decline-turn" };
const declineOptions = { action: "declined", record: "W-8" };
const handleInput = Schema.decodeUnknownOption(PulseHandleInput);
const decline = Effect.fn("test.decline")(function* (options: unknown = declineOptions) {
  const decoded = handleInput(options);
  assert.isTrue(Option.isSome(decoded), "pulse_handle accepts declined");
  assert.isTrue(yield* toolAdmitted(declineTurn, "pulse_handle", options));
  return yield* runHandle(declineTurn, Option.getOrThrow(decoded));
});

const chatLine = Effect.fn("test.chatLine")(function* (input: {
  id: string;
  person?: KinPersonId;
  to?: KinPersonId | KinAgentId;
  seq: number;
  at: number;
  replyTo?: string;
  clientId?: string;
  memberId?: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const { id, person, seq, at, replyTo, clientId } = input;
  const recipient = input.to ?? person ?? zoya;
  yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind,
      author_person_id, author_agent_id, author_owner_person_id, author_thread_id,
      author_member_id, author_role, kind, body, mentions_json, status, created_at, reply_to, client_message_id)
    VALUES (${id}, ${orgId}, ${`chat-${recipient}`}, ${seq}, ${person ? "human" : "agent"},
      ${person ?? null}, ${person ? null : chief}, ${person ? null : owner}, ${person ? null : "thread"},
      ${input.memberId ?? (person ? `member-${person}` : `lead-${recipient}`)},
      'member', 'text', 'Invented message', '[]', 'posted',
      ${DateTime.formatIso(DateTime.makeUnsafe(at))}, ${replyTo ?? null}, ${clientId ?? null})`;
});

const seedDecline = Effect.fn("test.seedDecline")(function* (recipient = zoya) {
  yield* seed;
  yield* TestClock.setTime(declineAt);
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE kin_people SET display_name = 'Rhea' WHERE org_id = ${orgId} AND person_id = ${owner}`;
  yield* record({
    key: "W-8",
    list: "work",
    title: "Freight mock-up",
    ownerKind: "person",
    ownerId: zoya,
    dueAt: MONDAY - 4 * DAY,
    fields: JSON.stringify({ alsoOn: [`person:${arjun}`] }),
  });
  for (const [person, name] of [
    [zoya, "Zoya"],
    [arjun, "Arjun"],
  ] as const) {
    const chat = `chat-${person}`;
    yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, time_zone)
      VALUES (${person}, ${orgId}, ${person}, ${name}, ${stamp}, 'UTC')`;
    yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
      VALUES (${chat}, ${orgId}, 'direct', ${`${person}:${chief}`}, 0, ${stamp})`;
    yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id,
        agent_id, role, joined_at)
      VALUES (${`member-${person}`}, ${orgId}, ${chat}, 'person', ${person}, NULL, 'member', ${stamp}),
        (${`lead-${person}`}, ${orgId}, ${chat}, 'agent', NULL, ${chief}, 'member', ${stamp})`;
  }
  const factKey = yield* freightFact(declineAt);
  const day = "2026-11-16";
  yield* sql`INSERT INTO kin_pulse_nudges (org_id, person_id, day, agent_id, chat_id, fact_key, sent_at)
    VALUES (${orgId}, ${recipient}, ${day}, ${chief}, ${`chat-${recipient}`}, ${factKey}, ${declineAt - HOUR})`;
  yield* chatLine({
    id: "nudge",
    to: recipient,
    seq: 1,
    at: declineAt - HOUR,
    clientId: `send:pulse-nudge:${recipient}:${day}`,
  });
  yield* chatLine({
    id: "answer",
    person: zoya,
    seq: 2,
    at: declineAt,
    ...(recipient === zoya ? { replyTo: "nudge" } : {}),
  });
  yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, model, started_at, status,
      event_ids, audience)
    VALUES (${declineTurn.wakeupId}, ${orgId}, ${chief}, 'test', ${declineAt}, 'running', '[]', 'shared')`;
  yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json, received_at,
      queued_at, state, wakeup_id)
    VALUES ('decline-event', ${orgId}, ${chief}, 'chat.message', 'P0',
    '{"_tag":"chat.message","chatId":"chat-zoya","messageId":"answer"}',
    ${declineAt}, ${declineAt}, 'claimed', ${declineTurn.wakeupId})`;
  return { sql, factKey };
});

const freightFact = Effect.fn("test.freightFact")(function* (at: number) {
  const { facts } = yield* KinPulse.read({ orgId, at, viewer: { _tag: "people", people: [zoya] } });
  const fact = facts.find((item) => item.subject.key === "W-8" && item.sense === "task_late");
  assert.isDefined(fact);
  return fact!.key;
});

const nudgeFreight = Effect.fn("test.nudgeFreight")(function* (at: number, person = "Zoya") {
  const factKey = yield* freightFact(at);
  return yield* nudge({
    orgId,
    agentId: chief,
    at,
    person,
    factKey,
    text: "W-8 was due. The freight review depends on it.",
    chatFor: (id) => Effect.succeed(KinChatId.make(`chat-${id}`)),
    post: () => Effect.undefined,
  }).pipe(
    Effect.as("sent"),
    Effect.catchTags({ KinChatError: (error) => Effect.succeed(error.message) }),
  );
});

it.effect("a nudge the person declined is not repeated until the thing changes", () =>
  Effect.gen(function* () {
    const { sql, factKey } = yield* seedDecline();
    yield* decline({ action: "declined", factKey });
    assert.include(yield* nudgeFreight(tomorrow), "Zoya turned down a nudge about this.");
    assert.lengthOf(
      yield* sql`SELECT 1 FROM kin_pulse_nudges WHERE org_id = ${orgId}
      AND person_id = ${zoya} AND day = '2026-11-17'`,
      0,
    );
    yield* sql`UPDATE kin_records SET due_at = due_at + ${HOUR} WHERE org_id = ${orgId} AND key = 'W-8'`;
    assert.include(yield* nudgeFreight(tomorrow), "Zoya turned down a nudge about this.");
    yield* sql`UPDATE kin_records SET due_at = due_at + ${DAY} WHERE org_id = ${orgId} AND key = 'W-8'`;
    assert.strictEqual(yield* nudgeFreight(tomorrow), "sent");
  }).pipe(Effect.provide(layer)),
);

it.effect("another person can still be nudged about a declined thing", () =>
  Effect.gen(function* () {
    yield* seedDecline();
    yield* decline();
    assert.strictEqual(yield* nudgeFreight(tomorrow, "Arjun"), "sent");
    assert.include(yield* nudgeFreight(tomorrow), "Zoya turned down a nudge about this.");
  }).pipe(Effect.provide(layer)),
);

it.effect.each(["comment", "reply", "undo"] as const)(
  "the person raising it ends the decline (%s)",
  (raises) =>
    Effect.gen(function* () {
      const { sql } = yield* seedDecline();
      if (raises === "reply")
        yield* sql`UPDATE kin_messages SET reply_to = NULL WHERE org_id = ${orgId} AND message_id = 'answer'`;
      yield* decline();
      assert.include(yield* nudgeFreight(tomorrow), "Zoya turned down a nudge about this.");
      if (raises === "comment")
        yield* sql`INSERT INTO kin_record_comments (org_id, comment_id, record_id, seq, author_kind,
          author_id, body, request_hash, created_at)
          VALUES (${orgId}, 'comment', 'r-W-8', 1, 'person', ${zoya}, 'Invented note', 'test', ${declineAt + HOUR})`;
      else if (raises === "reply") {
        yield* chatLine({ id: "linked", seq: 3, at: declineAt + HOUR });
        yield* sql`INSERT INTO kin_message_names (org_id, message_id, names_json)
          VALUES (${orgId}, 'linked', '[{"key":"W-8","text":"Freight mock-up"}]')`;
        yield* chatLine({
          id: "raised",
          person: zoya,
          seq: 4,
          at: declineAt + 2 * HOUR,
          replyTo: "linked",
        });
      } else yield* runHandle(declineTurn, { record: "W-8", action: "undo" });
      assert.strictEqual(yield* nudgeFreight(tomorrow), "sent");
    }).pipe(Effect.provide(layer)),
);

it.effect("a check-in lists a standing decline once, with whose word it was", () =>
  Effect.gen(function* () {
    const { sql } = yield* seedDecline();
    yield* decline();
    const section = Effect.fn("test.declineSection")(function* (at: number) {
      const [event] = yield* sql<{
        id: string;
      }>`SELECT event_id AS id FROM kin_events WHERE org_id = ${orgId}
        AND received_at = ${at} AND tag = 'pulse' ORDER BY event_id`;
      const checkInEvents = event === undefined ? [] : [event.id];
      return yield* buildPulseSection({
        orgId,
        agentId: chief,
        now: at,
        wokeFor: [],
        checkIn: yield* toldBy(orgId, checkInEvents),
        checkInEvents,
      });
    });
    assert.include(yield* checkIn(SLOT), { _tag: "queued" });
    const first = yield* section(SLOT);
    assert.deepStrictEqual(first?.setAside, [
      "W-8 Freight mock-up: Zoya turned down a nudge about it, so no more nudges to Zoya about it until it changes or Zoya brings it up.",
    ]);
    assert.isTrue(
      first?.byProject.some(({ facts }) =>
        facts.some(({ about }) => about.includes("Freight mock-up")),
      ),
    );
    yield* checkIn(SLOT + DAY);
    assert.isUndefined((yield* section(SLOT + DAY))?.setAside);
    yield* sql`UPDATE kin_records SET state = 'done' WHERE org_id = ${orgId} AND key = 'W-8'`;
    assert.isUndefined((yield* section(SLOT))?.setAside);
  }).pipe(Effect.provide(layer)),
);

it.effect("only the person who answered can decline", () =>
  Effect.gen(function* () {
    yield* seedDecline(arjun);
    assert.isFalse(
      yield* toolAdmitted(declineTurn, "pulse_handle", { record: "W-8", action: "set_aside" }),
    );
    const error = yield* Effect.flip(decline());
    assert.include(error.message, "Only the person who answered the nudge can decline it.");
  }).pipe(Effect.provide(layer)),
);

const pulseEvents = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ agent: string; key: string; notBefore: number | null; json: string }>`
    SELECT agent_id AS agent, dedupe_key AS key, not_before AS "notBefore", json
    FROM kin_events WHERE org_id = ${orgId} AND tag = 'pulse' ORDER BY queued_at, event_id`;
});

/** A seeded check-in's row and native task, as `KinSchedules.save` writes them. */
const scheduleRow = Effect.fn("test.scheduleRow")(function* (row: {
  readonly slug: string;
  readonly at: string;
  readonly days: ReadonlyArray<number>;
  readonly source?: string;
  readonly looseAt?: string | null;
  readonly enabled?: boolean;
}) {
  const sql = yield* SqlClient.SqlClient;
  const taskId = KinSchedules.scheduleTaskId(orgId, `checkin-${row.slug}`);
  yield* sql`INSERT INTO scheduled_tasks (task_id, title, prompt, enabled, schedule_json,
      project_id, workspace_strategy_json, model_selection_json, runtime_mode,
      interaction_mode, created_by, creation_source, created_at, updated_at,
      last_run_status, run_count)
    VALUES (${taskId}, ${row.slug}, 'Check in', ${row.enabled === false ? 0 : 1}, ${JSON.stringify({
      type: "fixed_time",
      timeOfDay: row.at,
      weekdays: row.days,
    })}, 'project', '{}', '{}', 'approval-required', 'plan', 'system', 'server', ${stamp},
      ${stamp}, 'never', 0)`;
  yield* sql`INSERT INTO kin_schedules (task_id, org_id, schedule_id, agent_id, chat_id,
      source_event, said_by, audience, content_sha256, inbox_thread_id, created_at,
      updated_at, loose_at, check_in)
    VALUES (${taskId}, ${orgId}, ${`checkin-${row.slug}`}, ${chief}, ${`chat-${chief}`},
      ${row.source ?? `kin-seed:check-ins:${orgId}`}, ${owner}, 'owner_only', 'hash', 'inbox', 0, 0,
      ${row.looseAt ?? null}, 1)`;
});

describe("pulse check-ins", () => {
  it.effect("a loose slot queues once at its own minute, and another day at another", () =>
    Effect.gen(function* () {
      yield* seed;
      // Nothing open and nothing new: no event, so no model starts.
      assert.deepStrictEqual(yield* checkIn(SLOT), { _tag: "nothing_new" });
      assert.lengthOf(yield* pulseEvents, 0);

      yield* record({ key: "W-1", list: "work", title: "Invented site copy", dueAt: MONDAY - DAY });
      const first = yield* checkIn(SLOT);
      // The same slot fired again, as after a restart: the stored event and its minute stand.
      const again = yield* checkIn(SLOT);
      const offset = looseOffsetMs(afternoon, "2026-11-16");
      assert.strictEqual(first._tag, "queued");
      assert.strictEqual(again._tag, "duplicate");
      assert.strictEqual(first._tag === "queued" ? first.notBefore : 0, SLOT + offset);
      // W-1 was told Monday; Tuesday's check-in runs for a task late since.
      yield* record({ key: "W-2", list: "work", title: "Invented flyer", dueAt: MONDAY + HOUR });
      const tuesday = yield* checkIn(SLOT + DAY);
      const events = yield* pulseEvents;
      assert.deepStrictEqual(
        events.map((event) => [event.key, event.notBefore]),
        [
          ["checkin:checkin-afternoon:2026-11-16", SLOT + offset],
          [
            "checkin:checkin-afternoon:2026-11-17",
            SLOT + DAY + looseOffsetMs(afternoon, "2026-11-17"),
          ],
        ],
      );
      assert.strictEqual(tuesday._tag, "queued");
      assert.notStrictEqual(looseOffsetMs(afternoon, "2026-11-17"), offset);
    }).pipe(Effect.provide(layer)),
  );

  it.effect.each([
    { name: "waits for ten quiet minutes", expected: 7 * MINUTE, activity: "single" },
    { name: "waits at most an hour", expected: HOUR, activity: "continuous" },
    { name: "ignores other writes", expected: 0, activity: "other" },
    { name: "stays in the evening's day", expected: 0, activity: "evening" },
    { name: "keeps the usual loose minute in a quiet chat", expected: 0, activity: "quiet" },
    { name: "survives restart once", expected: 7 * MINUTE, activity: "restart" },
    { name: "holds from the end of quiet hours", expected: 7 * MINUTE, activity: "after-quiet" },
    { name: "holds late on a long DST evening", expected: 7 * MINUTE, activity: "evening-dst" },
  ])("a scheduled check-in $name", ({ expected, activity }) =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const chat = `chat-${chief}`;
      yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind,
          person_id, agent_id, role, joined_at)
        VALUES (${`member-${owner}`}, ${orgId}, ${chat}, 'person', ${owner}, NULL, 'owner', ${stamp}),
          (${`lead-${chief}`}, ${orgId}, ${chat}, 'agent', NULL, ${chief}, 'member', ${stamp}),
          ('member-owner-finance', ${orgId}, ${`chat-${finance}`}, 'person', ${owner}, NULL, 'owner', ${stamp})`;
      const dst = activity === "evening-dst";
      const evening = activity === "evening" || dst;
      if (evening)
        yield* companyClock(dst ? "America/New_York" : "UTC", '{"from":"02:00","to":"03:00"}');
      // Quiet hours past the slot's whole hour: the check-in first comes due when they end.
      if (activity === "after-quiet") yield* companyClock("UTC", '{"from":"14:00","to":"17:00"}');
      // 23:40 in New York on Sunday 1 November 2026, a 25-hour day: 04:40 UTC the next day.
      const opens = dst ? Date.UTC(2026, 10, 2, 4, 40) : evening ? MONDAY + DAY - 3 * MINUTE : SLOT;
      const due = evening
        ? opens + 20_000
        : activity === "after-quiet"
          ? MONDAY + 17 * HOUR
          : SLOT + looseOffsetMs(afternoon, "2026-11-16");
      const personWrites = (seq: number, at: number) =>
        chatLine({ id: `owner-${seq}`, to: chief, person: owner, seq, at });
      yield* TestClock.setTime(opens);
      yield* record({ key: "W-1", list: "work", title: "Invented site copy", dueAt: MONDAY - DAY });
      if (activity === "other") {
        yield* chatLine({ id: "agent", to: chief, seq: 1, at: due - 3 * MINUTE });
        yield* chatLine({ id: "card", to: chief, person: owner, seq: 2, at: due - 2 * MINUTE });
        yield* sql`UPDATE kin_messages SET kind = 'widget_action' WHERE message_id = 'card'`;
        yield* chatLine({
          id: "key",
          to: chief,
          person: owner,
          seq: 3,
          at: due - MINUTE,
          clientId: "send:key:test:one",
        });
        yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind,
            author_role, kind, body, mentions_json, status, created_at)
          VALUES ('notice', ${orgId}, ${chat}, 4, 'system', 'member', 'system', 'Invented notice',
            '[]', 'posted', ${DateTime.formatIso(DateTime.makeUnsafe(due - MINUTE))})`;
        yield* chatLine({
          id: "elsewhere",
          to: finance,
          person: owner,
          seq: 1,
          at: due - MINUTE,
          memberId: "member-owner-finance",
        });
        // Forwarded, deleted or only suggested text, and a co-owner's, is not the owner talking.
        for (const [seq, id] of [
          [5, "forwarded"],
          [6, "deleted"],
          [7, "suggested"],
        ] as const)
          yield* chatLine({ id, to: chief, person: owner, seq, at: due - MINUTE });
        yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind,
            person_id, agent_id, role, joined_at)
          VALUES (${`member-${mate}`}, ${orgId}, ${chat}, 'person', ${mate}, NULL, 'member', ${stamp})`;
        yield* chatLine({ id: "co-owner", to: chief, person: mate, seq: 8, at: due - MINUTE });
        yield* sql`UPDATE kin_messages SET origin_json = '{"chatId":"elsewhere"}'
          WHERE message_id = 'forwarded'`;
        yield* sql`UPDATE kin_messages SET status = message_id
          WHERE message_id IN ('deleted', 'suggested')`;
      }
      const enqueue = evening
        ? queueCheckIn({
            orgId,
            agentId: chief,
            scheduleId: KinMemoryItemId.make("checkin-evening"),
            title: "Evening check-in",
            what: "Sum up today.",
            dueAt: opens,
            looseAt: null,
            zone: "UTC",
            at: opens,
            outside: nothingOutside,
            sumUp: true,
          })
        : checkIn(opens);
      assert.strictEqual((yield* enqueue)._tag, "queued");
      const queue = yield* KinEventQueue.KinEventQueue;
      const claim = (current: typeof queue, id: string) =>
        Effect.scoped(
          Effect.gen(function* () {
            const wakeupId = KinWakeupId.make(id);
            const events = yield* current.claim({ orgId, agentId: chief, wakeupId, model: "test" });
            const started = yield* Clock.currentTimeMillis;
            yield* current.finish({ orgId, wakeupId, status: "completed" });
            return { started, events };
          }),
        );
      if (activity !== "quiet" && activity !== "other") yield* personWrites(1, due - 3 * MINUTE);
      const elapsed = due - opens;
      if (activity === "restart") {
        const first = yield* claim(queue, "before-restart").pipe(
          Effect.timeoutOption(elapsed + 2 * MINUTE),
          Effect.forkChild,
        );
        yield* TestClock.adjust(elapsed + 2 * MINUTE);
        assert.isTrue(Option.isNone(yield* Fiber.join(first)), "no turn before restart");
        yield* Effect.gen(function* () {
          assert.strictEqual((yield* enqueue)._tag, "duplicate");
          const restarted = yield* KinEventQueue.KinEventQueue;
          const run = yield* claim(restarted, "after-restart").pipe(Effect.forkChild);
          yield* TestClock.adjust(5 * MINUTE);
          const { started, events } = yield* Fiber.join(run);
          assert.strictEqual(started, due + expected);
          assert.lengthOf(events, 1);
        }).pipe(Effect.provide(KinEventQueue.layer));
        const [count] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_wakeups`;
        assert.strictEqual(count?.n, 1);
      } else {
        const run = yield* claim(queue, "page").pipe(
          Effect.timeoutOption(elapsed + expected + 2 * MINUTE),
          Effect.forkChild,
        );
        yield* TestClock.adjust(elapsed);
        if (activity === "continuous") {
          for (let offset = 2; offset < 60; offset += 5) {
            const at = due + offset * MINUTE;
            yield* TestClock.adjust(at - (yield* Clock.currentTimeMillis));
            yield* personWrites(2 + (offset - 2) / 5, at);
          }
        }
        yield* TestClock.adjust(due + expected - (yield* Clock.currentTimeMillis));
        yield* TestClock.adjust(2 * MINUTE);
        const result = yield* Fiber.join(run);
        assert(Option.isSome(result), "check-in claimed by deadline");
        const { started, events } = result.value;
        assert.strictEqual(started, due + expected);
        assert.lengthOf(events, 1);
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "a late start picks its minute inside the window; a catch-up after it fires at once",
    () =>
      Effect.gen(function* () {
        yield* seed;
        yield* record({
          key: "W-1",
          list: "work",
          title: "Invented site copy",
          dueAt: MONDAY - DAY,
        });
        const ends: Array<number> = [];
        for (let day = 0; day < 7; day++) {
          const opens = SLOT + day * DAY;
          // Something untold each day, so each day's check-in runs.
          yield* record({
            key: `W-${day + 10}`,
            list: "work",
            title: "Invented poster",
            dueAt: opens - HOUR,
          });
          // The host woke ten minutes into the window, inside T3's grace: the run starts late.
          const late = yield* checkIn(opens + 10 * MINUTE);
          if (late._tag !== "queued") return assert.fail("not queued");
          assert.isAtLeast(late.notBefore, opens + 10 * MINUTE);
          ends.push(late.notBefore - opens);
        }
        assert.isTrue(ends.every((minute) => minute <= 25 * MINUTE));
        yield* record({ key: "W-20", list: "work", title: "Invented card", dueAt: SLOT + 6 * DAY });
        // 17:25 on the owner's UTC clock: before his quiet hours, so nothing holds it.
        yield* companyClock("UTC", '{"from":"22:00","to":"08:00"}');
        // Noticed two hours late, after the window closed: at once, not a further offset.
        const caught = yield* checkIn(SLOT + 7 * DAY, nothingOutside, SLOT + 7 * DAY + 2 * HOUR);
        assert.strictEqual(
          caught._tag === "queued" ? caught.notBefore : 0,
          SLOT + 7 * DAY + 2 * HOUR,
        );
      }).pipe(Effect.provide(layer)),
  );

  // Monday 15:25 UTC opens the window; T3 has moved on to Tuesday unless a row says otherwise.
  it.each([
    { name: "twelve minutes in", now: SLOT + 12 * MINUTE, fires: true },
    { name: "past three hours", now: SLOT + 3 * HOUR, fires: false },
    { name: "before it opens", now: SLOT - MINUTE, fires: false },
    { name: "already ran today", now: SLOT + HOUR, lastRunAt: SLOT + MINUTE, fires: false },
    { name: "T3 still has it due", now: SLOT + 5 * MINUTE, nextRunAt: SLOT, fires: false },
    { name: "not a day it runs", now: SLOT + HOUR, weekdays: [2, 3], fires: false },
  ])("a slept-through check-in catches up only that day, once ($name)", (row) => {
    const opens = missedSlot(
      {
        timeOfDay: "15:25",
        weekdays: row.weekdays ?? [1, 2, 3, 4, 5],
        nextRunAt: row.nextRunAt ?? SLOT + DAY,
        lastRunAt: row.lastRunAt ?? SLOT - DAY,
      },
      row.now,
      "UTC",
    );
    assert.strictEqual(opens, row.fires ? SLOT : undefined);
  });

  it.effect("a fact someone has in hand brings no check-in, and is told once when it is back", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* record({
        key: "W-2",
        list: "work",
        title: "Invented brochure",
        ownerKind: "person",
        ownerId: mate,
        dueAt: MONDAY - DAY,
      });
      const [fact] = (yield* KinPulse.read({ orgId, at: SLOT, viewer: { _tag: "owner" } })).facts;
      if (fact === undefined) return assert.fail("no fact");
      yield* sql`INSERT INTO kin_pulse_facts (org_id, fact_key, sense, subject_record_id, scope_json,
          first_seen_at, last_seen_at, handled_by_kind, handled_by_id, handled_at, handled_until)
        VALUES (${orgId}, ${fact.key}, ${fact.sense}, ${fact.subject.recordId ?? null}, '{}',
          ${SLOT - HOUR}, ${SLOT - HOUR}, 'agent', ${chief}, ${SLOT - HOUR}, ${SLOT + 2 * DAY})`;
      assert.deepStrictEqual(yield* checkIn(SLOT), { _tag: "nothing_new" });
      const back = yield* checkIn(SLOT + 2 * DAY);
      assert.strictEqual(back._tag === "queued" ? back.facts : 0, 1);
      // Marked not a problem, it has no end: on its own it starts no check-in.
      yield* sql`UPDATE kin_pulse_facts SET handled_until = NULL WHERE fact_key = ${fact.key}`;
      yield* sql`DELETE FROM kin_pulse_told WHERE fact_key = ${fact.key}`;
      assert.deepStrictEqual(yield* checkIn(SLOT + 3 * DAY), { _tag: "nothing_new" });
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "a client set aside is told nothing while held, whatever moves, and once when it ends",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        yield* record({ key: "C-1", list: "clients", title: "Invented Foods" });
        // Due 12 days ago with a 10-day chase: overdue, and another interval passes on day 20.
        yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, state,
            owner_kind, owner_id, party_id, due_at, amount_minor, currency, fields_json,
            created_by_kind, created_by_id, origin_key, created_at, updated_at)
          VALUES (${orgId}, 'r-INV-9', 'invoices', 'INV-9', 'Invented site build', 'waiting',
            'agent', ${finance}, 'r-C-1', ${MONDAY - 12 * DAY}, 90000, 'EUR', '{}', 'person',
            ${owner}, 'origin-INV-9', ${MONDAY - 40 * DAY}, ${MONDAY - 40 * DAY})`;
        const told = (day: number) =>
          checkIn(SLOT + day * DAY).pipe(
            Effect.map((result) => (result._tag === "queued" ? result.facts : 0)),
          );
        // The invoice and the client's own quiet fact.
        assert.strictEqual(yield* told(0), 2);
        const hold = (agentId: KinAgentId, until: number) =>
          KinPulse.aside({
            orgId,
            at: SLOT + HOUR,
            viewer: { _tag: "owner" },
            by: { _tag: "agent", agentId },
            recordKey: "C-1",
            action: "set",
            until,
            note: null,
            holding: { _tag: "may", forPersonId: null, onWordOf: owner },
          });
        yield* hold(finance, SLOT + 30 * DAY);
        assert.strictEqual(yield* told(1), 0);
        // Another agent takes the hold over on the owner's word: nothing to tell.
        yield* hold(chief, SLOT + 30 * DAY);
        assert.strictEqual(yield* told(2), 0);
        // Day 20 since due, another chase interval, and still held: nothing.
        assert.strictEqual(yield* told(9), 0);
        // Its day comes: both told once, then not again.
        assert.strictEqual(yield* told(30), 2);
        assert.strictEqual(yield* told(31), 0);
        // Set aside again and lifted: told once more.
        yield* hold(finance, SLOT + 60 * DAY);
        assert.strictEqual(yield* told(32), 0);
        yield* KinPulse.aside({
          orgId,
          at: SLOT + 32 * DAY + HOUR,
          viewer: { _tag: "owner" },
          by: { _tag: "person", personId: owner },
          recordKey: "C-1",
          action: "lift",
          until: null,
          note: null,
          holding: { _tag: "may", forPersonId: null, onWordOf: null },
        });
        assert.strictEqual(yield* told(33), 2);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("a fact is told once; only a change, a failed turn or Run now tells it again", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const told = (key: string) =>
        sql<{ key: string }>`SELECT DISTINCT t.fact_key AS key FROM kin_pulse_told t
          JOIN kin_events e ON e.event_id = t.event_id WHERE e.dedupe_key = ${key}
          ORDER BY t.fact_key`.pipe(Effect.map((rows) => rows.map((row) => row.key)));
      yield* record({ key: "W-1", list: "work", title: "Invented site copy", dueAt: MONDAY - DAY });
      assert.strictEqual((yield* checkIn(SLOT))._tag, "queued");
      const [w1] = yield* told("checkin:checkin-afternoon:2026-11-16");
      assert.match(w1 ?? "", /W-1/);
      // The next day W-1 is still open and unchanged: no turn, so no "still" message.
      assert.deepStrictEqual(yield* checkIn(SLOT + DAY), { _tag: "nothing_new" });
      // The first slot fired again after a restart is still that slot's own event.
      assert.strictEqual((yield* checkIn(SLOT))._tag, "duplicate");
      // Run now is someone asking: it runs, with everything open.
      const asked = yield* queueCheckIn({
        orgId,
        agentId: chief,
        scheduleId: afternoon,
        title: "Afternoon check-in",
        what: "Afternoon check-in.",
        dueAt: SLOT + DAY,
        looseAt: null,
        manualId: "run-now-1",
        zone: "UTC",
        at: SLOT + DAY,
        outside: nothingOutside,
      });
      assert.strictEqual(asked._tag, "queued");
      assert.deepStrictEqual(yield* told("checkin:checkin-afternoon:run-now-1"), [w1]);
      // W-3 is new and told; Finance takes W-1 in hand until Friday, so it is not.
      yield* record({ key: "W-3", list: "work", title: "Invented menu", dueAt: MONDAY });
      yield* sql`INSERT INTO kin_pulse_facts (org_id, fact_key, sense, subject_record_id, scope_json,
          first_seen_at, last_seen_at, handled_by_kind, handled_by_id, handled_at, handled_until)
        VALUES (${orgId}, ${w1!}, 'task_late', 'r-W-1', '{}', ${SLOT}, ${SLOT}, 'agent', ${finance},
          ${SLOT + DAY}, ${SLOT + 4 * DAY})`;
      yield* sql`DELETE FROM kin_pulse_told WHERE fact_key = ${w1!}`;
      assert.strictEqual((yield* checkIn(SLOT + 2 * DAY))._tag, "queued");
      const wednesday = yield* told("checkin:checkin-afternoon:2026-11-18");
      assert.lengthOf(wednesday, 1);
      assert.notInclude(wednesday, w1);
      // A check-in whose turn failed told nothing: the next one tells it again.
      yield* sql`UPDATE kin_events SET state = 'failed'
        WHERE dedupe_key = 'checkin:checkin-afternoon:2026-11-18'`;
      assert.strictEqual((yield* checkIn(SLOT + 3 * DAY))._tag, "queued");
      assert.deepStrictEqual(yield* told("checkin:checkin-afternoon:2026-11-19"), wednesday);
      // Friday it is out of Finance's hands: told once more.
      assert.strictEqual((yield* checkIn(SLOT + 4 * DAY))._tag, "queued");
      assert.deepStrictEqual(yield* told("checkin:checkin-afternoon:2026-11-20"), [w1]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("on the weekly brief's day one page: the first brief carries the figures", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* record({ key: "W-1", list: "work", title: "Invented site copy", dueAt: MONDAY - DAY });
      yield* scheduleRow({ slug: "weekly", at: "09:00", days: [1] });
      const run = (scheduleId: string, at: number) =>
        queueCheckIn({
          orgId,
          agentId: chief,
          scheduleId: KinMemoryItemId.make(scheduleId),
          title: scheduleId,
          what: "Check-in.",
          dueAt: at,
          looseAt: null,
          zone: "UTC",
          at,
          outside: nothingOutside,
        });
      const figures = Effect.map(pulseEvents, (events) =>
        events
          .map((event) => [event.key, JSON.parse(event.json).checkIn.figures ?? false])
          .toSorted(([a], [b]) => String(a.slice(-10)).localeCompare(b.slice(-10))),
      );
      // The weekly brief first: it carries the figures, and the morning brief is folded into it.
      assert.strictEqual((yield* run("checkin-weekly", MONDAY + 9 * HOUR))._tag, "queued");
      yield* record({ key: "W-2", list: "work", title: "Invented flyer", dueAt: MONDAY + HOUR });
      assert.deepStrictEqual(yield* run("checkin-morning", MONDAY + 9 * HOUR + 30 * MINUTE), {
        _tag: "folded",
        into: "checkin-weekly",
      });
      // Settings says why: from the skipped slot until the company's day ends, and not before.
      const covered = (
        scheduleId: string,
        days: ReadonlyArray<number>,
        now: number,
        next: number,
      ) =>
        coveredToday({
          orgId,
          scheduleId,
          days,
          on: true,
          nextRunAt: DateTime.formatIso(DateTime.makeUnsafe(next)),
          zone: "UTC",
          now,
        });
      const everyDay = [0, 1, 2, 3, 4, 5, 6];
      const morningAt = MONDAY + 9 * HOUR + 30 * MINUTE;
      assert.isUndefined(yield* covered("checkin-morning", everyDay, morningAt - HOUR, morningAt));
      assert.strictEqual(
        yield* covered("checkin-morning", everyDay, morningAt + MINUTE, morningAt + DAY),
        "weekly",
      );
      assert.strictEqual(
        yield* covered("checkin-morning", everyDay, MONDAY + DAY - MINUTE, morningAt + DAY),
        "weekly",
      );
      assert.isUndefined(
        yield* covered("checkin-morning", everyDay, MONDAY + DAY, morningAt + DAY),
      );
      assert.isUndefined(
        yield* covered("checkin-weekly", [1], morningAt + MINUTE, MONDAY + 7 * DAY + 9 * HOUR),
      );
      assert.isUndefined(
        yield* covered("checkin-morning", [2, 3], morningAt + MINUTE, morningAt + DAY),
      );
      // Tuesday has no weekly brief: the morning brief runs, with no figures.
      assert.strictEqual((yield* run("checkin-morning", MONDAY + DAY + 9 * HOUR))._tag, "queued");
      // The next Monday the morning brief comes first: it carries them, and the weekly is folded.
      const next = MONDAY + 7 * DAY;
      assert.strictEqual((yield* run("checkin-morning", next + 8 * HOUR))._tag, "queued");
      assert.deepStrictEqual(yield* run("checkin-weekly", next + 9 * HOUR), {
        _tag: "folded",
        into: "checkin-morning",
      });
      assert.strictEqual(
        yield* covered("checkin-weekly", [1], next + 9 * HOUR + MINUTE, next + 7 * DAY + 9 * HOUR),
        "morning",
      );
      // The weekly brief switched off: that Monday's morning brief is a morning like any other.
      yield* sql`UPDATE kin_schedules SET pending_enabled = 0 WHERE schedule_id = 'checkin-weekly'`;
      assert.strictEqual((yield* run("checkin-morning", next + 7 * DAY + 8 * HOUR))._tag, "queued");
      // With the morning brief off on Mondays, the weekly comes by its own setting, with them.
      yield* sql`UPDATE kin_schedules SET pending_enabled = NULL WHERE schedule_id = 'checkin-weekly'`;
      assert.strictEqual((yield* run("checkin-weekly", next + 14 * DAY + 9 * HOUR))._tag, "queued");
      assert.deepStrictEqual(yield* figures, [
        ["checkin:checkin-weekly:2026-11-16", true],
        ["checkin:checkin-morning:2026-11-17", false],
        ["checkin:checkin-morning:2026-11-23", true],
        ["checkin:checkin-morning:2026-11-30", false],
        ["checkin:checkin-weekly:2026-12-07", true],
      ]);
      // A company in Tokyo on a UTC host: its Monday 07:00 morning is Sunday 22:00 here, its
      // Monday 09:15 weekly Monday 00:15. Its Monday is still one page.
      yield* companyClock("Asia/Tokyo");
      yield* sql`UPDATE scheduled_tasks SET schedule_json = json_set(schedule_json, '$.timeOfDay', '00:15')
        WHERE task_id = ${KinSchedules.scheduleTaskId(orgId, "checkin-weekly")}`;
      const tokyo = MONDAY + 28 * DAY;
      assert.strictEqual((yield* run("checkin-morning", tokyo - 2 * HOUR))._tag, "queued");
      assert.deepStrictEqual(yield* run("checkin-weekly", tokyo + 15 * MINUTE), {
        _tag: "folded",
        into: "checkin-morning",
      });
      assert.deepStrictEqual((yield* figures).at(-1), ["checkin:checkin-morning:2026-12-13", true]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "quiet evening and nonworking morning slots skip unless there is work due or news",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const run = (scheduleId: string, at: number, outside = nothingOutside) =>
          queueCheckIn({
            orgId,
            agentId: chief,
            scheduleId: KinMemoryItemId.make(scheduleId),
            title: scheduleId,
            what: "Check-in.",
            dueAt: at,
            looseAt: null,
            zone: "UTC",
            at,
            outside,
          });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE kin_people SET work_hours_json = '{"days":[0,1,2,4,5],"start":"09:00","end":"18:00"}'
        WHERE org_id = ${orgId} AND person_id = ${owner}`;
        // The owner's Wednesday is off, and Sunday is a working day.
        const TUESDAY = MONDAY + DAY;
        assert.deepStrictEqual(yield* run("checkin-afternoon", TUESDAY + 15 * HOUR), {
          _tag: "nothing_new",
        });
        assert.deepStrictEqual(yield* run("checkin-evening", TUESDAY + 18 * HOUR), {
          _tag: "nothing_new",
        });
        assert.deepStrictEqual(yield* run("checkin-morning", TUESDAY + DAY + 9 * HOUR), {
          _tag: "nothing_new",
        });
        assert.include(
          yield* run("checkin-evening", TUESDAY + DAY + 18 * HOUR, {
            lines: [mail("new", "Meera", "A change")],
            seen: [],
          }),
          { _tag: "queued", facts: 0, outside: 1 },
        );
        for (const [scheduleId, at] of [
          ["checkin-morning", TUESDAY + 9 * HOUR],
          ["checkin-morning", MONDAY + 6 * DAY + 9 * HOUR],
          ["checkin-weekly", MONDAY + 7 * DAY + 9 * HOUR],
        ] as const)
          assert.include(yield* run(scheduleId, at), { _tag: "queued", facts: 0, outside: 0 });
        assert.deepStrictEqual((yield* pulseEvents).map((event) => event.key).toSorted(), [
          "checkin:checkin-evening:2026-11-18",
          "checkin:checkin-morning:2026-11-17",
          "checkin:checkin-morning:2026-11-22",
          "checkin:checkin-weekly:2026-11-23",
        ]);
        const thursday = MONDAY + 3 * DAY;
        yield* record({
          key: "W-1",
          list: "work",
          title: "Invented launch",
          state: "doing",
          dueAt: thursday + 20 * HOUR,
          createdAt: thursday,
        });
        assert.include(yield* run("checkin-evening", thursday + 18 * HOUR), {
          _tag: "queued",
          facts: 0,
          outside: 0,
        });
        // An evening summary its owner's quiet hours would hold past midnight in the company's
        // zone isn't queued: 22:30 in Tokyo is 13:30 on this UTC host, and 08:00 there still today.
        yield* companyClock("Asia/Tokyo", '{"from":"22:00","to":"08:00"}');
        assert.deepStrictEqual(
          yield* run("checkin-evening", MONDAY + 4 * DAY + 13 * HOUR + 30 * MINUTE, {
            lines: [mail("late", "Dev", "Another change")],
            seen: [],
          }),
          { _tag: "past_its_day" },
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect("a deal imported today waits out the afternoon and evening for the next morning", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in, created_at)
        VALUES (${orgId}, 'deals', 'deals', 'DL', 1, 0)`;
      yield* record({
        key: "C-1",
        list: "clients",
        title: "Invented Tiles",
        origin: "import:b1:entry:row-0",
        createdAt: MONDAY + 10 * HOUR,
      });
      yield* record({
        key: "DL-1",
        list: "deals",
        title: "Invented showroom",
        partyId: "r-C-1",
        fields: '{"stage":"new"}',
        origin: "import:b1:entry:row-1",
        createdAt: MONDAY + 10 * HOUR,
      });
      const run = (scheduleId: string, at: number) =>
        queueCheckIn({
          orgId,
          agentId: chief,
          scheduleId: KinMemoryItemId.make(scheduleId),
          title: scheduleId,
          what: "Check-in.",
          dueAt: at,
          looseAt: null,
          zone: "UTC",
          at,
          outside: nothingOutside,
        });
      const read = yield* KinPulse.read({ orgId, at: SLOT, viewer: { _tag: "owner" } });
      assert.deepStrictEqual(
        read.facts.map((fact) => fact.sense),
        ["deal_no_next_step"],
      );
      assert.deepStrictEqual(yield* run("checkin-afternoon", SLOT), { _tag: "nothing_new" });
      assert.deepStrictEqual(yield* run("checkin-evening", MONDAY + 18 * HOUR), {
        _tag: "nothing_new",
      });
      assert.include(yield* run("checkin-morning", MONDAY + DAY + 9 * HOUR), { facts: 1 });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a check-in in the owner's quiet hours waits for 08:00; Run now never does", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* companyClock("UTC", '{"from":"22:00","to":"08:00"}');
      yield* record({ key: "W-1", list: "work", title: "Invented site copy", dueAt: MONDAY - DAY });
      const night = MONDAY + 23 * HOUR + 30 * MINUTE;
      const at = (scheduleId: string, manualId?: string) =>
        queueCheckIn({
          orgId,
          agentId: chief,
          scheduleId: KinMemoryItemId.make(scheduleId),
          title: scheduleId,
          what: "Check-in.",
          dueAt: night,
          looseAt: null,
          manualId,
          zone: "UTC",
          at: night,
          outside: nothingOutside,
        });
      const held = yield* at("checkin-late");
      assert.strictEqual(held._tag === "queued" ? held.notBefore : 0, MONDAY + DAY + 8 * HOUR);
      // Stored on the event: fired again after a restart, the same hold stands.
      const again = yield* at("checkin-late");
      assert.strictEqual(again._tag === "duplicate" ? again.notBefore : 0, MONDAY + DAY + 8 * HOUR);
      const asked = yield* at("checkin-late", "run-now-2");
      assert.strictEqual(asked._tag === "queued" ? asked.notBefore : 0, night);
      // Away until Friday: the week's morning briefs wait for them, and only the latest goes, with
      // what the earlier ones carried.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE kin_people SET away_until = '2026-11-20' WHERE person_id = ${owner}`;
      yield* record({ key: "W-2", list: "work", title: "Invented brochure", dueAt: MONDAY - DAY });
      const morning = (day: number, outside: OutsideRead = nothingOutside) =>
        queueCheckIn({
          orgId,
          agentId: chief,
          scheduleId: KinMemoryItemId.make("checkin-morning"),
          title: "Morning brief",
          what: "Check-in.",
          dueAt: MONDAY + day * DAY + 9 * HOUR,
          looseAt: null,
          zone: "UTC",
          at: MONDAY + day * DAY + 9 * HOUR,
          outside,
        });
      assert.include(
        yield* morning(1, { lines: [mail("m-1", "Zoya", "Invented brief")], seen: [] }),
        {
          _tag: "queued",
          facts: 1,
        },
      );
      assert.include(yield* morning(2), { _tag: "queued", facts: 2, outside: 1 });
      assert.include(yield* morning(3), { _tag: "queued", facts: 2, outside: 1 });
      const briefs = yield* sql<{ key: string; state: string }>`SELECT dedupe_key AS key, state
        FROM kin_events WHERE org_id = ${orgId} AND dedupe_key LIKE 'checkin:checkin-morning:%'
        ORDER BY dedupe_key`;
      assert.deepStrictEqual(briefs, [
        { key: "checkin:checkin-morning:2026-11-17", state: "expired" },
        { key: "checkin:checkin-morning:2026-11-18", state: "expired" },
        { key: "checkin:checkin-morning:2026-11-19", state: "queued" },
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("server lines in someone's quiet hours post once at 08:00, merged per chat", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* companyClock("UTC", '{"from":"22:00","to":"08:00"}');
      const posted: Array<{ messageId: string; body: string }> = [];
      const chat = {
        dismissArrival: () => Effect.die("No arrival note"),
        notice: (input: { readonly messageId: string; readonly body: string }) =>
          Effect.sync(() => {
            if (!posted.some((one) => one.messageId === input.messageId)) posted.push(input);
          }).pipe(Effect.as({} as never)),
      };
      const line = (body: string) =>
        holdIfQuiet({
          orgId,
          chatId: KinChatId.make("chat-cos"),
          personId: owner,
          kind: "memory",
          body,
          audience: "owner",
        });
      yield* TestClock.setTime(MONDAY + 15 * HOUR);
      assert.isFalse(yield* line("Invented daytime line."));
      yield* TestClock.setTime(MONDAY + 23 * HOUR);
      assert.isTrue(yield* line("Invented first night line."));
      yield* TestClock.setTime(MONDAY + DAY + 3 * HOUR);
      assert.isTrue(yield* line("Invented second night line."));
      assert.strictEqual(yield* deliverHeld(orgId, chat), 0);
      yield* TestClock.setTime(MONDAY + DAY + 8 * HOUR);
      assert.strictEqual(yield* deliverHeld(orgId, chat), 1);
      assert.strictEqual(yield* deliverHeld(orgId, chat), 0);
      assert.deepStrictEqual(
        posted.map((one) => one.body),
        ["Invented first night line.\n\nInvented second night line."],
      );
      // Kin asleep all day wakes in the next night: the line waits for that night's end.
      yield* TestClock.setTime(MONDAY + DAY + 23 * HOUR);
      assert.isTrue(yield* line("Invented third night line."));
      yield* TestClock.setTime(MONDAY + 2 * DAY + 23 * HOUR);
      assert.strictEqual(yield* deliverHeld(orgId, chat), 0);
      yield* TestClock.setTime(MONDAY + 3 * DAY + 8 * HOUR);
      assert.strictEqual(yield* deliverHeld(orgId, chat), 1);
      assert.lengthOf(posted, 2);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a check-in carries new outside lines, matched ones first, as metadata", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* record({ key: "C-1", list: "clients", title: "Lumen" });
      yield* record({
        key: "CT-1",
        list: "contacts",
        title: "Priya",
        partyId: "r-C-1",
        fields: '{"email":"priya@lumen.example"}',
      });
      // A contact's second address matches too; a main one another contact has stays theirs.
      yield* record({
        key: "CT-2",
        list: "contacts",
        title: "Ravi",
        partyId: "r-C-1",
        fields: JSON.stringify({
          email: "ravi@lumen.example",
          emails: ["ravi@lumen.example", "ravi.home@lumen.example", "priya@lumen.example"],
        }),
      });
      yield* addMailbox();
      yield* addMailbox("other-mail");
      const newsletter = outsideMail("t1:a", "Shop <news@shop.example>", "Weekend sale");
      const priya = outsideMail("t2:a", "Priya <Priya@lumen.example>", "Re: launch date");
      const ravi = outsideMail("t3:a", "Ravi <ravi.home@lumen.example>", "Re: launch date");
      const forged = outsideMail("t4:a", priya.who!, "New bank details", companyMail);
      const signIn = outsideMail(
        "t5:a",
        "security@identity.example",
        "Your verification code is 123456",
        companyMail,
      );
      const pending = outsideMail("t6:a", priya.who!, "Still in the feed", companyMail);
      yield* storeArrival(newsletter, "news@shop.example");
      yield* storeArrival(priya, "priya@lumen.example");
      yield* storeArrival(ravi, "ravi.home@lumen.example");
      yield* storeArrival(forged, "priya@lumen.example", {
        headers: { authResults: ["mx.example; dmarc=fail (p=reject) header.from=lumen.example"] },
      });
      yield* storeArrival(forged, "priya@lumen.example", {
        messageId: "older",
        receivedAt: SLOT - 2 * MINUTE,
      });
      yield* storeArrival(forged, "priya@lumen.example", {
        connectionId: "other-mail",
        receivedAt: SLOT,
      });
      yield* storeArrival(signIn, "security@identity.example");
      const result = yield* checkIn(
        SLOT,
        mailOutside([newsletter, priya, ravi, forged, signIn, pending]),
      );
      assert.strictEqual(result._tag, "queued");
      const [event] = yield* pulseEvents;
      const parsed = JSON.parse(event!.json);
      const marks = new Map<string, string | undefined>(
        parsed.outside.map((line: KinPulseOutsideLine) => [line.id, line.matched]),
      );
      expect
        .soft(marks.get(forged.id), "failed sender checks must not show as a contact")
        .toBe("This mail failed the sender checks for priya@lumen.example.");
      expect.soft(marks.get(signIn.id), "sign-in mail must not be raised").toBeUndefined();
      expect
        .soft(marks.get(pending.id), "mail not classified yet must not be raised")
        .toBeUndefined();
      assert.deepStrictEqual(
        [...marks.keys()],
        [priya.id, ravi.id, forged.id, newsletter.id, signIn.id, pending.id],
      );
      assert.strictEqual(marks.get(priya.id), "contact CT-1 Priya of client C-1 Lumen");
      assert.strictEqual(marks.get(ravi.id), "contact CT-2 Ravi of client C-1 Lumen");
      assert.isUndefined(marks.get(newsletter.id));
    }).pipe(Effect.provide(layer)),
  );

  it("a mail line carries its thread as the mail tools take it, under the key it always had", () => {
    const line = mailLine("Google", "hello@tidewater.example", {
      receivedBy: null,
      threadId: "ft6",
      date: "2026-11-16T09:01:00.000Z",
      from: "Accounts <accounts@tidewater.example>",
      subject: "Quote request",
    });
    assert.strictEqual(line.thread, "ft6");
    assert.strictEqual(line.id, "ft6:2026-11-16T09:01:00.000Z");
    // A deploy must not wake old mail again: the key stays what it was before `thread`.
    assert.strictEqual(outsideKey(line), "outside:03618093cf4ec14b06257416aa53c24d");
  });

  it.effect("a check-in past its cap counts the mail it leaves out, its held slots' too", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* record({ key: "C-1", list: "clients", title: "Tidewater Freight" });
      yield* record({
        key: "CT-1",
        list: "contacts",
        title: "Arjun",
        partyId: "r-C-1",
        fields: '{"email":"arjun@tidewater.example"}',
      });
      const many = (prefix: string, count: number) =>
        Array.from({ length: count }, (_, n) =>
          mail(`${prefix}${n}:a`, `Migration <noreply-${n}@tidewater.example>`, "Synced"),
        );
      const matched = ["q1:a", "q2:a", "q3:a"].map((id) =>
        outsideMail(id, "Arjun <arjun@tidewater.example>", "Urgent quote"),
      );
      yield* addMailbox();
      for (const line of matched) yield* storeArrival(line, "arjun@tidewater.example");
      const listed = Effect.fn("test.listed")(function* (day: string) {
        const events = yield* pulseEvents;
        const parsed = JSON.parse(events.find((event) => event.key.endsWith(day))!.json);
        return {
          ids: (parsed.outside ?? []).map((line: KinPulseOutsideLine) => line.id),
          notListed: parsed.outsideNotListed,
        };
      });
      assert.include(yield* checkIn(SLOT, mailOutside([...many("a", 67), ...matched], matched)), {
        _tag: "queued",
        outside: 60,
      });
      const first = yield* listed("afternoon:2026-11-16");
      assert.strictEqual(first.notListed, 10);
      assert.includeMembers(first.ids, ["q1:a", "q2:a", "q3:a"]);
      assert.include(yield* checkIn(SLOT + DAY, { lines: many("b", 60), seen: [] }), {
        outside: 60,
      });
      assert.isUndefined((yield* listed("afternoon:2026-11-17")).notListed);
      // Away until Friday: Wednesday's brief carries Tuesday's lines and what Tuesday's left out.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE kin_people SET away_until = '2026-11-20' WHERE person_id = ${owner}`;
      const morning = (day: number, lines: ReadonlyArray<KinPulseOutsideLine>) =>
        queueCheckIn({
          orgId,
          agentId: chief,
          scheduleId: KinMemoryItemId.make("checkin-morning"),
          title: "Morning brief",
          what: "Check-in.",
          dueAt: MONDAY + day * DAY + 9 * HOUR,
          looseAt: null,
          zone: "UTC",
          at: MONDAY + day * DAY + 9 * HOUR,
          outside: { lines, seen: [] },
        });
      yield* morning(1, many("c", 70));
      assert.strictEqual((yield* listed("morning:2026-11-17")).notListed, 10);
      yield* morning(2, many("d", 5));
      assert.strictEqual((yield* listed("morning:2026-11-18")).notListed, 15);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("mail naming an issued number is matched to that entry, only where one shows it", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in,
          created_at) VALUES (${orgId}, 'quotes', 'quotes', 'Q', 1, 0)`;
      yield* record({
        key: "INV-1",
        list: "invoices",
        title: "Retainer",
        state: "waiting",
        fields: '{"number":"INV/26-27/004"}',
      });
      yield* record({
        key: "INV-2",
        list: "invoices",
        title: "Audit",
        fields: '{"number":"2026-17"}',
      });
      yield* record({ key: "Q-1", list: "quotes", title: "Audit", fields: '{"number":"2026-17"}' });
      yield* addMailbox();
      const subjects = [
        ["Invoice INV/26-27/004", true],
        ["Re: Invoice INV/26-27/004 paid.", true],
        ["Re: INV-1 for the retainer", true],
        ["Invoice INV/26-27/0041", false],
        ["Invoice XINV/26-27/004", false],
        ["Invoice inv/26-27/004", false],
        // The invoice and the quote both show 2026-17: neither is guessed.
        ["Re: 2026-17", false],
      ] as const;
      const lines = subjects.map(([subject], index) =>
        outsideMail(`number-${index}:a`, "accounts@other.example", subject),
      );
      for (const line of lines) yield* storeArrival(line, "accounts@other.example");
      assert.include(yield* checkIn(SLOT, mailOutside(lines)), { _tag: "queued", outside: 7 });
      const [event] = yield* pulseEvents;
      assert.deepStrictEqual(
        JSON.parse(event!.json).outside.map((line: KinPulseOutsideLine) => [
          line.subject,
          line.matched ?? null,
        ]),
        subjects.map(([subject, matched]) => [
          subject,
          matched ? "names invoice INV/26-27/004 (INV-1)" : null,
        ]),
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("wakes once for a matching calendar change", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* record({ key: "C-1", list: "clients", title: "Tidewater Freight" });
      const calendar: KinPulseOutsideLine = {
        source: "calendar",
        connection: "Google",
        id: "evt_391:2026-11-16T10:41:00.000Z",
        at: "2026-11-16T10:41:00.000Z",
        who: null,
        subject: "Tidewater Freight launch",
        where: null,
      };
      assert.deepStrictEqual(
        yield* poll(
          orgId,
          SLOT,
          source([calendar, { ...calendar, id: "evt_392", subject: "Lunch" }]),
        ),
        [calendar.id],
      );
      assert.deepStrictEqual(yield* poll(orgId, SLOT + 3 * MINUTE, source([calendar])), []);
      const [event] = yield* pulseEvents;
      assert.strictEqual(event?.agent, chief);
      assert.deepStrictEqual(JSON.parse(event!.json).outside, [
        { ...calendar, matched: "client C-1 Tidewater Freight" },
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a check-in carries failed mail watches and skips completed ones", () =>
    Effect.gen(function* () {
      yield* seed;
      const done = mail("thread_391:a", "Zoya <zoya@tidewater.example>", "Launch date");
      const failed = mail("thread_392:a", "Arjun <arjun@juniper.example>", "Delivery schedule");
      yield* wakeMatches(orgId, SLOT, [
        { line: done, domain: "chief", arrivalId: "arr_35175a463fe31728ae445d624f622185" },
        { line: failed, domain: "chief", arrivalId: "arr_115ffc8c4421235ffc6213f643f7590a" },
      ]);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, model, started_at,
          ended_at, status, event_ids)
        VALUES ('mail-wake', ${orgId}, ${chief}, 'replay', ${SLOT}, ${SLOT + MINUTE},
          'completed', '[]')`;
      yield* sql`UPDATE kin_events SET state = 'done', wakeup_id = 'mail-wake'
        WHERE org_id = ${orgId} AND dedupe_key = ${outsideKey(done)}`;
      yield* sql`UPDATE kin_events SET state = 'failed'
        WHERE org_id = ${orgId} AND dedupe_key = ${outsideKey(failed)}`;
      const outside = { lines: [done, failed], seen: [] };
      assert.include(yield* checkIn(SLOT + 5 * MINUTE, outside), { _tag: "queued", outside: 1 });
      const checkInEvent = (yield* pulseEvents).find((event) => event.key.startsWith("checkin:"))!;
      assert.deepStrictEqual(JSON.parse(checkInEvent.json).outside, [failed]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "one nudge per person per working day, held until their hours, none while unanswered",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        yield* record({
          key: "W-8",
          list: "work",
          title: "Invented banner",
          ownerKind: "person",
          ownerId: mate,
          dueAt: MONDAY - 2 * DAY,
        });
        const posted: Array<readonly [string, number | undefined]> = [];
        const send = (at: number, factKey: string, person = "Meera") =>
          nudge({
            orgId,
            agentId: chief,
            at,
            person,
            factKey,
            text: "W-8 was due Saturday; the launch waits on it. Still on for today?",
            chatFor: () => Effect.succeed(KinChatId.make("chat-mate")),
            post: (_chatId, clientMessageId, _personId, notBefore) =>
              Effect.sync(() => {
                posted.push([clientMessageId, notBefore]);
                return undefined;
              }),
          }).pipe(
            Effect.as("sent"),
            Effect.catchTags({ KinChatError: (error) => Effect.succeed(error.message) }),
          );
        const { facts } = yield* KinPulse.read({
          orgId,
          at: MONDAY + 10 * HOUR,
          viewer: { _tag: "people", people: [mate] },
        });
        const factKey = facts.find((fact) => fact.subject.key === "W-8")!.key;
        // Before their hours it is taken and held until they start, as that day's nudge.
        assert.strictEqual(yield* send(MONDAY + 7 * HOUR, factKey), "sent");
        assert.isAbove(posted[0]![1]!, MONDAY + 7 * HOUR);
        assert.include(yield* send(MONDAY + 10 * HOUR, "task_late:nope"), "can't see that fact");
        // Found as clients are: any case, a start of the name, a close spelling, the handle.
        for (const typed of ["meera", "Mee", "Meeru", "@mate"])
          assert.include(yield* send(MONDAY + 10 * HOUR, "task_late:nope", typed), "can't see");
        assert.include(
          yield* send(MONDAY + 10 * HOUR, factKey, "Meena Rao"),
          "No one called Meena Rao",
        );
        assert.include(yield* send(MONDAY + 10 * HOUR, factKey), "already nudged today");
        assert.include(yield* send(MONDAY + DAY + 10 * HOUR, factKey), "hasn't answered");
        yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
        VALUES ('chat-mate', ${orgId}, 'direct', ${`${mate}:${chief}`}, 0, ${stamp})`;
        yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id,
          role, joined_at)
        VALUES ('m-mate', ${orgId}, 'chat-mate', 'person', ${mate}, 'member', ${stamp})`;
        // A request of theirs Kin passed on into this chat is no answer to the nudge.
        yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind,
          author_person_id, author_member_id, author_role, kind, body, mentions_json, status,
          created_at, origin_json)
        VALUES ('copy', ${orgId}, 'chat-mate', 1, 'human', ${mate}, 'm-mate', 'member', 'text',
          'Can Finance send it?', '[]', 'posted', '2026-11-16T11:00:00.000Z',
          '{"messageId":"asked","chatId":"chat-elsewhere"}')`;
        assert.include(yield* send(MONDAY + DAY + 10 * HOUR, factKey), "hasn't answered");
        yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind,
          author_person_id, author_member_id, author_role, kind, body, mentions_json, status,
          created_at)
        VALUES ('reply', ${orgId}, 'chat-mate', 2, 'human', ${mate}, 'm-mate', 'member', 'text',
          'On it', '[]', 'posted', '2026-11-16T12:00:00.000Z')`;
        assert.strictEqual(yield* send(MONDAY + DAY + 10 * HOUR, factKey), "sent");
        assert.deepStrictEqual(posted.slice(1), [["pulse-nudge:mate:2026-11-17", undefined]]);
        assert.strictEqual(posted[0]![0], "pulse-nudge:mate:2026-11-16");
      }).pipe(Effect.provide(layer)),
  );

  it("a person's own hours decide, in their zone or else the owner's, not the quiet hours", () => {
    // 22:30 in Kolkata on a Sunday: inside Dev's 10:00–23:59 every day, though past 21:00.
    const late = Date.UTC(2026, 10, 15, 17, 0);
    const dev = {
      timeZone: null,
      workHours: '{"days":[0,1,2,3,4,5,6],"start":"10:00","end":"23:59"}',
    };
    assert.isTrue(inHoursAt(dev, "Asia/Kolkata", late));
    assert.isFalse(inHoursAt({ timeZone: null, workHours: null }, "Asia/Kolkata", late));
    // A whole-day row stored before it meant "not set" reads as no hours, not as always working.
    const wholeDay = '{"days":[0,1,2,3,4,5,6],"start":"00:00","end":"23:59"}';
    assert.isFalse(inHoursAt({ timeZone: null, workHours: wholeDay }, "Asia/Kolkata", late));
    assert.isFalse(
      inHoursAt({ ...dev, timeZone: "Europe/London" }, "Asia/Kolkata", late - 9 * HOUR),
    );
    // An owner on nights, Monday to Friday 22:00 to 06:00 in Kolkata, as a missed check-in reads
    // them: Tuesday 02:00, Tuesday 12:00, Friday 23:00, Saturday 03:00, Saturday 23:00.
    const nights = {
      timeZone: "Asia/Kolkata",
      workHours: '{"days":[1,2,3,4,5],"start":"22:00","end":"06:00"}',
    };
    assert.deepStrictEqual(
      [
        Date.UTC(2026, 10, 16, 20, 30),
        Date.UTC(2026, 10, 17, 6, 30),
        Date.UTC(2026, 10, 20, 17, 30),
        Date.UTC(2026, 10, 20, 21, 30),
        Date.UTC(2026, 10, 21, 17, 30),
      ].map((moment) => inHoursAt(nights, "Europe/London", moment)),
      [true, false, true, true, false],
    );
  });

  it("seeded times move to the host clock, and their days with them across midnight", () => {
    const monday = Date.UTC(2026, 10, 16);
    assert.deepStrictEqual(onHostClock("09:30", [1, 2], "Asia/Kolkata", "UTC", monday), {
      at: "04:00",
      days: [1, 2],
    });
    assert.deepStrictEqual(onHostClock("02:00", [1], "Asia/Kolkata", "UTC", monday), {
      at: "20:30",
      days: [0],
    });
  });
  // G08: check-ins seeded while the zone was unset stayed on that clock after it was set. The
  // zones span the globe, so on any host some lie more than half a day from it.
  it.effect.each([
    "Pacific/Honolulu",
    "Pacific/Kiritimati",
    "Pacific/Pago_Pago",
    "Pacific/Auckland",
    "America/Los_Angeles",
    "UTC",
  ])(
    "default check-ins follow the owner's zone once set; one he moved stays put (from %s)",
    (from) =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        yield* TestClock.setTime(MONDAY);
        const host = KinSchedules.hostTimeZone();
        const weekdays = [1, 2, 3, 4, 5];
        const seededAt = (zone: string) => onHostClock("09:30", weekdays, zone, host, MONDAY);
        // A loose check-in's native task starts its window five minutes early.
        const fiveBefore = (at: string) => {
          const minutes = Math.max(0, Number(at.slice(0, 2)) * 60 + Number(at.slice(3)) - 5);
          return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
        };
        for (const [slug, source, at] of [
          ["morning", `kin-seed:check-ins:${orgId}`, seededAt(from)],
          ["afternoon", "chat-event", seededAt(from)],
        ] as const) {
          const taskId = KinSchedules.scheduleTaskId(orgId, `checkin-${slug}`);
          yield* sql`INSERT INTO scheduled_tasks (task_id, title, prompt, enabled, schedule_json,
            project_id, workspace_strategy_json, model_selection_json, runtime_mode,
            interaction_mode, created_by, creation_source, created_at, updated_at,
            last_run_status, run_count)
          VALUES (${taskId}, ${slug}, 'Check in', 1, ${JSON.stringify({
            type: "fixed_time",
            timeOfDay: fiveBefore(at.at),
            weekdays: at.days,
          })}, 'project', '{}', '{}', 'approval-required', 'plan', 'system', 'server', ${stamp},
            ${stamp}, 'never', 0)`;
          yield* sql`INSERT INTO kin_schedules (task_id, org_id, schedule_id, agent_id, chat_id,
            source_event, said_by, audience, content_sha256, inbox_thread_id, created_at,
            updated_at, loose_at, check_in)
          VALUES (${taskId}, ${orgId}, ${`checkin-${slug}`}, ${chief}, ${`chat-${chief}`},
            ${source}, ${owner}, 'owner_only', 'hash', 'inbox', 0, 0, ${at.at}, 1)`;
        }
        yield* companyClock("Europe/London");
        const saved: Array<KinSchedules.SaveInput> = [];
        const schedules = KinSchedules.KinSchedules.of({
          save: (input) => Effect.sync(() => void saved.push(input)),
          cancel: () => Effect.void,
          applyTaps: () => Effect.void,
        });
        yield* followOwnerZone(orgId, schedules);
        assert.deepStrictEqual(
          saved.map(({ scheduleId, every, existing, around }) => ({
            scheduleId,
            every,
            existing,
            around,
          })),
          [
            {
              scheduleId: KinMemoryItemId.make("checkin-morning"),
              // The morning brief's default is every day: one seeded on weekdays gets the weekend too.
              every: onHostClock("09:30", [0, 1, 2, 3, 4, 5, 6], "Europe/London", host, MONDAY),
              existing: true,
              around: true,
            },
          ],
        );
        assert.isTrue(saved.every((input) => input.keepWording === true));
      }).pipe(Effect.provide(layer)),
  );
  it.effect(
    "a check-in set in Settings or in chat keeps the owner's time across a clock change",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        yield* companyClock("America/New_York");
        using _hostClock = vi.spyOn(KinSchedules, "hostTimeZone").mockReturnValue("UTC");
        const weekdays = [1, 2, 3, 4, 5];
        const JULY = Date.UTC(2026, 6, 13);
        const DECEMBER = Date.UTC(2026, 11, 14);
        // Set at 09:00 his time in July, in Settings or in chat; "moved" was changed on T3's screen since.
        const july = { at: "13:00", days: weekdays };
        for (const slug of ["mine", "moved", "said"]) {
          const at = slug === "moved" ? { ...july, at: "11:00" } : july;
          const source = slug === "said" ? "chat-event" : "kin-settings:check-ins";
          yield* scheduleRow({ slug, at: at.at, days: at.days, source });
          yield* sql`UPDATE kin_schedules SET owner_time_json = ${JSON.stringify({
            at: "09:00",
            days: weekdays,
            host: july,
          })} WHERE schedule_id = ${`checkin-${slug}`}`;
        }
        const saved: Array<KinSchedules.SaveInput> = [];
        const schedules = KinSchedules.KinSchedules.of({
          save: (input) => Effect.sync(() => void saved.push(input)),
          cancel: () => Effect.void,
          applyTaps: () => Effect.void,
        });
        yield* TestClock.setTime(JULY);
        yield* followOwnerZone(orgId, schedules);
        assert.deepStrictEqual(saved, []);
        yield* TestClock.setTime(DECEMBER);
        yield* followOwnerZone(orgId, schedules);
        assert.deepStrictEqual(
          saved
            .map(({ scheduleId, every, ownerTime, keepWording }) => ({
              scheduleId,
              every,
              ownerTime,
              keepWording,
            }))
            .toSorted((a, b) => a.scheduleId.localeCompare(b.scheduleId)),
          ["checkin-mine", "checkin-said"].map((scheduleId) => ({
            scheduleId: KinMemoryItemId.make(scheduleId),
            every: { at: "14:00", days: weekdays },
            ownerTime: { at: "09:00", days: weekdays },
            keepWording: true,
          })),
        );
      }).pipe(Effect.provide(layer)),
  );
  it.effect.each([
    { name: "Friday taken off", days: [1, 2, 3, 4] },
    // Like the weekdays a day earlier, as a host clock could put them, but not so here.
    { name: "Sunday to Thursday", days: [0, 1, 2, 3, 4] },
  ])("a default morning whose days alone were changed keeps them at rollout ($name)", (row) =>
    Effect.gen(function* () {
      yield* seed;
      yield* TestClock.setTime(MONDAY);
      const host = KinSchedules.hostTimeZone();
      // Seeded on weekdays at 09:30 in the company's zone, then its days changed on T3's screen.
      const at = onHostClock("09:30", row.days, "UTC", host, MONDAY);
      const fiveBefore = onHostClock("09:25", row.days, "UTC", host, MONDAY);
      yield* scheduleRow({ slug: "morning", at: fiveBefore.at, days: at.days, looseAt: at.at });
      const saved: Array<KinSchedules.SaveInput> = [];
      yield* followOwnerZone(
        orgId,
        KinSchedules.KinSchedules.of({
          save: (input) => Effect.sync(() => void saved.push(input)),
          cancel: () => Effect.void,
          applyTaps: () => Effect.void,
        }),
      );
      assert.deepStrictEqual(saved, []);
    }).pipe(Effect.provide(layer)),
  );
});
