import { assert, describe, it } from "@effect/vitest";
import {
  KinAgentId,
  KinChatId,
  KinEvent,
  KinEventId,
  KinMemberId,
  KinOrgId,
  KinPersonId,
  KinWakeupId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../../persistence/Sqlite.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import { endOfDay } from "../work/recordRows.ts";
import * as KinEventQueue from "./KinEventQueue.ts";

const decodeEvent = Schema.decodeUnknownEffect(KinEvent);
const decodeEventJson = Schema.decodeEffect(Schema.fromJsonString(KinEvent));

const database = Layer.provideMerge(KinPersistence.layer, Sqlite.layerMemory);
const layer = KinEventQueue.layer.pipe(Layer.provideMerge(database));

const seed = Effect.fn("test.seed")(function* (org = "a", agent = `lead-${org}`) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_orgs VALUES (${org}, 'Kin', '2026-11-07T00:00:00.000Z') ON CONFLICT DO NOTHING`;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
    VALUES (${`person-${agent}`}, ${org}, ${agent}, 'Owner', '2026-11-07T00:00:00.000Z')`;
  yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
    VALUES (${agent}, ${org}, 'Lead', 'lead', ${`person-${agent}`}, '2026-11-07T00:00:00.000Z')`;
  yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at)
    VALUES (${`chat-${agent}`}, ${org}, 'team_group', 0, '2026-11-07T00:00:00.000Z')`;
  yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
    VALUES (${`member-${agent}`}, ${org}, ${`chat-${agent}`}, 'person', ${`person-${agent}`}, 'owner', '2026-11-07T00:00:00.000Z')`;
  yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, agent_id, role, joined_at)
    VALUES (${`agent-member-${agent}`}, ${org}, ${`chat-${agent}`}, 'agent', ${agent}, 'member', '2026-11-07T00:00:00.000Z')`;
  yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id)
    VALUES (${agent}, ${org}, 'Lead', 0, '{}', '[]', ${`chat-${agent}`})`;
});

const event = Effect.fn("test.event")(function* (
  id: string,
  tag = "github",
  org = "a",
  agent = `lead-${org}`,
) {
  const now = yield* Clock.currentTimeMillis;
  return yield* decodeEvent({
    _tag: tag,
    eventId: id,
    orgId: org,
    agentId: agent,
    receivedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
    dedupeKey: tag === "github" ? null : id,
    provenance:
      tag === "chat.message" || tag === "widget.action"
        ? { _tag: "human", personId: `person-${agent}`, memberId: `member-${agent}` }
        : { _tag: "system" },
    deliveryId: `delivery-${id}`,
    eventName: "push",
    repo: "GLDRoger/t3code",
    summary: "Push",
    scheduledTaskId: "task",
    webhookDeliveryId: id,
    chatId: `chat-${agent}`,
    messageId: id,
    actionId: id,
    pendingActionId: id,
    outcome: "executed",
    finding: "Check",
    itemIds: [],
    routine: "owner_check",
    pausedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
    expired: { count: 0, events: [] },
    subject: { type: "reminder", itemId: "reminder" },
    lateByMs: 0,
    recordId: id,
    key: "W-1",
    seq: 1,
    reason: "assigned",
  });
});

const input = (wakeupId: string, org = "a", agent = `lead-${org}`) => ({
  orgId: KinOrgId.make(org),
  agentId: KinAgentId.make(agent),
  wakeupId: KinWakeupId.make(wakeupId),
  model: "test-model",
});

const finish = Effect.fn("test.finish")(function* (wakeupId: string, org = "a") {
  const queue = yield* KinEventQueue.KinEventQueue;
  yield* queue.finish({
    orgId: KinOrgId.make(org),
    wakeupId: KinWakeupId.make(wakeupId),
    status: "completed",
  });
});

/** The stored post behind a chat event: steering reads its author from here, never the event. */
const stored = Effect.fn("test.stored")(function* (
  id: string,
  chatId: string,
  personId = "person-lead-a",
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
    SELECT ${`${chatId}-${personId}`}, 'a', ${chatId}, 'person', ${personId}, 'member', '2026-11-07T00:00:00.000Z'
    WHERE NOT EXISTS (SELECT 1 FROM kin_chat_members WHERE chat_id = ${chatId} AND person_id = ${personId})`;
  yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind,
      author_person_id, author_member_id, author_role, kind, body, mentions_json, status, created_at)
    VALUES (${id}, 'a', ${chatId},
      (SELECT COALESCE(MAX(seq), 0) + 1 FROM kin_messages WHERE chat_id = ${chatId}), 'human',
      ${personId}, (SELECT member_id FROM kin_chat_members WHERE chat_id = ${chatId} AND person_id = ${personId}),
      'member', 'text', 'Invented', '[]', 'posted', '2026-11-07T00:00:00.000Z')`;
});

const ONE_MINUTE = 60_000;
// Midnight after New York's 23-hour day (Sunday 8 March 2026) is 04:00 UTC.
const SHORT_DAY_ENDS = Date.UTC(2026, 2, 9, 4) - 1;
// An evening's last millisecond near the test clock's start: a jump to 2026 costs seconds.
const DAY_ENDS = 180 * ONE_MINUTE - 1;

/** A person's own post at the clock's time: a text, or the row a card tap stores. */
const ownerPosts = Effect.fn("test.ownerPosts")(function* (
  id: string,
  kind: "text" | "widget_action",
  chatId = "chat-lead-a",
  personId = "person-lead-a",
) {
  const sql = yield* SqlClient.SqlClient;
  yield* stored(id, chatId, personId);
  const at = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
  yield* sql`UPDATE kin_messages SET kind = ${kind}, created_at = ${at} WHERE message_id = ${id}`;
});

/** lead-a's check-in held for a pause from `due`, while another lane's turn ("busy") runs. */
const holdCheckIn = Effect.fn("test.holdCheckIn")(function* (page: {
  readonly due: number;
  readonly until: number;
  readonly dayEndsAt?: number;
}) {
  const queue = yield* KinEventQueue.KinEventQueue;
  const sql = yield* SqlClient.SqlClient;
  const scheduleId = page.dayEndsAt === undefined ? "checkin-morning" : "checkin-evening";
  const pulse = {
    _tag: "pulse",
    orgId: "a",
    agentId: "lead-a",
    receivedAt: DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
    provenance: { _tag: "system" },
  };
  yield* queue.enqueue(
    yield* decodeEvent({
      ...pulse,
      eventId: "checkin",
      dedupeKey: `checkin:${scheduleId}:2026-11-01`,
      factKeys: [],
      checkIn: { scheduleId, title: "Check-in", what: "Look.", slot: "s" },
    }),
    {
      notBefore: page.due,
      checkInPause: {
        until: page.until,
        ...(page.dayEndsAt === undefined ? {} : { dayEndsAt: page.dayEndsAt }),
      },
    },
  );
  yield* queue.enqueue(
    yield* decodeEvent({
      ...pulse,
      eventId: "prepare",
      dedupeKey: "prepare",
      factKeys: ["quote_unanswered:one:last=1"],
    }),
  );
  yield* TestClock.adjust("20 seconds");
  assert.deepStrictEqual(
    (yield* Effect.scoped(queue.claim(input("busy")))).map((entry) => entry.eventId),
    ["prepare"],
  );
  yield* sql`UPDATE kin_wakeups SET run_id = 'run' WHERE wakeup_id = 'busy'`;
});

/** The next claim and when it returned; every claim here is ready within two seconds. */
const claimAt = Effect.fn("test.claimAt")(function* (wakeupId: string) {
  const queue = yield* KinEventQueue.KinEventQueue;
  const run = yield* Effect.scoped(queue.claim(input(wakeupId))).pipe(
    Effect.flatMap((events) =>
      Clock.currentTimeMillis.pipe(
        Effect.map((at) => ({ at, ids: events.map((entry) => entry.eventId) })),
      ),
    ),
    Effect.forkChild,
  );
  yield* TestClock.adjust("2 seconds");
  return yield* Fiber.join(run);
});

describe("KinEventQueue", () => {
  it.effect("coalesces a quiet window and leaves later arrivals for a new batch", () =>
    Effect.gen(function* () {
      yield* seed();
      const queue = yield* KinEventQueue.KinEventQueue;
      const sql = yield* SqlClient.SqlClient;
      for (const agentId of ["unknown", "foreign-lead"]) {
        const error = yield* queue
          .enqueue({ ...(yield* event("missing")), agentId: KinAgentId.make(agentId) })
          .pipe(Effect.flip);
        assert.strictEqual(error._tag, "KinEventQueueUnknownAgent");
      }
      yield* queue.enqueue({
        ...(yield* event("first")),
        receivedAt: DateTime.makeUnsafe(-600_000),
      });
      const first = yield* Effect.scoped(queue.claim(input("first-batch"))).pipe(Effect.forkChild);
      yield* TestClock.adjust("10 seconds");
      yield* queue.enqueue(yield* event("second"));
      yield* TestClock.adjust("10 seconds");
      assert.deepStrictEqual(yield* sql`SELECT * FROM kin_wakeups`, []);
      yield* TestClock.adjust("10 seconds");
      assert.deepStrictEqual(
        (yield* Fiber.join(first)).map((entry) => entry.eventId),
        ["first", "second"],
      );
      yield* finish("first-batch");
      yield* queue.enqueue(yield* event("colliding"));
      yield* TestClock.adjust("20 seconds");
      const collision = yield* Effect.scoped(queue.claim(input("first-batch"))).pipe(Effect.flip);
      assert.strictEqual(collision._tag, "KinEventQueueWakeupConflict");
      yield* sql`UPDATE kin_events SET state = 'expired' WHERE event_id = 'colliding'`;
      yield* queue.enqueue(yield* event("later"));
      const second = yield* Effect.scoped(queue.claim(input("second-batch"))).pipe(
        Effect.forkChild,
      );
      yield* TestClock.adjust("20 seconds");
      assert.deepStrictEqual(
        (yield* Fiber.join(second)).map((entry) => entry.eventId),
        ["later"],
      );
      assert.deepStrictEqual(yield* sql`SELECT event_ids FROM kin_wakeups ORDER BY started_at`, [
        { event_ids: '["first","second"]' },
        { event_ids: '["later"]' },
      ]);
      yield* finish("second-batch");
      // F52: 22 tasks from one bulk paste, a couple of seconds apart, wake the lead once.
      const tasks = Array.from({ length: 22 }, (_, n) => `task-${n}`);
      const bulk = yield* Effect.scoped(queue.claim(input("bulk"))).pipe(Effect.forkChild);
      for (const id of tasks) {
        yield* queue.enqueue(yield* event(id, "record.changed"));
        yield* TestClock.adjust("2 seconds");
      }
      yield* TestClock.adjust("20 seconds");
      assert.deepStrictEqual(
        (yield* Fiber.join(bulk)).map((entry) => entry.eventId),
        tasks,
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "cuts the window short for owner events and orders every priority from trusted provenance",
    () =>
      Effect.gen(function* () {
        yield* seed();
        const queue = yield* KinEventQueue.KinEventQueue;
        const sql = yield* SqlClient.SqlClient;
        for (const [id, tag] of [
          ["watch", "watchdog"],
          ["github", "github"],
          ["routine", "routine"],
          ["due", "deferral.due"],
          ["resolved", "action.resolved"],
        ])
          yield* queue.enqueue(yield* event(id!, tag!));
        const batch = yield* Effect.scoped(queue.claim(input("priority"))).pipe(Effect.forkChild);
        yield* TestClock.adjust("1 second");
        yield* queue.enqueue(yield* event("chat.message", "chat.message"));
        yield* TestClock.adjust("200 millis");
        for (const tag of ["widget.action", "resume"]) yield* queue.enqueue(yield* event(tag, tag));
        yield* TestClock.adjust("200 millis");
        yield* queue.enqueue(yield* event("noisy"));
        // An owner message waits only until its burst has been quiet for 300 ms.
        yield* TestClock.adjust("299 millis");
        assert.deepStrictEqual(yield* sql`SELECT * FROM kin_wakeups`, []);
        yield* TestClock.adjust("1 millis");
        const events = yield* Fiber.join(batch);
        assert.deepStrictEqual(
          yield* sql`SELECT started_at - enqueued_at AS waited FROM kin_wakeups
            WHERE org_id = 'a' AND wakeup_id = 'priority' ORDER BY wakeup_id`,
          [{ waited: 1_700 }],
        );
        assert.deepStrictEqual(
          events.map((entry) => entry.eventId),
          [
            "chat.message",
            "resume",
            "widget.action",
            "due",
            "resolved",
            "github",
            "noisy",
            "routine",
            "watch",
          ],
        );
        assert.equal(events.find((entry) => entry.eventId === "routine")?.priority, "P3");
        yield* finish("priority");
        // A member's own words wait their turn; an owner-level person's would not.
        yield* sql`UPDATE kin_chat_members SET role = 'member'`;
        yield* sql`UPDATE kin_people SET access = 'member' WHERE person_id = 'person-lead-a'`;
        yield* queue.enqueue(yield* event("member", "chat.message"));
        // Their turn in the budget, not the machine window: a person's words start as an owner's do.
        const said = yield* Effect.scoped(queue.claim(input("member-said"))).pipe(Effect.forkChild);
        yield* TestClock.adjust("299 millis");
        assert.deepStrictEqual(
          yield* sql`SELECT 1 FROM kin_wakeups WHERE wakeup_id = 'member-said'`,
          [],
        );
        yield* TestClock.adjust("1 millis");
        assert.deepStrictEqual(
          (yield* Fiber.join(said)).map((entry) => [entry.eventId, entry.priority]),
          [["member", "P2"]],
        );
        yield* finish("member-said");
        const forged = yield* event("forged", "widget.action", "a", "other");
        yield* queue.enqueue({
          ...forged,
          agentId: KinAgentId.make("lead-a"),
        });
        assert.deepStrictEqual(
          yield* sql`SELECT priority FROM kin_events WHERE state = 'queued' ORDER BY event_id`,
          [{ priority: "P2" }],
        );
        yield* sql`UPDATE kin_people SET access = NULL WHERE person_id = 'person-lead-a'`;
        yield* seed("a", "lead-a2");
        yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
          VALUES ('group-owner', 'a', 'chat-lead-a', 'person', 'person-lead-a2', 'owner', '2026-11-07T00:00:00.000Z')`;
        const owner = yield* event("owner", "chat.message");
        for (const [id, role, personLeft, agentLeft] of [
          ["guest", "guest", false, false],
          ["member-again", "member", false, false],
          ["left", "owner", true, false],
          ["lead-left", "owner", false, true],
          ["retired", "owner", false, false],
        ] as const) {
          yield* sql`UPDATE kin_chat_members SET left_at = ${role === "owner" && !personLeft ? "2026-11-07T00:00:00.000Z" : null} WHERE member_id = 'group-owner'`;
          yield* sql`UPDATE kin_chat_members SET role = ${role}, left_at = ${personLeft ? "2026-11-07T00:00:00.000Z" : null}
            WHERE member_id = 'member-lead-a'`;
          yield* sql`UPDATE kin_chat_members SET left_at = ${agentLeft ? "2026-11-07T00:00:00.000Z" : null}
            WHERE member_id = 'agent-member-lead-a'`;
          yield* sql`UPDATE kin_agents SET retired_at = ${id === "retired" ? "2026-11-07T00:00:00.000Z" : null}
            WHERE agent_id = 'lead-a'`;
          const enqueue = queue.enqueue({ ...owner, eventId: KinEventId.make(id), dedupeKey: id });
          if (id === "retired")
            assert.strictEqual(
              (yield* enqueue.pipe(Effect.flip))._tag,
              "KinEventQueueRetiredAgent",
            );
          else yield* enqueue;
        }
        yield* sql`UPDATE kin_agents SET retired_at = NULL WHERE agent_id = 'lead-a'`;
        yield* sql`UPDATE kin_chat_members SET left_at = NULL WHERE member_id = 'agent-member-lead-a'`;
        yield* sql`UPDATE kin_chat_members SET role = 'member' WHERE member_id IN ('member-lead-a', 'member-lead-a2')`;
        yield* sql`UPDATE kin_chat_members SET left_at = NULL WHERE member_id = 'group-owner'`;
        yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
          VALUES ('owner-other-chat', 'a', 'chat-lead-a2', 'person', 'person-lead-a', 'owner', '2026-11-07T00:00:00.000Z')`;
        // Owning another lead is not the owner's level: only the stored kind is.
        yield* sql`UPDATE kin_people SET access = 'member'`;
        for (const [id, chatId, memberId, personId] of [
          ["group-owner", "chat-lead-a", "group-owner", "person-lead-a2"],
          ["other-chat", "chat-lead-a2", "owner-other-chat", "person-lead-a"],
        ]) {
          yield* queue.enqueue(
            yield* decodeEvent({
              ...owner,
              receivedAt: DateTime.formatIso(owner.receivedAt),
              eventId: id,
              dedupeKey: id,
              chatId,
              provenance: { _tag: "human", personId, memberId },
            }),
          );
        }
        assert.deepStrictEqual(
          yield* sql`SELECT event_id FROM kin_events WHERE priority != 'P2' AND state = 'queued' ORDER BY event_id`,
          [],
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect("selects a ready lead ahead of a deferred lead and notifies retirement", () =>
    Effect.gen(function* () {
      yield* seed();
      yield* seed("a", "lead-a2");
      const queue = yield* KinEventQueue.KinEventQueue;
      const sql = yield* SqlClient.SqlClient;
      const orgId = KinOrgId.make("a");
      yield* queue.enqueue(yield* event("deferred"));
      yield* queue.enqueue(yield* event("ready", "routine", "a", "lead-a2"));
      yield* sql`UPDATE kin_events SET not_before = 300000 WHERE event_id = 'deferred'`;
      yield* TestClock.adjust("20 seconds");
      assert.deepStrictEqual(
        (yield* queue.readyLeads(orgId)).map((lead) => lead.agentId),
        ["lead-a2", "lead-a"],
      );
      // A paused agent's events wait in the queue; resuming makes it ready again.
      yield* sql`UPDATE kin_agents SET paused_at = '2026-11-07T00:00:00.000Z' WHERE agent_id = 'lead-a2'`;
      assert.deepStrictEqual(
        (yield* queue.readyLeads(orgId)).map((lead) => lead.agentId),
        ["lead-a"],
      );
      yield* sql`UPDATE kin_agents SET paused_at = NULL WHERE agent_id = 'lead-a2'`;
      const changed = yield* queue.changes(orgId);
      const signal = yield* changed.pipe(Effect.forkChild);
      yield* sql`UPDATE kin_agents SET retired_at = '2026-11-07T00:00:00.000Z' WHERE agent_id = 'lead-a2'`;
      yield* queue.expireAgent(orgId, KinAgentId.make("lead-a2"));
      yield* Fiber.join(signal);
      yield* queue.expireAgent(orgId, KinAgentId.make("lead-a2"));
      assert.deepStrictEqual(yield* sql`SELECT state FROM kin_events WHERE event_id = 'ready'`, [
        { state: "expired" },
      ]);
      assert.deepStrictEqual(
        (yield* queue.readyLeads(orgId)).map((lead) => lead.agentId),
        ["lead-a"],
      );

      // An event queued before a retirement is never claimed after it, even before anything
      // expires it: the claim waits, and takes it only once the lead is restored.
      yield* sql`UPDATE kin_agents SET retired_at = NULL WHERE agent_id = 'lead-a2'`;
      yield* queue.enqueue(yield* event("before", "routine", "a", "lead-a2"));
      yield* sql`UPDATE kin_agents SET retired_at = '2026-11-07T00:00:00.000Z' WHERE agent_id = 'lead-a2'`;
      const claim = yield* Effect.scoped(queue.claim(input("after-retire", "a", "lead-a2"))).pipe(
        Effect.forkChild,
      );
      yield* TestClock.adjust("2 minutes");
      assert.deepStrictEqual(yield* sql`SELECT wakeup_id FROM kin_wakeups ORDER BY wakeup_id`, []);
      yield* sql`UPDATE kin_agents SET retired_at = NULL WHERE agent_id = 'lead-a2'`;
      yield* queue.enqueue(yield* event("restored", "routine", "a", "lead-a2"));
      yield* TestClock.adjust("20 seconds");
      assert.deepStrictEqual(
        (yield* Fiber.join(claim)).map((entry) => entry.eventId),
        ["before", "restored"],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "dedupes per organization, normalizes github deliveries, and surfaces other constraints",
    () =>
      Effect.gen(function* () {
        yield* seed();
        yield* seed("b");
        const queue = yield* KinEventQueue.KinEventQueue;
        const sql = yield* SqlClient.SqlClient;
        for (const tag of ["github", "routine"]) {
          const original = yield* event(tag, tag);
          assert.isFalse((yield* queue.enqueue(original)).duplicate);
          const replay = yield* queue.enqueue({
            ...original,
            eventId: KinEventId.make(`${tag}-replay`),
          });
          assert.isTrue(replay.duplicate);
          assert.strictEqual(replay.event.eventId, original.eventId);
          const retried = yield* queue.enqueue(original);
          assert.strictEqual(retried.event.eventId, original.eventId);
          for (const changed of [
            { ...original, dedupeKey: "different" },
            { ...original, receivedAt: DateTime.makeUnsafe(1) },
            { ...original, agentId: KinAgentId.make("lead-b") },
            { ...(yield* event(tag, "watchdog")), dedupeKey: original.dedupeKey },
            {
              ...original,
              eventId: KinEventId.make(`${tag}-agent-conflict`),
              agentId: KinAgentId.make("lead-b"),
            },
            {
              ...(yield* event(`${tag}-tag-conflict`, "watchdog")),
              dedupeKey: tag === "github" ? `delivery-${tag}` : original.dedupeKey,
            },
          ]) {
            const conflict = yield* queue.enqueue(changed).pipe(Effect.flip);
            assert.strictEqual(
              conflict._tag,
              changed.agentId === "lead-b" ? "KinEventQueueUnknownAgent" : "KinEventQueueConflict",
            );
          }
          for (const redelivery of [
            {
              ...original,
              eventId: KinEventId.make(`${tag}-redelivery`),
              receivedAt: DateTime.makeUnsafe(1),
            },
            yield* decodeEvent({
              ...original,
              eventId: `${tag}-new-delivery`,
              receivedAt: "2026-11-07T01:00:00.000Z",
              webhookDeliveryId: "new-t3-delivery",
              scheduledTaskId: "new-task",
            }),
          ]) {
            const duplicate = yield* queue.enqueue(redelivery);
            assert.isTrue(duplicate.duplicate);
            assert.deepStrictEqual(duplicate.event, retried.event);
          }
          if (original._tag === "github") {
            const differentPayload = yield* queue
              .enqueue({ ...original, summary: "Changed push" })
              .pipe(Effect.flip);
            assert.instanceOf(differentPayload, KinEventQueue.KinEventQueueConflict);
            assert.isTrue(
              (yield* queue.enqueue({ ...original, dedupeKey: original.deliveryId })).duplicate,
            );
          }
          assert.isFalse(
            (yield* queue.enqueue({
              ...original,
              eventId: KinEventId.make(`${tag}-b`),
              orgId: KinOrgId.make("b"),
              agentId: KinAgentId.make("lead-b"),
            })).duplicate,
          );
        }
        const [row] = yield* sql<{
          dedupe_key: string;
          json: string;
        }>`SELECT dedupe_key, json FROM kin_events WHERE event_id = 'github'`;
        assert.strictEqual(row?.dedupe_key, "delivery-github");
        assert.strictEqual((yield* decodeEventJson(row!.json)).dedupeKey, "delivery-github");
        const duplicateId = yield* queue
          .enqueue({ ...(yield* event("routine", "routine")), dedupeKey: "different-key" })
          .pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(duplicateId));
        const missingLead = yield* queue
          .enqueue(yield* event("missing", "routine", "a", "missing"))
          .pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(missingLead));
        yield* sql`CREATE TABLE enqueue_guard (value TEXT NOT NULL CHECK(value != 'reject-check'))`;
        yield* sql`CREATE TRIGGER reject_event AFTER INSERT ON kin_events
          WHEN NEW.event_id IN ('reject-check', 'reject-null')
          BEGIN INSERT INTO enqueue_guard VALUES (CASE WHEN NEW.event_id = 'reject-null' THEN NULL ELSE NEW.event_id END); END`;
        for (const [id, constraint] of [
          ["reject-check", "CHECK"],
          ["reject-null", "NOT NULL"],
        ]) {
          const rejected = yield* queue.enqueue(yield* event(id!)).pipe(Effect.exit);
          assert.isTrue(Exit.isFailure(rejected));
          assert.include(String(rejected), constraint!);
        }
        assert.deepStrictEqual(
          yield* sql`SELECT event_id FROM kin_events WHERE event_id LIKE 'reject-%'`,
          [],
        );
        for (const id of ["without-key-1", "without-key-2"]) {
          assert.isFalse(
            (yield* queue.enqueue({ ...(yield* event(id, "routine")), dedupeKey: null })).duplicate,
          );
        }
        const noKey = { ...(yield* event("without-key-1", "routine")), dedupeKey: null };
        const retriedNoKey = yield* queue.enqueue(noKey);
        assert.isTrue(retriedNoKey.duplicate);
        assert.deepStrictEqual(retriedNoKey.event, noKey);
        const invalidEvent = yield* queue
          .enqueue({
            ...(yield* event("invalid-payload")),
            dedupeKey: " ",
          })
          .pipe(Effect.flip);
        assert.strictEqual(invalidEvent._tag, "PersistenceDecodeError");
        const github = yield* event("invalid-key");
        const invalidKey = yield* queue
          .enqueue({ ...github, dedupeKey: "mismatch" })
          .pipe(Effect.flip);
        assert.instanceOf(invalidKey, KinEventQueue.KinEventQueueConflict);
        const foreign = yield* queue
          .enqueue({ ...noKey, orgId: KinOrgId.make("b"), agentId: KinAgentId.make("lead-b") })
          .pipe(Effect.flip);
        assert.instanceOf(foreign, KinEventQueue.KinEventQueueUnknownEvent);
        yield* sql`UPDATE kin_events SET json = 'invalid-json' WHERE event_id = 'routine'`;
        yield* TestClock.adjust("20 seconds");
        const failedClaim = yield* Effect.scoped(queue.claim(input("invalid-batch"))).pipe(
          Effect.exit,
        );
        assert.isTrue(Exit.isFailure(failedClaim));
        assert.deepStrictEqual(yield* sql`SELECT * FROM kin_wakeups`, []);
        assert.deepStrictEqual(
          yield* sql`SELECT event_id FROM kin_events WHERE state != 'queued' OR attempts != 0`,
          [],
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect("holds pause and partial budget deferrals without consuming provider attempts", () =>
    Effect.gen(function* () {
      yield* seed();
      const queue = yield* KinEventQueue.KinEventQueue;
      const sql = yield* SqlClient.SqlClient;
      yield* queue.enqueue(yield* event("deferred"));
      yield* queue.enqueue(yield* event("ready"));
      yield* TestClock.adjust("20 seconds");
      yield* Effect.scoped(queue.claim(input("admission")));
      for (const invalidRelease of [
        { ...input("admission"), countAttempt: false },
        { ...input("admission"), countAttempt: false, notBefore: -1 },
      ] as const) {
        // @ts-expect-error Missing notBefore also exercises validation at the runtime boundary.
        const rejected = yield* queue.release(invalidRelease).pipe(Effect.flip);
        assert.strictEqual(rejected._tag, "PersistenceDecodeError");
      }
      assert.strictEqual(
        (yield* queue.release({
          ...input("admission", "b"),
          countAttempt: false,
          notBefore: 60_000,
        })).released,
        0,
      );
      assert.strictEqual(
        (yield* queue.release({
          ...input("admission"),
          eventIds: [KinEventId.make("deferred")],
          notBefore: 60_000,
          countAttempt: false,
        })).released,
        1,
      );
      assert.deepStrictEqual(yield* sql`SELECT status FROM kin_wakeups ORDER BY wakeup_id`, [
        { status: "running" },
      ]);
      yield* finish("admission");
      const later = yield* Effect.scoped(queue.claim(input("deferred-batch"))).pipe(
        Effect.forkChild,
      );
      yield* TestClock.adjust("39 seconds");
      assert.deepStrictEqual(
        yield* sql`SELECT state, not_before, attempts FROM kin_events WHERE event_id = 'deferred'`,
        [{ state: "queued", not_before: 60000, attempts: 0 }],
      );
      yield* TestClock.adjust("1 second");
      assert.deepStrictEqual(
        (yield* Fiber.join(later)).map((entry) => entry.eventId),
        ["deferred"],
      );
      yield* queue.release({ ...input("deferred-batch"), notBefore: 120_000, countAttempt: false });
      assert.deepStrictEqual(
        yield* sql`SELECT status FROM kin_wakeups WHERE wakeup_id = 'deferred-batch'`,
        [{ status: "released" }],
      );
      const paused = yield* Effect.scoped(queue.claim(input("unpaused"))).pipe(Effect.forkChild);
      yield* TestClock.adjust("59 seconds");
      assert.isUndefined(paused.pollUnsafe());
      yield* TestClock.adjust("1 second");
      assert.deepStrictEqual(
        (yield* Fiber.join(paused)).map((entry) => entry.eventId),
        ["deferred"],
      );
      yield* finish("unpaused");
      assert.deepStrictEqual(yield* sql`SELECT state, attempts FROM kin_events ORDER BY event_id`, [
        { state: "done", attempts: 0 },
        { state: "done", attempts: 0 },
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect.each([
    { scheduleId: "checkin-morning", pause: false },
    { scheduleId: "checkin-evening", pause: false },
    { scheduleId: "checkin-morning", pause: true },
  ])(
    "the $scheduleId page is a turn of its own in a quiet chat (pause enabled: $pause)",
    ({ scheduleId, pause }) =>
      Effect.gen(function* () {
        yield* seed();
        const queue = yield* KinEventQueue.KinEventQueue;
        const sql = yield* SqlClient.SqlClient;
        const message = (id: string) =>
          stored(id, "chat-lead-a").pipe(Effect.andThen(event(id, "chat.message")));
        const ids = (events: ReadonlyArray<{ readonly eventId: string }>) =>
          events.map((entry) => entry.eventId);
        yield* queue.enqueue(
          yield* decodeEvent({
            _tag: "pulse",
            eventId: "morning",
            orgId: "a",
            agentId: "lead-a",
            receivedAt: DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
            dedupeKey: `checkin:${scheduleId}:2026-11-09`,
            provenance: { _tag: "system" },
            factKeys: [],
            checkIn: { scheduleId, title: "Check-in", what: "Look.", slot: "s" },
          }),
          pause ? { checkInPause: { until: 60 * 60_000 } } : undefined,
        );
        yield* queue.enqueue(yield* message("owner-ask"));
        yield* TestClock.adjust("2 seconds");
        // The owner's message first, on its own; the morning brief right after, alone, though
        // the owner wrote again in the meantime.
        assert.deepStrictEqual(ids(yield* Effect.scoped(queue.claim(input("ask")))), ["owner-ask"]);
        yield* TestClock.adjust("5 seconds");
        yield* queue.enqueue(yield* message("owner-more"));
        yield* finish("ask");
        yield* TestClock.adjust("20 seconds");
        const morning = input("morning");
        assert.deepStrictEqual(ids(yield* Effect.scoped(queue.claim(morning))), ["morning"]);
        yield* sql`UPDATE kin_wakeups SET run_id = 'run' WHERE wakeup_id = 'morning'`;
        yield* queue.enqueue(yield* message("owner-again"));
        assert.deepStrictEqual(yield* queue.steer(morning), []);
        yield* finish("morning");
        yield* TestClock.adjust("20 seconds");
        assert.deepStrictEqual(ids(yield* Effect.scoped(queue.claim(input("again")))), [
          "owner-more",
          "owner-again",
        ]);
      }).pipe(Effect.provide(layer)),
  );

  // A check-in that enqueue gave a pause waits out the owner's own text in the owner chat; every
  // other event is claimed at `COALESCE(not_before, queued_at)` as before, whoever is talking.
  it.effect.each([
    { tag: "chat.message", held: false },
    { tag: "widget.action", held: false },
    { tag: "github", held: false },
    { tag: "routine", held: false },
    { tag: "record.changed", held: false },
    { tag: "pulse", held: false },
    { tag: "pulse", held: true },
  ])("owner talk holds only a paused check-in: $tag held $held", ({ tag, held }) =>
    Effect.gen(function* () {
      yield* seed();
      const queue = yield* KinEventQueue.KinEventQueue;
      const sql = yield* SqlClient.SqlClient;
      const MINUTE = 60_000;
      const due = 5 * MINUTE;
      const base =
        tag === "pulse"
          ? yield* decodeEvent({
              _tag: "pulse",
              eventId: "checkin",
              orgId: "a",
              agentId: "lead-a",
              receivedAt: DateTime.formatIso(DateTime.makeUnsafe(0)),
              dedupeKey: "checkin:checkin-evening:2026-11-09",
              provenance: { _tag: "system" },
              factKeys: [],
              checkIn: {
                scheduleId: "checkin-evening",
                title: "Evening",
                what: "Sum up.",
                slot: "s",
              },
            })
          : yield* event(`e-${tag}`, tag);
      yield* queue.enqueue(base, {
        notBefore: due,
        ...(held ? { checkInPause: { until: due + 60 * MINUTE } } : {}),
      });
      yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind,
          author_person_id, author_member_id, author_role, kind, body, mentions_json, status, created_at)
        VALUES ('talk', 'a', 'chat-lead-a', 99, 'human', 'person-lead-a', 'member-lead-a', 'member',
          'text', 'Invented', '[]', 'posted', ${DateTime.formatIso(DateTime.makeUnsafe(due - MINUTE))})`;
      const run = yield* Effect.scoped(
        queue
          .claim(input("turn"))
          .pipe(
            Effect.flatMap((events) =>
              Clock.currentTimeMillis.pipe(Effect.map((at) => ({ at, events }))),
            ),
          ),
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust(due + 20 * MINUTE);
      const { at, events } = yield* Fiber.join(run);
      assert.strictEqual(at, held ? due + 9 * MINUTE : due);
      assert.deepStrictEqual(
        events.map((entry) => entry.eventId),
        [base.eventId],
      );
      // The pause stays a queue column in all but name: the agent's event never carries it.
      assert.notProperty(events[0], "_checkInPause");
      assert.deepStrictEqual(
        yield* sql`SELECT json_extract(json, '$._checkInPause.until') AS until FROM kin_events`,
        [{ until: held ? due + 60 * MINUTE : null }],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect.each([
    {
      name: "gives a message waiting at release the first turn",
      kind: "quiet",
      first: "rhea-more",
    },
    { name: "runs before a message after the cap", kind: "cap", first: "checkin" },
    { name: "uses the original minute at the evening boundary", kind: "evening", first: "checkin" },
  ])("a held check-in $name", ({ kind, first }) =>
    Effect.gen(function* () {
      yield* seed();
      const queue = yield* KinEventQueue.KinEventQueue;
      const sql = yield* SqlClient.SqlClient;
      const MINUTE = 60_000;
      const evening = kind === "evening";
      // Midnight after New York's 25-hour fall-back day is 05:00 UTC.
      const dayEndsAt = Date.UTC(2026, 10, 2, 5) - 1;
      const due = evening ? Date.UTC(2026, 10, 2, 4, 55) : 15 * MINUTE;
      const scheduleId = evening ? "checkin-evening" : "checkin-morning";
      yield* TestClock.setTime(due - 10 * MINUTE);
      const talk = Effect.fn("test.talk")(function* (id: string) {
        yield* stored(id, "chat-lead-a");
        const at = yield* Clock.currentTimeMillis;
        yield* sql`UPDATE kin_messages SET created_at = ${DateTime.formatIso(DateTime.makeUnsafe(at))}
          WHERE message_id = ${id}`;
      });
      const claim = (id: string) =>
        Effect.scoped(queue.claim(input(id))).pipe(
          Effect.map((events) => events.map((entry) => entry.eventId)),
        );
      const pulse = {
        _tag: "pulse",
        orgId: "a",
        agentId: "lead-a",
        receivedAt: DateTime.formatIso(DateTime.makeUnsafe(due - 10 * MINUTE)),
        provenance: { _tag: "system" },
      };
      yield* queue.enqueue(
        yield* decodeEvent({
          ...pulse,
          eventId: "checkin",
          dedupeKey: `checkin:${scheduleId}:2026-11-01`,
          factKeys: [],
          checkIn: { scheduleId, title: "Check-in", what: "Look.", slot: "s" },
        }),
        {
          notBefore: due,
          checkInPause: { until: due + 60 * MINUTE, ...(evening ? { dayEndsAt } : {}) },
        },
      );
      yield* queue.enqueue(
        yield* decodeEvent({
          ...pulse,
          eventId: "prepare",
          dedupeKey: "prepare",
          factKeys: ["quote_unanswered:one:last=1"],
        }),
      );
      yield* TestClock.adjust(MINUTE);
      yield* talk("rhea-first");
      yield* queue.enqueue(yield* event("rhea-first", "chat.message"));
      yield* TestClock.adjust("2 seconds");
      assert.deepStrictEqual(yield* claim("early"), ["rhea-first"]);
      yield* finish("early");
      assert.deepStrictEqual(yield* claim("busy"), ["prepare"]);
      yield* sql`UPDATE kin_wakeups SET run_id = 'run' WHERE wakeup_id = 'busy'`;

      if (kind === "cap") {
        yield* TestClock.setTime(due + 59 * MINUTE);
        yield* talk("rhea-at-cap");
      }
      yield* TestClock.setTime(due + (kind === "cap" ? 61 * MINUTE : 30_000));
      yield* talk("rhea-more");
      yield* queue.enqueue(yield* event("rhea-more", "chat.message"));
      assert.deepStrictEqual(yield* queue.steer(input("busy")), []);

      const claimAt = due + (kind === "cap" ? 62 : evening ? 2 : 11) * MINUTE;
      yield* TestClock.setTime(claimAt);
      yield* finish("busy");
      const run = yield* claim("first").pipe(
        Effect.flatMap((ids) => Clock.currentTimeMillis.pipe(Effect.map((at) => ({ at, ids })))),
        Effect.forkChild,
      );
      yield* TestClock.adjust(MINUTE);
      assert.deepStrictEqual(yield* Fiber.join(run), { at: claimAt, ids: [first] });
      yield* finish("first");
      assert.deepStrictEqual(yield* claim("second"), [
        first === "checkin" ? "rhea-more" : "checkin",
      ]);
      yield* finish("second");
    }).pipe(Effect.provide(layer)),
  );

  // Each row: a held check-in whose hold released while another lane's turn ran, and the owner's
  // `posts` (a `text` is a line with no event); who goes first once that turn ends.
  it.effect.each([
    {
      name: "gives a message from inside the hold the first turn after the cap",
      due: 15 * ONE_MINUTE,
      posts: [{ id: "ask", at: 65 * ONE_MINUTE, kind: "message" }],
      claimAt: 77 * ONE_MINUTE,
      first: "ask",
    },
    {
      name: "gives a card tap made inside the hold an earlier line began the first turn",
      due: 15 * ONE_MINUTE,
      posts: [
        { id: "said", at: 10 * ONE_MINUTE, kind: "text" },
        { id: "tap", at: 17 * ONE_MINUTE, kind: "tap" },
      ],
      claimAt: 23 * ONE_MINUTE,
      first: "tap",
    },
    {
      name: "runs before a card tap made after an earlier line's pause ended",
      due: 15 * ONE_MINUTE,
      posts: [
        { id: "said", at: 10 * ONE_MINUTE, kind: "text" },
        { id: "tap", at: 21 * ONE_MINUTE, kind: "tap" },
      ],
      claimAt: 23 * ONE_MINUTE,
      first: "checkin",
    },
    {
      name: "counts a pause ending on the evening's last millisecond",
      due: DAY_ENDS - 30 * ONE_MINUTE + 1,
      dayEndsAt: DAY_ENDS,
      posts: [{ id: "ask", at: DAY_ENDS - 10 * ONE_MINUTE, kind: "message" }],
      claimAt: DAY_ENDS,
      first: "ask",
    },
    {
      name: "keeps its minute when the pause ends a millisecond into the next day",
      due: DAY_ENDS - 30 * ONE_MINUTE + 1,
      dayEndsAt: DAY_ENDS,
      posts: [{ id: "ask", at: DAY_ENDS - 10 * ONE_MINUTE + 1, kind: "message" }],
      claimAt: DAY_ENDS + 1,
      first: "checkin",
    },
    {
      name: "keeps its minute once moved past its day",
      due: DAY_ENDS + 5 * ONE_MINUTE,
      until: DAY_ENDS + 30 * ONE_MINUTE,
      dayEndsAt: DAY_ENDS,
      posts: [{ id: "ask", at: DAY_ENDS + 6 * ONE_MINUTE, kind: "message" }],
      claimAt: DAY_ENDS + 8 * ONE_MINUTE,
      first: "checkin",
    },
  ])("a check-in released during another lane's turn $name", (row) =>
    Effect.gen(function* () {
      yield* seed();
      const queue = yield* KinEventQueue.KinEventQueue;
      // The queue reads only the stored last millisecond; checkIn.ts takes it from endOfDay.
      assert.strictEqual(endOfDay("2026-03-08", "America/New_York"), SHORT_DAY_ENDS);
      yield* TestClock.setTime(row.due - 10 * ONE_MINUTE);
      yield* holdCheckIn({
        due: row.due,
        until: row.until ?? row.due + 60 * ONE_MINUTE,
        ...(row.dayEndsAt === undefined ? {} : { dayEndsAt: row.dayEndsAt }),
      });
      for (const post of row.posts) {
        yield* TestClock.setTime(post.at);
        yield* ownerPosts(post.id, post.kind === "tap" ? "widget_action" : "text");
        if (post.kind !== "text")
          yield* queue.enqueue(
            yield* event(post.id, post.kind === "tap" ? "widget.action" : "chat.message"),
          );
      }
      yield* TestClock.setTime(row.claimAt);
      yield* finish("busy");
      assert.deepStrictEqual(yield* claimAt("first"), { at: row.claimAt, ids: [row.first] });
      yield* finish("first");
      const asked = row.posts.find((post) => post.kind !== "text")!.id;
      assert.deepStrictEqual((yield* claimAt("second")).ids, [
        row.first === "checkin" ? asked : "checkin",
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "a steady stream of the owner's messages holds a check-in no later than its cap and two turns",
    () =>
      Effect.gen(function* () {
        yield* seed();
        const queue = yield* KinEventQueue.KinEventQueue;
        const sql = yield* SqlClient.SqlClient;
        const due = 15 * ONE_MINUTE;
        const until = due + 60 * ONE_MINUTE;
        yield* TestClock.setTime(due - 10 * ONE_MINUTE);
        yield* holdCheckIn({ due, until });
        // A message every minute from the check-in's minute for 90 minutes; each turn takes 90
        // seconds, so one is always waiting when the next turn is claimed.
        let next = due;
        const postThrough = Effect.fn("test.postThrough")(function* (through: number) {
          for (; next <= through && next <= due + 90 * ONE_MINUTE; next += ONE_MINUTE) {
            yield* TestClock.setTime(next);
            yield* ownerPosts(`m-${next / ONE_MINUTE}`, "text");
            yield* queue.enqueue(yield* event(`m-${next / ONE_MINUTE}`, "chat.message"));
          }
        });
        yield* postThrough(due);
        yield* finish("busy");
        const turns: Array<{ at: number; ids: ReadonlyArray<string> }> = [];
        let turn = 0;
        while (
          (yield* sql<{
            n: number;
          }>`SELECT COUNT(*) AS n FROM kin_events WHERE state = 'queued'`)[0]!.n > 0
        ) {
          const claimed = yield* claimAt(`t-${turn}`);
          turns.push(claimed);
          yield* postThrough(claimed.at + 90_000);
          yield* TestClock.setTime(Math.max(claimed.at + 90_000, yield* Clock.currentTimeMillis));
          yield* finish(`t-${turn++}`);
        }
        const page = turns.findIndex((entry) => entry.ids.includes("checkin"));
        assert.deepStrictEqual(turns[page]!.ids, ["checkin"]);
        assert.isAtMost(turns[page]!.at, until + 2 * (90_000 + ONE_MINUTE));
        // Every message claimed before it was received inside its hold or rode with one that was.
        const before = turns.slice(0, page).flatMap((entry) => entry.ids);
        assert.isTrue(
          before.every((id) => Number(id.slice(2)) * ONE_MINUTE <= until + 2 * ONE_MINUTE),
        );
        assert.isTrue(turns.slice(page + 1).every((entry) => !entry.ids.includes("checkin")));
      }).pipe(Effect.provide(layer)),
  );

  it.effect("another agent's messages neither wait for a held check-in nor move its pause", () =>
    Effect.gen(function* () {
      yield* seed();
      yield* seed("a", "lead-b");
      const queue = yield* KinEventQueue.KinEventQueue;
      const due = 15 * ONE_MINUTE;
      yield* TestClock.setTime(due - 10 * ONE_MINUTE);
      yield* holdCheckIn({ due, until: due + 60 * ONE_MINUTE });
      // The owner's last line in their own chat pauses the check-in until 17 minutes.
      yield* TestClock.setTime(due - 8 * ONE_MINUTE);
      yield* ownerPosts("said", "text");
      // The same person's text in lead-b's chat, and lead-b's owner asking lead-b.
      yield* TestClock.setTime(due + ONE_MINUTE);
      yield* ownerPosts("elsewhere", "text", "chat-lead-b");
      yield* ownerPosts("b-ask", "text", "chat-lead-b", "person-lead-b");
      yield* queue.enqueue(yield* event("b-ask", "chat.message", "a", "lead-b"));
      const other = yield* Effect.scoped(queue.claim(input("b-turn", "a", "lead-b"))).pipe(
        Effect.flatMap((events) =>
          Clock.currentTimeMillis.pipe(
            Effect.map((at) => ({ at, ids: events.map((entry) => entry.eventId) })),
          ),
        ),
        Effect.forkChild,
      );
      yield* TestClock.adjust("2 seconds");
      // Its own owner burst only: it never waits on lead-a.
      assert.deepStrictEqual(yield* Fiber.join(other), {
        at: due + ONE_MINUTE + 300,
        ids: ["b-ask"],
      });
      yield* TestClock.setTime(due + 3 * ONE_MINUTE);
      yield* ownerPosts("tap", "widget_action");
      yield* queue.enqueue(yield* event("tap", "widget.action"));
      yield* TestClock.setTime(due + 5 * ONE_MINUTE);
      yield* finish("busy");
      assert.deepStrictEqual((yield* claimAt("first")).ids, ["checkin"]);
      yield* finish("first");
      assert.deepStrictEqual((yield* claimAt("second")).ids, ["tap"]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "a restart mid-hold or mid-claim runs the waiting message, then the check-in, each once",
    () =>
      Effect.gen(function* () {
        yield* seed();
        const queue = yield* KinEventQueue.KinEventQueue;
        const sql = yield* SqlClient.SqlClient;
        const due = 15 * ONE_MINUTE;
        const orgId = KinOrgId.make("a");
        yield* TestClock.setTime(due - 10 * ONE_MINUTE);
        yield* holdCheckIn({ due, until: due + 60 * ONE_MINUTE });
        yield* TestClock.setTime(due + 30_000);
        yield* ownerPosts("ask", "text");
        yield* queue.enqueue(yield* event("ask", "chat.message"));
        yield* TestClock.setTime(due + 11 * ONE_MINUTE);
        // Restart while the other lane's turn ran: start-up recovery puts it back.
        yield* Effect.gen(function* () {
          const restarted = yield* KinEventQueue.KinEventQueue;
          assert.strictEqual(
            yield* restarted.requeueUnfinished(orgId, KinWakeupId.make("busy")),
            1,
          );
          assert.deepStrictEqual(
            (yield* Effect.scoped(restarted.claim(input("claimed")))).map((e) => e.eventId),
            ["ask"],
          );
        }).pipe(Effect.provide(KinEventQueue.layer));
        // Restart again before that turn's run started.
        yield* Effect.gen(function* () {
          const restarted = yield* KinEventQueue.KinEventQueue;
          assert.strictEqual(
            yield* restarted.requeueUnfinished(orgId, KinWakeupId.make("claimed")),
            1,
          );
          const ids = (id: string) =>
            Effect.scoped(restarted.claim(input(id))).pipe(
              Effect.map((events) => events.map((entry) => entry.eventId)),
            );
          assert.deepStrictEqual(yield* ids("again"), ["ask"]);
          yield* restarted.finish({
            orgId,
            wakeupId: KinWakeupId.make("again"),
            status: "completed",
          });
          assert.deepStrictEqual(yield* ids("page"), ["checkin"]);
          yield* restarted.finish({
            orgId,
            wakeupId: KinWakeupId.make("page"),
            status: "completed",
          });
          assert.deepStrictEqual(yield* ids("rest"), ["prepare"]);
          yield* restarted.finish({
            orgId,
            wakeupId: KinWakeupId.make("rest"),
            status: "completed",
          });
        }).pipe(Effect.provide(KinEventQueue.layer));
        assert.deepStrictEqual(
          yield* sql`SELECT event_id, state, wakeup_id FROM kin_events ORDER BY event_id`,
          [
            { event_id: "ask", state: "done", wakeup_id: "again" },
            { event_id: "checkin", state: "done", wakeup_id: "page" },
            { event_id: "prepare", state: "done", wakeup_id: "rest" },
          ],
        );
      }).pipe(Effect.provide(layer)),
  );

  // Who shares a turn with whom when a held check-in has every other kind beside it in the owner's lane.
  it.effect.each([
    {
      name: "a card tap from before its minute",
      post: { id: "tap", at: 7 * ONE_MINUTE, kind: "tap" },
      claimAt: 16 * ONE_MINUTE,
      turns: [["tap", "remind", "mail", "push"], ["checkin"]],
    },
    {
      name: "a message waiting at its release",
      post: { id: "ask", at: 15 * ONE_MINUTE + 30_000, kind: "message" },
      claimAt: 26 * ONE_MINUTE,
      turns: [["ask", "remind", "mail", "push"], ["checkin"]],
    },
    {
      name: "only a message after its cap",
      post: { id: "ask", at: 76 * ONE_MINUTE, kind: "message" },
      claimAt: 77 * ONE_MINUTE,
      turns: [["remind", "checkin", "mail", "push"], ["ask"]],
    },
  ])(
    "a held check-in beside a reminder, mail and GitHub, with $name",
    ({ post, claimAt: at, turns }) =>
      Effect.gen(function* () {
        yield* seed();
        const queue = yield* KinEventQueue.KinEventQueue;
        const due = 15 * ONE_MINUTE;
        yield* TestClock.setTime(due - 10 * ONE_MINUTE);
        yield* holdCheckIn({ due, until: due + 60 * ONE_MINUTE });
        yield* TestClock.setTime(due - 9 * ONE_MINUTE);
        yield* queue.enqueue(yield* event("remind", "deferral.due"));
        yield* queue.enqueue(yield* event("push"));
        yield* queue.enqueue(
          yield* decodeEvent({
            _tag: "pulse",
            eventId: "mail",
            orgId: "a",
            agentId: "lead-a",
            receivedAt: DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
            dedupeKey: "mail",
            provenance: { _tag: "system" },
            factKeys: [],
            outside: [
              {
                source: "mail",
                connection: "Google",
                id: "t-1",
                thread: "t-1",
                at: "Mon, 16 Nov 2026 10:41:00 +0000",
                who: "arjun@tidewater.example",
                subject: "Invented quote",
                where: null,
              },
            ],
          }),
        );
        yield* TestClock.setTime(post.at);
        yield* ownerPosts(post.id, post.kind === "tap" ? "widget_action" : "text");
        yield* queue.enqueue(
          yield* event(post.id, post.kind === "tap" ? "widget.action" : "chat.message"),
        );
        yield* TestClock.setTime(at);
        yield* finish("busy");
        assert.deepStrictEqual((yield* claimAt("one")).ids, turns[0]);
        yield* finish("one");
        assert.deepStrictEqual((yield* claimAt("two")).ids, turns[1]);
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "a retry or quiet-hours move keeps a check-in's pause cap: held within it, never past it, run once",
    () =>
      Effect.gen(function* () {
        yield* seed();
        const queue = yield* KinEventQueue.KinEventQueue;
        const sql = yield* SqlClient.SqlClient;
        const MINUTE = 60_000;
        const talk = (id: string, at: number) =>
          sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind,
            author_person_id, author_member_id, author_role, kind, body, mentions_json, status, created_at)
          VALUES (${id}, 'a', 'chat-lead-a', (SELECT COALESCE(MAX(seq), 0) + 1 FROM kin_messages),
            'human', 'person-lead-a', 'member-lead-a', 'member', 'text', 'Invented', '[]', 'posted',
            ${DateTime.formatIso(DateTime.makeUnsafe(at))})`;
        const claimAt = (id: string) =>
          Effect.scoped(
            queue
              .claim(input(id))
              .pipe(
                Effect.flatMap((events) =>
                  Clock.currentTimeMillis.pipe(
                    Effect.map((at) => ({ at, ids: events.map((entry) => entry.eventId) })),
                  ),
                ),
              ),
          ).pipe(Effect.forkChild);
        yield* queue.enqueue(
          yield* decodeEvent({
            _tag: "pulse",
            eventId: "checkin",
            orgId: "a",
            agentId: "lead-a",
            receivedAt: DateTime.formatIso(DateTime.makeUnsafe(0)),
            dedupeKey: "checkin:checkin-morning:2026-11-09",
            provenance: { _tag: "system" },
            factKeys: [],
            checkIn: { scheduleId: "checkin-morning", title: "Morning", what: "Look.", slot: "s" },
          }),
          { checkInPause: { until: 60 * MINUTE } },
        );
        yield* TestClock.adjust(3 * MINUTE);
        const first = yield* claimAt("first");
        yield* TestClock.adjust(MINUTE);
        assert.deepStrictEqual(yield* Fiber.join(first), { at: 3 * MINUTE, ids: ["checkin"] });
        // A failed start goes back with a later `not_before`; the owner writes just before it.
        yield* queue.release({
          orgId: KinOrgId.make("a"),
          wakeupId: KinWakeupId.make("first"),
          countAttempt: true,
          notBefore: 30 * MINUTE,
        });
        yield* talk("before-retry", 29 * MINUTE);
        const retry = yield* claimAt("retry");
        yield* TestClock.adjust(40 * MINUTE);
        assert.deepStrictEqual(yield* Fiber.join(retry), { at: 39 * MINUTE, ids: ["checkin"] });
        // Moved past its cap: it runs at its new minute, live talk or not.
        yield* queue.release({
          orgId: KinOrgId.make("a"),
          wakeupId: KinWakeupId.make("retry"),
          countAttempt: true,
          notBefore: 90 * MINUTE,
        });
        yield* talk("past-cap", 89 * MINUTE);
        const late = yield* claimAt("late");
        yield* TestClock.adjust(60 * MINUTE);
        assert.deepStrictEqual(yield* Fiber.join(late), { at: 90 * MINUTE, ids: ["checkin"] });
        yield* finish("late");
        assert.deepStrictEqual(
          yield* sql`SELECT state, attempts FROM kin_events WHERE event_id = 'checkin'`,
          [{ state: "done", attempts: 2 }],
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "a head start runs alone: never beside a message or a check-in, ten facts at a time",
    () =>
      Effect.gen(function* () {
        yield* seed();
        const queue = yield* KinEventQueue.KinEventQueue;
        const sql = yield* SqlClient.SqlClient;
        const ids = (events: ReadonlyArray<{ readonly eventId: string }>) =>
          events.map((entry) => entry.eventId);
        const pulse = (id: string, extra: Record<string, unknown>) =>
          Effect.gen(function* () {
            return yield* decodeEvent({
              _tag: "pulse",
              eventId: id,
              orgId: "a",
              agentId: "lead-a",
              receivedAt: DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
              dedupeKey: id,
              provenance: { _tag: "system" },
              factKeys: [],
              ...extra,
            });
          });
        const quotes = Array.from({ length: 12 }, (_, n) => `quote-${String(n).padStart(2, "0")}`);
        for (const id of quotes)
          yield* queue.enqueue(yield* pulse(id, { factKeys: [`quote_unanswered:${id}:last=1`] }));
        yield* queue.enqueue(
          yield* pulse("noon", {
            checkIn: { scheduleId: "checkin-noon", title: "Noon", what: "Look.", slot: "s" },
          }),
        );
        yield* queue.enqueue(
          yield* stored("owner-ask", "chat-lead-a").pipe(
            Effect.andThen(event("owner-ask", "chat.message")),
          ),
        );
        yield* TestClock.adjust("2 seconds");
        // The owner's message and the check-in share his chat; no head start joins them.
        assert.deepStrictEqual(ids(yield* Effect.scoped(queue.claim(input("ask")))), [
          "owner-ask",
          "noon",
        ]);
        yield* finish("ask");
        yield* TestClock.adjust("20 seconds");
        const prep = input("prep");
        assert.deepStrictEqual(ids(yield* Effect.scoped(queue.claim(prep))), quotes.slice(0, 10));
        // A message while it runs waits for a turn of its own.
        yield* sql`UPDATE kin_wakeups SET run_id = 'run' WHERE wakeup_id = 'prep'`;
        yield* queue.enqueue(
          yield* stored("owner-again", "chat-lead-a").pipe(
            Effect.andThen(event("owner-again", "chat.message")),
          ),
        );
        assert.deepStrictEqual(yield* queue.steer(prep), []);
        yield* finish("prep");
        yield* TestClock.adjust("20 seconds");
        assert.deepStrictEqual(ids(yield* Effect.scoped(queue.claim(input("again")))), [
          "owner-again",
        ]);
        yield* finish("again");
        assert.deepStrictEqual(
          ids(yield* Effect.scoped(queue.claim(input("rest")))),
          quotes.slice(10),
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect("bills to read run alone, and no message is steered into their turn", () =>
    Effect.gen(function* () {
      yield* seed();
      const queue = yield* KinEventQueue.KinEventQueue;
      const sql = yield* SqlClient.SqlClient;
      const ids = (events: ReadonlyArray<{ readonly eventId: string }>) =>
        events.map((entry) => entry.eventId);
      const system = (id: string, extra: Record<string, unknown>) =>
        Effect.gen(function* () {
          return yield* decodeEvent({
            eventId: id,
            orgId: "a",
            agentId: "lead-a",
            receivedAt: DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
            dedupeKey: id,
            provenance: { _tag: "system" },
            ...extra,
          });
        });
      yield* queue.enqueue(
        yield* system("bills", {
          _tag: "bills.read",
          chatId: "chat-lead-a",
          batchId: "b-1",
          bills: ["a".repeat(64)],
        }),
      );
      yield* TestClock.adjust("1 second");
      // Another notice of the same priority, for the same agent: it never rides along.
      yield* queue.enqueue(
        yield* system("stale", { _tag: "watchdog", finding: "A note is stale.", itemIds: [] }),
      );
      yield* TestClock.adjust("3 minutes");
      const turn = input("bills-turn");
      assert.deepStrictEqual(ids(yield* Effect.scoped(queue.claim(turn))), ["bills"]);
      yield* sql`UPDATE kin_wakeups SET run_id = 'run' WHERE wakeup_id = 'bills-turn'`;
      // The owner writes to the reader meanwhile: a turn of its own, never this one.
      yield* queue.enqueue(
        yield* stored("owner-ask", "chat-lead-a").pipe(
          Effect.andThen(event("owner-ask", "chat.message")),
        ),
      );
      assert.deepStrictEqual(yield* queue.steer(turn), []);
      yield* finish("bills-turn");
      yield* TestClock.adjust("20 seconds");
      // The notice the bills turn left rides with the owner's message, as notices do.
      assert.deepStrictEqual(ids(yield* Effect.scoped(queue.claim(input("ask")))), [
        "owner-ask",
        "stale",
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("claims one chat per wake-up and steers only that chat's human messages into it", () =>
    Effect.gen(function* () {
      yield* seed();
      const queue = yield* KinEventQueue.KinEventQueue;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at)
        VALUES ('chat-other', 'a', 'team_group', 0, '2026-11-07T00:00:00.000Z')`;
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
        VALUES ('teammate', 'a', 'teammate', 'Teammate', '2026-11-07T00:00:00.000Z')`;
      yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
        VALUES ('teammate-member', 'a', 'chat-lead-a', 'person', 'teammate', 'member', '2026-11-07T00:00:00.000Z')`;
      const message = (id: string, chatId: string) =>
        stored(id, chatId).pipe(
          Effect.andThen(event(id, "chat.message")),
          Effect.map((base) => ({ ...base, chatId: KinChatId.make(chatId) })),
        );
      const ids = (events: ReadonlyArray<{ readonly eventId: string }>) =>
        events.map((entry) => entry.eventId);
      yield* queue.enqueue(yield* message("owner-ask", "chat-lead-a"));
      yield* queue.enqueue(yield* message("other-ask", "chat-other"));
      yield* queue.enqueue(yield* event("push"));
      yield* TestClock.adjust("2 seconds");
      const first = input("lane-a");
      // The notice shares the owner's chat, so it rides along; the other chat waits.
      assert.deepStrictEqual(ids(yield* Effect.scoped(queue.claim(first))), ["owner-ask", "push"]);
      assert.deepStrictEqual(yield* queue.steer(first), [], "nothing to steer before the run");
      yield* sql`UPDATE kin_wakeups SET run_id = 'run' WHERE wakeup_id = 'lane-a'`;
      yield* queue.enqueue(yield* message("owner-again", "chat-lead-a"));
      yield* stored("member-again", "chat-lead-a", "teammate");
      const member = {
        ...(yield* event("member-again", "chat.message")),
        provenance: {
          _tag: "human" as const,
          personId: KinPersonId.make("teammate"),
          memberId: KinMemberId.make("teammate-member"),
        },
      };
      yield* queue.enqueue(member);
      yield* queue.enqueue(yield* message("other-again", "chat-other"));
      yield* queue.enqueue(yield* event("later-push"));
      const steered = yield* queue.steer(first);
      // Only the owner asked this turn, so a teammate's message would lower what it runs as: it
      // waits for a wake-up of its own.
      assert.deepStrictEqual(ids(steered), ["owner-again"]);
      assert.strictEqual(steered[0]?.priority, "P0");
      assert.deepStrictEqual(
        yield* sql`SELECT event_ids FROM kin_wakeups WHERE wakeup_id = 'lane-a'`,
        [{ event_ids: '["owner-ask","push","owner-again"]' }],
      );
      assert.deepStrictEqual(yield* queue.steer(first), []);
      yield* finish("lane-a");
      yield* TestClock.adjust("20 seconds");
      assert.deepStrictEqual(ids(yield* Effect.scoped(queue.claim(input("lane-b")))), [
        "other-ask",
        "other-again",
      ]);
      yield* finish("lane-b");
      const later = yield* Effect.scoped(queue.claim(input("lane-c")));
      assert.deepStrictEqual(ids(later), ["later-push", "member-again"]);
      // The member's event is claimed as it came in: a later wake-up adds no authority.
      const memberClaimed = later.find((entry) => entry.eventId === "member-again");
      assert.deepStrictEqual(memberClaimed?.provenance, member.provenance);
      assert.strictEqual(memberClaimed?.priority, "P2");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("leaves a later message queued after a person's Stop, including on restart", () =>
    Effect.gen(function* () {
      yield* seed();
      const queue = yield* KinEventQueue.KinEventQueue;
      const sql = yield* SqlClient.SqlClient;
      const ask = (id: string) =>
        stored(id, "chat-lead-a").pipe(Effect.andThen(event(id, "chat.message")));
      yield* queue.enqueue(yield* ask("stopped"));
      yield* TestClock.adjust("2 seconds");
      const turn = input("stopped-turn");
      yield* Effect.scoped(queue.claim(turn));
      yield* sql`UPDATE kin_wakeups SET run_id = 'run' WHERE wakeup_id = ${turn.wakeupId}`;
      yield* sql`UPDATE kin_events SET state = 'done', json = json_set(json, '$._personStopped', 1)
        WHERE org_id = ${turn.orgId} AND wakeup_id = ${turn.wakeupId}`;
      yield* queue.enqueue(yield* ask("after-stop"));
      yield* Effect.gen(function* () {
        const restarted = yield* KinEventQueue.KinEventQueue;
        assert.deepStrictEqual(
          (yield* restarted.steer(turn)).map((e) => e.eventId),
          [],
        );
        assert.strictEqual(yield* restarted.requeueUnfinished(turn.orgId, turn.wakeupId), 0);
        yield* TestClock.adjust("2 seconds");
        const claimed = yield* Effect.scoped(restarted.claim(input("next-turn")));
        assert.deepStrictEqual(
          claimed.map((e) => e.eventId),
          ["after-stop"],
        );
        assert.deepStrictEqual(
          yield* sql`SELECT state, wakeup_id, attempts FROM kin_events
          WHERE event_id = 'stopped'`,
          [{ state: "done", wakeup_id: turn.wakeupId, attempts: 0 }],
        );
      }).pipe(Effect.provide(KinEventQueue.layer));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a split retry neither steers into an ordinary turn nor accepts a steer", () =>
    Effect.gen(function* () {
      yield* seed();
      const queue = yield* KinEventQueue.KinEventQueue;
      const sql = yield* SqlClient.SqlClient;
      const message = (id: string) =>
        stored(id, "chat-lead-a").pipe(Effect.andThen(event(id, "chat.message")));
      yield* TestClock.adjust("1 second");
      yield* queue.enqueue(yield* message("first"));
      yield* queue.enqueue(yield* message("second"));
      yield* TestClock.adjust("2 seconds");
      const batch = input("batch");
      const claimIds = (turn: ReturnType<typeof input>) =>
        Effect.scoped(queue.claim(turn)).pipe(Effect.map((events) => events.map((e) => e.eventId)));
      assert.deepStrictEqual(yield* claimIds(batch), ["first", "second"]);
      const failed = yield* queue.finish({ ...batch, status: "failed" });
      assert.strictEqual(failed.retryInMs, 15_000);
      yield* queue.enqueue({ ...(yield* message("fresh")), receivedAt: DateTime.makeUnsafe(0) });
      yield* TestClock.adjust("2 seconds");
      const ordinary = input("ordinary");
      assert.deepStrictEqual(yield* claimIds(ordinary), ["fresh"]);
      yield* sql`UPDATE kin_wakeups SET run_id = 'ordinary-run' WHERE wakeup_id = 'ordinary'`;
      assert.deepStrictEqual(yield* queue.steer(ordinary), []);
      yield* finish("ordinary");
      const solo = input("solo");
      assert.deepStrictEqual(yield* claimIds(solo), ["first"]);
      yield* sql`UPDATE kin_wakeups SET run_id = 'solo-run' WHERE wakeup_id = 'solo'`;
      yield* queue.enqueue(yield* message("new-request"));
      assert.deepStrictEqual(yield* queue.steer(solo), []);
      yield* finish("solo");
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "steers a teammate only into a turn a teammate asked, and nothing into an aborted one",
    () =>
      Effect.gen(function* () {
        yield* seed();
        const queue = yield* KinEventQueue.KinEventQueue;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
        VALUES ('teammate', 'a', 'teammate', 'Teammate', '2026-11-07T00:00:00.000Z')`;
        const ids = (events: ReadonlyArray<{ readonly eventId: string }>) =>
          events.map((entry) => entry.eventId);
        const says = (id: string, personId: string) =>
          stored(id, "chat-lead-a", personId).pipe(
            Effect.andThen(event(id, "chat.message")),
            Effect.map((base) => ({
              ...base,
              provenance: {
                _tag: "human" as const,
                personId: KinPersonId.make(personId),
                memberId: KinMemberId.make(`member-${personId}`),
              },
            })),
          );
        yield* queue.enqueue(yield* says("teammate-ask", "teammate"));
        yield* TestClock.adjust("20 seconds");
        const turn = input("shared");
        assert.deepStrictEqual(ids(yield* Effect.scoped(queue.claim(turn))), ["teammate-ask"]);
        yield* sql`UPDATE kin_wakeups SET run_id = 'run' WHERE wakeup_id = 'shared'`;
        yield* queue.enqueue(yield* says("teammate-again", "teammate"));
        yield* queue.enqueue(yield* says("owner-adds", "person-lead-a"));
        // A passed-on request keeps its own origin, and a message no longer stored was cleared.
        const relayed = yield* says("relayed", "person-lead-a");
        if (relayed._tag !== "chat.message") return assert.fail("expected a chat message");
        yield* queue.enqueue({
          ...relayed,
          origin: { agentId: KinAgentId.make("lead-a"), chatId: KinChatId.make("chat-lead-a") },
        });
        yield* queue.enqueue(yield* event("unstored", "chat.message"));
        // The turn already runs at the teammate's level: neither message lowers it.
        assert.deepStrictEqual(ids(yield* queue.steer(turn)), ["owner-adds", "teammate-again"]);
        yield* sql`UPDATE kin_wakeups SET aborted_at = 1 WHERE wakeup_id = 'shared'`;
        yield* queue.enqueue(yield* says("after-join", "person-lead-a"));
        assert.deepStrictEqual(yield* queue.steer(turn), []);
        assert.deepStrictEqual(
          yield* sql`SELECT event_id, state FROM kin_events WHERE state = 'queued' ORDER BY event_id`,
          ["after-join", "relayed", "unstored"].map((id) => ({
            event_id: id,
            state: "queued",
          })),
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect.each(["nothing", "a post"] as const)(
    "retries a failed wake-up only when nothing visible happened (%s)",
    (visible) =>
      Effect.gen(function* () {
        yield* seed();
        const queue = yield* KinEventQueue.KinEventQueue;
        const sql = yield* SqlClient.SqlClient;
        yield* queue.enqueue(yield* event("ask"));
        yield* TestClock.adjust("20 seconds");
        const claimed = input("visible");
        yield* Effect.scoped(queue.claim(claimed));
        yield* sql`UPDATE kin_wakeups SET thread_id = 'thread', run_id = 'run' WHERE wakeup_id = 'visible'`;
        if (visible === "a post")
          yield* sql`INSERT INTO kin_messages (org_id, chat_id, message_id, seq, author_kind, author_agent_id,
              author_owner_person_id, author_thread_id, author_member_id, author_role, kind, body, mentions_json,
              status, created_at)
            VALUES ('a', 'chat-lead-a', 'half-answer', 1, 'agent', 'lead-a', 'person-lead-a', 'thread',
              'agent-member-lead-a', 'member', 'text', 'Working on it', '[]', 'posted',
              ${DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis))})`;
        const finished = yield* queue.finish({ ...claimed, status: "failed" });
        assert.strictEqual(finished.stranded, visible === "a post" ? 1 : 0);
        assert.deepStrictEqual(
          yield* sql`SELECT state, attempts FROM kin_events WHERE event_id = 'ask'`,
          [{ state: visible === "a post" ? "failed" : "queued", attempts: 1 }],
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect("retries failed provider runs soon, then after a quarter hour, then fails them", () =>
    Effect.gen(function* () {
      yield* seed();
      const queue = yield* KinEventQueue.KinEventQueue;
      const sql = yield* SqlClient.SqlClient;
      for (const mode of ["release", "failed", "timed_out", "run-release"] as const) {
        const id = `failure-${mode}`;
        yield* queue.enqueue(yield* event(id));
        yield* TestClock.adjust("20 seconds");
        // A counted release still fails its third; a failed or timed-out run its fourth.
        const last = mode === "release" ? 3 : 4;
        for (let attempt = 1; attempt <= last; attempt++) {
          const claimInput = input(`${id}-${attempt}`);
          yield* Effect.scoped(queue.claim(claimInput));
          yield* queue.finish({ ...claimInput, orgId: KinOrgId.make("b"), status: "completed" });
          const failed =
            mode === "release" || mode === "run-release"
              ? queue.release({
                  ...claimInput,
                  countAttempt: true,
                  ...(mode === "run-release" ? { attemptLimit: "run" as const } : {}),
                })
              : queue.finish({ ...claimInput, status: mode });
          const terminal = yield* failed;
          assert.deepStrictEqual(
            terminal.failedEventIds,
            attempt === last ? [KinEventId.make(id)] : [],
          );
          if ("retried" in terminal) assert.strictEqual(terminal.retried, attempt === last ? 0 : 1);
          assert.deepStrictEqual((yield* failed).failedEventIds, []);
          const now = yield* Clock.currentTimeMillis;
          // A run that showed nothing retries soon; a counted release keeps its five minutes.
          const delay =
            mode === "release" || mode === "run-release"
              ? 300_000
              : attempt === 1
                ? 15_000
                : attempt === 2
                  ? 60_000
                  : 900_000;
          assert.deepStrictEqual(
            yield* sql`SELECT state, attempts, not_before FROM kin_events WHERE event_id = ${id}`,
            [
              {
                state: attempt === last ? "failed" : "queued",
                attempts: attempt,
                not_before: now + delay,
              },
            ],
          );
          if (attempt < last) {
            const retry = yield* Effect.scoped(queue.claim(input(`${id}-early-${attempt}`))).pipe(
              Effect.forkChild,
            );
            yield* TestClock.adjust(delay - 1_000);
            assert.isUndefined(retry.pollUnsafe());
            yield* Fiber.interrupt(retry);
            yield* TestClock.adjust("1 second");
          }
        }
      }
      // A new message from the person waiting brings their failed start forward to join it.
      yield* queue.enqueue(yield* event("asked", "chat.message"));
      yield* TestClock.adjust("20 seconds");
      yield* Effect.scoped(queue.claim(input("asked-1")));
      yield* queue.finish({ ...input("asked-1"), status: "failed" });
      yield* queue.enqueue(yield* event("asked-again", "chat.message"));
      assert.deepStrictEqual(
        yield* sql`SELECT event_id, not_before FROM kin_events
          WHERE event_id IN ('asked', 'asked-again') ORDER BY event_id`,
        [
          { event_id: "asked", not_before: null },
          { event_id: "asked-again", not_before: null },
        ],
      );
      const invalidFinish = yield* queue
        .finish({
          ...input("invalid"),
          // @ts-expect-error Invalid status exercises decoding of untrusted runtime input.
          status: "unknown",
        })
        .pipe(Effect.flip);
      assert.strictEqual(invalidFinish._tag, "PersistenceDecodeError");
      for (const [orgId, wakeupId] of [
        [" ", "invalid"],
        ["a", " "],
      ] as const) {
        // @ts-expect-error Unbranded ids exercise decoding of untrusted runtime input.
        const invalidRecovery = yield* queue.requeueUnfinished(orgId, wakeupId).pipe(Effect.flip);
        assert.strictEqual(invalidRecovery._tag, "PersistenceDecodeError");
      }
      const invalid = yield* Effect.scoped(queue.claim({ ...input("invalid"), model: " " })).pipe(
        Effect.flip,
      );
      assert.strictEqual(invalid._tag, "PersistenceDecodeError");
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "requeues only reconciled unfinished wakeups after restart, preserving attempts and organization isolation",
    () =>
      Effect.gen(function* () {
        yield* seed();
        yield* seed("b");
        const queue = yield* KinEventQueue.KinEventQueue;
        const sql = yield* SqlClient.SqlClient;
        yield* queue.enqueue(yield* event("unfinished"));
        yield* queue.enqueue(yield* event("completed", "routine", "b"));
        yield* TestClock.adjust("20 seconds");
        yield* Effect.scoped(queue.claim(input("unfinished")));
        yield* Effect.scoped(queue.claim(input("completed", "b")));
        yield* finish("completed", "b");
        const idle = yield* Effect.scoped(queue.claim(input("idle"))).pipe(Effect.forkChild);
        yield* TestClock.adjust("1 second");
        const recovery = yield* queue
          .requeueUnfinished(KinOrgId.make("a"), KinWakeupId.make("unfinished"))
          .pipe(Effect.forkChild);
        yield* TestClock.adjust("1 second");
        assert.isDefined(recovery.pollUnsafe());
        assert.strictEqual(yield* Fiber.join(recovery), 1);
        assert.deepStrictEqual(
          (yield* Fiber.join(idle)).map((entry) => entry.eventId),
          ["unfinished"],
        );
        yield* queue.enqueue(yield* event("waiting"));
        yield* TestClock.adjust("20 seconds");
        const recovered = yield* Effect.gen(function* () {
          const restarted = yield* KinEventQueue.KinEventQueue;
          const overlapping = yield* Effect.scoped(restarted.claim(input("overlapping"))).pipe(
            Effect.exit,
          );
          assert.isTrue(Exit.isFailure(overlapping));
          assert.include(String(overlapping), "KinEventQueueBusy");
          assert.deepStrictEqual(
            yield* sql`SELECT state, attempts FROM kin_events WHERE event_id = 'waiting'`,
            [{ state: "queued", attempts: 0 }],
          );
          assert.strictEqual(
            yield* restarted.requeueUnfinished(KinOrgId.make("b"), KinWakeupId.make("unfinished")),
            0,
          );
          assert.strictEqual(
            yield* restarted.requeueUnfinished(KinOrgId.make("b"), KinWakeupId.make("completed")),
            0,
          );
          assert.strictEqual(
            yield* restarted.requeueUnfinished(KinOrgId.make("a"), KinWakeupId.make("idle")),
            1,
          );
          assert.strictEqual(
            yield* restarted.requeueUnfinished(KinOrgId.make("a"), KinWakeupId.make("idle")),
            0,
          );
          return yield* Effect.scoped(restarted.claim(input("retried")));
        }).pipe(Effect.provide(KinEventQueue.layer));
        assert.deepStrictEqual(
          recovered.map((entry) => entry.eventId),
          ["unfinished", "waiting"],
        );
        assert.deepStrictEqual(
          yield* sql`SELECT state, wakeup_id, attempts FROM kin_events ORDER BY event_id`,
          [
            { state: "done", wakeup_id: "completed", attempts: 0 },
            { state: "claimed", wakeup_id: "retried", attempts: 0 },
            { state: "claimed", wakeup_id: "retried", attempts: 0 },
          ],
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "holds one writer per lead across the caller scope while other leads and organizations proceed",
    () =>
      Effect.gen(function* () {
        yield* seed();
        yield* seed("a", "lead-a2");
        yield* seed("b");
        const queue = yield* KinEventQueue.KinEventQueue;
        const sql = yield* SqlClient.SqlClient;
        const acquired = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        yield* queue.enqueue(yield* event("a-first"));
        yield* queue.enqueue(yield* event("a2-first", "github", "a", "lead-a2"));
        yield* queue.enqueue(yield* event("b-first", "github", "b"));
        yield* TestClock.adjust("20 seconds");
        const first = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* queue.claim(input("a-first"));
            yield* Deferred.succeed(acquired, undefined);
            yield* Deferred.await(release);
            yield* finish("a-first");
          }),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(acquired);
        yield* queue.enqueue(yield* event("a-next"));
        const next = yield* Effect.scoped(queue.claim(input("a-next"))).pipe(Effect.forkChild);
        const stale = yield* Effect.scoped(queue.claim(input("stale"))).pipe(Effect.forkChild);
        const other = yield* Effect.scoped(queue.claim(input("b-first", "b"))).pipe(
          Effect.forkChild,
        );
        assert.deepStrictEqual(
          (yield* Fiber.join(other)).map((entry) => entry.eventId),
          ["b-first"],
        );
        const otherLead = yield* Effect.scoped(queue.claim(input("a2-first", "a", "lead-a2"))).pipe(
          Effect.forkChild,
        );
        assert.deepStrictEqual(
          (yield* Fiber.join(otherLead)).map((entry) => entry.eventId),
          ["a2-first"],
        );
        yield* finish("a2-first");
        yield* TestClock.adjust("20 seconds");
        assert.deepStrictEqual(
          yield* sql`SELECT wakeup_id FROM kin_wakeups WHERE org_id = 'a' AND status = 'running' ORDER BY wakeup_id`,
          [{ wakeup_id: "a-first" }],
        );
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(first);
        assert.deepStrictEqual(
          (yield* Fiber.join(next)).map((entry) => entry.eventId),
          ["a-next"],
        );
        yield* finish("a-next");
        yield* TestClock.adjust("1 second");
        assert.isUndefined(stale.pollUnsafe());
        assert.deepStrictEqual(
          yield* sql`SELECT wakeup_id FROM kin_wakeups WHERE event_ids = '[]' ORDER BY wakeup_id`,
          [],
        );
        yield* Fiber.interrupt(stale);
        assert.deepStrictEqual(yield* sql`SELECT state FROM kin_events WHERE org_id = 'b'`, [
          { state: "claimed" },
        ]);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("wakes empty queues on enqueue and releases the lead permit on interruption", () =>
    Effect.gen(function* () {
      yield* seed();
      const queue = yield* KinEventQueue.KinEventQueue;
      const cancelled = yield* Effect.scoped(queue.claim(input("cancelled"))).pipe(
        Effect.forkChild,
      );
      yield* seed("a", "lead-a2");
      yield* queue.enqueue(yield* event("other-lead", "github", "a", "lead-a2"));
      const otherLead = yield* Effect.scoped(queue.claim(input("other-lead", "a", "lead-a2"))).pipe(
        Effect.forkChild,
      );
      yield* TestClock.adjust("20 seconds");
      assert.deepStrictEqual(
        (yield* Fiber.join(otherLead)).map((entry) => entry.eventId),
        ["other-lead"],
      );
      yield* finish("other-lead");
      yield* Fiber.interrupt(cancelled);
      const waiting = yield* Effect.scoped(queue.claim(input("notified"))).pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      yield* queue.enqueue(yield* event("notification"));
      yield* TestClock.adjust("20 seconds");
      assert.deepStrictEqual(
        (yield* Fiber.join(waiting)).map((entry) => entry.eventId),
        ["notification"],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "caps a continuous burst at 120 seconds, bounds batches, and uses the claim and recovery indexes",
    () =>
      Effect.gen(function* () {
        yield* seed();
        const queue = yield* KinEventQueue.KinEventQueue;
        const sql = yield* SqlClient.SqlClient;
        yield* queue.enqueue(yield* event("initial"));
        const batch = yield* Effect.scoped(queue.claim(input("capped"))).pipe(Effect.forkChild);
        for (let index = 0; index < 12; index++) {
          yield* TestClock.adjust("9 seconds");
          for (let number = 0; number < 5; number++)
            yield* queue.enqueue(yield* event(`burst-${index}-${number}`));
        }
        yield* TestClock.adjust("12 seconds");
        assert.strictEqual((yield* Fiber.join(batch)).length, 50);
        assert.deepStrictEqual(
          yield* sql`SELECT state, COUNT(*) AS count FROM kin_events GROUP BY state ORDER BY state`,
          [
            { state: "claimed", count: 50 },
            { state: "queued", count: 11 },
          ],
        );
        const plan = yield* sql<{ detail: string }>`EXPLAIN QUERY PLAN
        UPDATE kin_events SET state = 'claimed', wakeup_id = 'next'
        WHERE org_id = 'a' AND event_id IN (SELECT event_id FROM kin_events
          WHERE org_id = 'a' AND agent_id = 'lead-a' AND state = 'queued' AND (not_before IS NULL OR not_before <= 120000)
          ORDER BY priority, received_at, event_id LIMIT 50) RETURNING json, priority, received_at, event_id`;
        assert.isTrue(plan.some((row) => row.detail.includes("idx_kin_events_queue")));
        const recovery = yield* sql<{
          detail: string;
        }>`EXPLAIN QUERY PLAN UPDATE kin_events SET state = 'queued', wakeup_id = NULL
        WHERE wakeup_id = 'capped' AND org_id = 'a' AND state = 'claimed' RETURNING event_id`;
        assert.isTrue(recovery.some((row) => row.detail.includes("idx_kin_events_wakeup")));
      }).pipe(Effect.provide(layer)),
  );
});
