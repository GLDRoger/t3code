import { assert, describe, it } from "@effect/vitest";
import { KinAgentId, KinEvent, KinEventId, KinOrgId } from "@t3tools/contracts";
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
    dedupeKey: tag === "github" ? `wrong-${id}` : id,
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
    subject: { type: "reminder", itemId: "reminder" },
    lateByMs: 0,
    workerId: id,
    report: {
      result: "done",
      summary: "Done",
      evidence: [],
      openQuestions: [],
      memorySuggestions: [],
      misleadingMemory: [],
      parsed: true,
    },
  });
});

const input = (wakeupId: string, org = "a", agent = `lead-${org}`) => ({
  orgId: KinOrgId.make(org),
  agentId: KinAgentId.make(agent),
  wakeupId,
  model: "test-model",
});

const finish = Effect.fn("test.finish")(function* (wakeupId: string) {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  yield* sql`UPDATE kin_events SET state = 'done' WHERE wakeup_id = ${wakeupId}`;
  yield* sql`UPDATE kin_wakeups SET status = 'completed', ended_at = ${now} WHERE wakeup_id = ${wakeupId}`;
});

describe("KinEventQueue", () => {
  it.effect("coalesces a quiet window and leaves later arrivals for a new batch", () =>
    Effect.gen(function* () {
      yield* seed();
      const queue = yield* KinEventQueue.KinEventQueue;
      const sql = yield* SqlClient.SqlClient;
      yield* queue.enqueue(yield* event("first"));
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
          ["report", "worker.report"],
          ["resolved", "action.resolved"],
        ])
          yield* queue.enqueue(yield* event(id!, tag!));
        const batch = yield* Effect.scoped(queue.claim(input("priority"))).pipe(Effect.forkChild);
        yield* TestClock.adjust("1 second");
        for (const tag of ["chat.message", "widget.action", "resume"]) {
          yield* queue.enqueue(yield* event(tag, tag));
        }
        yield* TestClock.adjust("1 second");
        yield* queue.enqueue(yield* event("noisy"));
        assert.deepStrictEqual(yield* sql`SELECT * FROM kin_wakeups`, []);
        yield* TestClock.adjust("1 second");
        const events = yield* Fiber.join(batch);
        assert.deepStrictEqual(
          events.map((entry) => entry.eventId),
          [
            "chat.message",
            "resume",
            "widget.action",
            "due",
            "report",
            "resolved",
            "github",
            "routine",
            "noisy",
            "watch",
          ],
        );
        yield* finish("priority");
        yield* sql`UPDATE kin_chat_members SET role = 'member'`;
        yield* queue.enqueue(yield* event("member", "chat.message"));
        const forged = yield* event("forged", "widget.action", "a", "other");
        yield* queue.enqueue({
          ...forged,
          agentId: KinAgentId.make("lead-a"),
        });
        assert.deepStrictEqual(yield* sql`SELECT priority FROM kin_events WHERE state = 'queued'`, [
          { priority: "P2" },
          { priority: "P2" },
        ]);
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
          assert.isTrue(
            (yield* queue.enqueue({
              ...original,
              eventId: KinEventId.make(`${tag}-replay`),
            })).duplicate,
          );
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

  it.effect("holds deferred events until eligible without delaying ready events", () =>
    Effect.gen(function* () {
      yield* seed();
      const queue = yield* KinEventQueue.KinEventQueue;
      const sql = yield* SqlClient.SqlClient;
      yield* queue.enqueue(yield* event("deferred"));
      yield* sql`UPDATE kin_events SET not_before = 60000 WHERE event_id = 'deferred'`;
      yield* queue.enqueue(yield* event("ready"));
      const first = yield* Effect.scoped(queue.claim(input("ready-batch"))).pipe(Effect.forkChild);
      yield* TestClock.adjust("20 seconds");
      assert.deepStrictEqual(
        (yield* Fiber.join(first)).map((entry) => entry.eventId),
        ["ready"],
      );
      yield* finish("ready-batch");
      const later = yield* Effect.scoped(queue.claim(input("deferred-batch"))).pipe(
        Effect.forkChild,
      );
      yield* TestClock.adjust("39 seconds");
      assert.deepStrictEqual(
        yield* sql`SELECT state, not_before FROM kin_events WHERE event_id = 'deferred'`,
        [{ state: "queued", not_before: 60000 }],
      );
      yield* TestClock.adjust("1 second");
      assert.deepStrictEqual(
        (yield* Fiber.join(later)).map((entry) => entry.eventId),
        ["deferred"],
      );
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
        yield* finish("completed");
        yield* queue.enqueue(yield* event("waiting"));
        yield* TestClock.adjust("20 seconds");
        const recovered = yield* Effect.gen(function* () {
          const restarted = yield* KinEventQueue.KinEventQueue;
          const overlapping = yield* Effect.scoped(restarted.claim(input("overlapping"))).pipe(
            Effect.exit,
          );
          assert.isTrue(Exit.isFailure(overlapping));
          assert.deepStrictEqual(
            yield* sql`SELECT state, attempts FROM kin_events WHERE event_id = 'waiting'`,
            [{ state: "queued", attempts: 0 }],
          );
          assert.strictEqual(
            yield* restarted.requeueUnfinished(KinOrgId.make("b"), "unfinished"),
            0,
          );
          assert.strictEqual(
            yield* restarted.requeueUnfinished(KinOrgId.make("b"), "completed"),
            0,
          );
          assert.strictEqual(
            yield* restarted.requeueUnfinished(KinOrgId.make("a"), "unfinished"),
            1,
          );
          assert.strictEqual(
            yield* restarted.requeueUnfinished(KinOrgId.make("a"), "unfinished"),
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
            { state: "done", wakeup_id: "completed", attempts: 1 },
            { state: "claimed", wakeup_id: "retried", attempts: 2 },
            { state: "claimed", wakeup_id: "retried", attempts: 1 },
          ],
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "holds one writer per organization across the caller scope while other organizations proceed",
    () =>
      Effect.gen(function* () {
        yield* seed();
        yield* seed("b");
        const queue = yield* KinEventQueue.KinEventQueue;
        const sql = yield* SqlClient.SqlClient;
        const acquired = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        yield* queue.enqueue(yield* event("a-first"));
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
        const other = yield* Effect.scoped(queue.claim(input("b-first", "b"))).pipe(
          Effect.forkChild,
        );
        assert.deepStrictEqual(
          (yield* Fiber.join(other)).map((entry) => entry.eventId),
          ["b-first"],
        );
        yield* TestClock.adjust("20 seconds");
        assert.deepStrictEqual(yield* sql`SELECT wakeup_id FROM kin_wakeups WHERE org_id = 'a'`, [
          { wakeup_id: "a-first" },
        ]);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(first);
        assert.deepStrictEqual(
          (yield* Fiber.join(next)).map((entry) => entry.eventId),
          ["a-next"],
        );
        assert.deepStrictEqual(yield* sql`SELECT state FROM kin_events WHERE org_id = 'b'`, [
          { state: "claimed" },
        ]);
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "wakes empty queues on enqueue and releases the organization permit on interruption",
    () =>
      Effect.gen(function* () {
        yield* seed();
        const queue = yield* KinEventQueue.KinEventQueue;
        const cancelled = yield* Effect.scoped(queue.claim(input("cancelled"))).pipe(
          Effect.forkChild,
        );
        yield* TestClock.adjust("1 second");
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
        UPDATE kin_events SET state = 'claimed', wakeup_id = 'next', attempts = attempts + 1
        WHERE event_id IN (SELECT event_id FROM kin_events
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
