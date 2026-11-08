import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  KinPersonId,
  KinWakeupId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as DateTime from "effect/DateTime";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as EffectWorker from "../../orchestration-v2/EffectWorker.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { provideDeterministicTestRuntime } from "../../orchestration-v2/testkit/DeterministicRuntime.ts";
import * as KinEventQueue from "./KinEventQueue.ts";
import * as KinStop from "./KinStop.ts";
import * as WakeupRunner from "./WakeupRunner.ts";
import { agentId, event, harness, orgId, seed } from "./WakeupRunner.testkit.ts";

const owner = [{ _tag: "person" as const, orgId, personId: KinPersonId.make("owner") }];

describe("KinStop", () => {
  it.effect(
    "stops a running wake-up and worker, holds their events and stays paused when pressed twice",
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        yield* Effect.gen(function* () {
          yield* seed;
          const sql = yield* SqlClient.SqlClient;
          const queue = yield* KinEventQueue.KinEventQueue;
          const runner = yield* WakeupRunner.WakeupRunner;
          const stop = yield* KinStop.KinStop;
          const threads = yield* ThreadManagement.ThreadManagementService;
          const launch = yield* ThreadLaunch.ThreadLaunchService;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const delegated: Array<ThreadId> = [];
          yield* stop.attach(
            yield* KinStop.makeFanOut(Option.none()).pipe(
              Effect.provideService(ThreadManagement.ThreadManagementService, {
                ...threads,
                stopDelegatedTasks: (input) =>
                  Effect.sync(() => delegated.push(input.threadId)).pipe(
                    Effect.andThen(threads.stopDelegatedTasks(input)),
                  ),
              }),
            ),
          );

          yield* queue.enqueue(event("work"));
          const wakeup = yield* runner.runOnce(orgId, agentId).pipe(Effect.forkChild);
          yield* TestClock.adjust("20 seconds");
          yield* Deferred.await(entered);
          const [running] = yield* sql<{
            wakeupId: string;
            threadId: string;
          }>`SELECT wakeup_id AS "wakeupId", thread_id AS "threadId" FROM kin_wakeups WHERE org_id = ${orgId} ORDER BY wakeup_id`;
          const leadThread = ThreadId.make(running!.threadId);

          const workerThread = ThreadId.make("kin-worker-stop-test");
          yield* launch.launch({
            commandId: CommandId.make("kin-worker:stop-test"),
            threadId: workerThread,
            projectId: ProjectId.make("kin:org"),
            title: "Worker",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5.1-codex",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            workspaceStrategy: { type: "root" },
            initialMessage: {
              messageId: MessageId.make("kin-worker-msg:stop-test"),
              text: "Work",
              attachments: [],
            },
            createdBy: "agent",
            creationSource: "server",
          });
          yield* sql`INSERT INTO kin_workers (worker_id, org_id, agent_id, wakeup_id, kind, thread_id, model_json, provenance_json, status, started_at)
            VALUES ('worker', ${orgId}, ${agentId}, ${running!.wakeupId}, 'build', ${workerThread}, '{}', '{"_tag":"system"}', 'running', 0)`;
          yield* worker.drain();
          const live = (threadId: ThreadId) =>
            threads
              .getThreadProjection(threadId)
              .pipe(Effect.map((projection) => projection.runs.at(-1)?.status));
          assert.include(ThreadManagement.ACTIVE_RUN_STATUSES, yield* live(workerThread));

          const paused = yield* stop.pause(owner, { orgId, reason: "Testing" });
          assert.include(paused, { paused: true, pausedBy: "owner", reason: "Testing" });
          yield* worker.drain();
          yield* Fiber.join(wakeup);

          assert.strictEqual(yield* live(leadThread), "interrupted");
          assert.strictEqual(yield* live(workerThread), "interrupted");
          assert.sameMembers(delegated, [leadThread, workerThread]);
          assert.deepStrictEqual(
            yield* sql`SELECT status FROM kin_wakeups WHERE org_id = ${orgId} ORDER BY wakeup_id`,
            [{ status: "released" }],
          );
          const now = yield* Clock.currentTimeMillis;
          assert.deepStrictEqual(
            yield* sql`SELECT state, attempts, not_before FROM kin_events WHERE org_id = ${orgId} ORDER BY event_id`,
            [{ state: "queued", attempts: 0, not_before: now + KinStop.PAUSE_POLL_INTERVAL_MS }],
          );

          assert.deepStrictEqual(yield* stop.pause(owner, { orgId }), paused);
          assert.deepStrictEqual(
            yield* sql`SELECT body FROM kin_messages WHERE org_id = ${orgId} ORDER BY seq`,
            [{ body: KinStop.PAUSED_NOTICE }],
          );

          yield* queue.enqueue(event("held"));
          yield* TestClock.adjust("2 minutes");
          yield* runner.runOnce(orgId, agentId);
          assert.lengthOf(
            yield* sql`SELECT 1 FROM kin_wakeups WHERE org_id = ${orgId} ORDER BY wakeup_id`,
            1,
          );
          assert.deepStrictEqual(
            yield* sql`SELECT state FROM kin_events WHERE org_id = ${orgId} ORDER BY event_id`,
            [{ state: "queued" }, { state: "queued" }],
          );
        }).pipe(Effect.provide(harness({ entered, untilInterrupted: true })));
      }).pipe(provideDeterministicTestRuntime),
  );

  it.effect("resumes once with one resume event and expires events queued over a day ago", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const queue = yield* KinEventQueue.KinEventQueue;
      const stop = yield* KinStop.KinStop;
      const paused = yield* stop.pause(owner, { orgId });
      assert.isTrue(yield* stop.isPaused(orgId));
      yield* queue.enqueue(event("old"));
      yield* TestClock.adjust("25 hours");
      yield* queue.enqueue(event("fresh"));

      const resumed = yield* stop.resume(owner, { orgId });
      assert.deepStrictEqual(resumed, {
        orgId,
        paused: false,
        pausedAt: null,
        pausedBy: null,
        reason: null,
      });
      assert.deepStrictEqual(yield* stop.resume(owner, { orgId }), resumed);
      assert.isFalse(yield* stop.isPaused(orgId));
      assert.deepStrictEqual(
        yield* sql`SELECT event_id, state FROM kin_events WHERE org_id = ${orgId} AND tag != 'resume' ORDER BY event_id`,
        [
          { event_id: "fresh", state: "queued" },
          { event_id: "old", state: "expired" },
        ],
      );
      const resumes = yield* sql<{
        json: string;
        priority: string;
      }>`SELECT json, priority FROM kin_events WHERE org_id = ${orgId} AND tag = 'resume' ORDER BY event_id`;
      assert.lengthOf(resumes, 1);
      assert.strictEqual(resumes[0]!.priority, "P0");
      assert.isTrue(paused.paused);
      assert.include(JSON.parse(resumes[0]!.json), {
        _tag: "resume",
        pausedAt: paused.pausedAt === null ? null : DateTime.formatIso(paused.pausedAt),
      });
      assert.deepStrictEqual(JSON.parse(resumes[0]!.json).expired, {
        count: 1,
        events: [{ eventId: "old", tag: "routine", receivedAt: "2026-11-08T00:00:00.000Z" }],
      });

      yield* TestClock.adjust("2 seconds");
      const batch = yield* Effect.scoped(
        queue.claim({ orgId, agentId, wakeupId: KinWakeupId.make("resumed"), model: "test" }),
      );
      assert.deepStrictEqual(
        batch.map((item) => item._tag),
        ["resume", "routine"],
      );
    }).pipe(Effect.provide(harness()), provideDeterministicTestRuntime),
  );
});
