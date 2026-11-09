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
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as DateTime from "effect/DateTime";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as EffectWorker from "../../orchestration-v2/EffectWorker.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { provideDeterministicTestRuntime } from "../../orchestration-v2/testkit/DeterministicRuntime.ts";
import * as Routines from "../triggers/routines.ts";
import * as KinEventQueue from "./KinEventQueue.ts";
import * as KinStop from "./KinStop.ts";
import * as WakeupRunner from "./WakeupRunner.ts";
import { agentId, event, harness, orgId, seed } from "./WakeupRunner.testkit.ts";

const owner = [{ _tag: "person" as const, orgId, personId: KinPersonId.make("owner") }];

/** Starts a fake-provider run on a new thread; under `untilInterrupted` it runs until stopped. */
const launchThread = Effect.fn("KinStopTest.launchThread")(function* (threadId: ThreadId) {
  const launch = yield* ThreadLaunch.ThreadLaunchService;
  yield* launch.launch({
    commandId: CommandId.make(`launch:${threadId}`),
    threadId,
    projectId: ProjectId.make("kin:org"),
    title: "Work",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    workspaceStrategy: { type: "root" },
    initialMessage: { messageId: MessageId.make(`msg:${threadId}`), text: "Work", attachments: [] },
    createdBy: "agent",
    creationSource: "server",
  });
});
const lastRunStatus = (threadId: ThreadId) =>
  Effect.flatMap(ThreadManagement.ThreadManagementService, (threads) =>
    threads
      .getThreadProjection(threadId)
      .pipe(Effect.map((projection) => projection.runs.at(-1)?.status)),
  );
/** Routines that record each pause and resume; `pauseAll` may be slowed down. */
const recordingRoutines = (
  log: Array<string>,
  beforePause: Effect.Effect<void> = Effect.void,
  resumeAll: Routines.KinRoutines["Service"]["resumeAll"] = () =>
    Effect.sync(() => void log.push("resume")),
) =>
  Effect.asSome(
    Routines.KinRoutines.pipe(
      Effect.provide(
        Layer.mock(Routines.KinRoutines)({
          pauseAll: () =>
            beforePause.pipe(Effect.andThen(Effect.sync(() => void log.push("pause")))),
          resumeAll,
        }),
      ),
    ),
  );

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
          yield* launchThread(workerThread);
          yield* sql`INSERT INTO kin_workers (worker_id, org_id, agent_id, wakeup_id, kind, thread_id, model_json, provenance_json, status, started_at)
            VALUES ('worker', ${orgId}, ${agentId}, ${running!.wakeupId}, 'build', ${workerThread}, '{}', '{"_tag":"system"}', 'running', 0)`;
          const dreamThread = ThreadId.make("kin-dream:dream-stop-test:extract");
          yield* launchThread(dreamThread);
          yield* sql`INSERT INTO kin_dream_runs (org_id, owner_date, dream_id, full, status, branch, material_from, material_until, started_at, thread_id)
            VALUES (${orgId}, '2026-11-08', 'dream-stop-test', 0, 'running', 'dream/2026-11-08', 0, 0, 0, ${dreamThread})`;
          yield* worker.drain();
          const live = lastRunStatus;
          assert.include(ThreadManagement.ACTIVE_RUN_STATUSES, yield* live(workerThread));
          assert.include(ThreadManagement.ACTIVE_RUN_STATUSES, yield* live(dreamThread));

          const paused = yield* stop.pause(owner, { orgId, reason: "Testing" });
          assert.include(paused, { paused: true, pausedBy: owner[0]!.personId, reason: "Testing" });
          yield* worker.drain();
          yield* Fiber.join(wakeup);

          assert.strictEqual(yield* live(leadThread), "interrupted");
          assert.strictEqual(yield* live(workerThread), "interrupted");
          assert.strictEqual(yield* live(dreamThread), "interrupted");
          assert.sameMembers(delegated, [leadThread, workerThread, dreamThread]);
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
      // A retired lead's old chat gets no pause or resume notices.
      yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at, retired_at) VALUES ('old-lead', 'org', 'Old', 'lead', 'owner', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z')`;
      yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at) VALUES ('old-chat', 'org', 'team_group', 0, '1970-01-01T00:00:00.000Z')`;
      yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id) VALUES ('old-lead', 'org', 'Old', 0, '{}', '[]', 'old-chat')`;
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
        yield* sql`SELECT author_kind, body FROM kin_messages WHERE org_id = ${orgId} ORDER BY seq`,
        [
          { author_kind: "system", body: KinStop.PAUSED_NOTICE },
          { author_kind: "system", body: "Kin resumed. 1 queued event expired." },
        ],
      );
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
  it.effect(
    "a pause that lands while the runner launches interrupts the new run and returns its events",
    () =>
      Effect.gen(function* () {
        const ready = yield* Deferred.make<KinStop.KinStop["Service"]>();
        // Pausing inside the wake-up, with no fan-out attached, leaves only the post-launch recheck.
        const prepare = () =>
          Deferred.await(ready).pipe(
            Effect.flatMap((stop) => stop.pause(owner, { orgId })),
            Effect.orDie,
            Effect.as({ head: "abc", indexAsOf: DateTime.makeUnsafe("2026-11-08T00:00:00.000Z") }),
          );
        yield* Effect.gen(function* () {
          yield* seed;
          const sql = yield* SqlClient.SqlClient;
          const queue = yield* KinEventQueue.KinEventQueue;
          const runner = yield* WakeupRunner.WakeupRunner;
          yield* Deferred.succeed(ready, yield* KinStop.KinStop);
          yield* queue.enqueue(event("work"));
          const wakeup = yield* runner.runOnce(orgId, agentId).pipe(Effect.forkChild);
          yield* TestClock.adjust("20 seconds");
          // The recheck's interrupt is what ends the turn; assert it before waiting on the run.
          yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
          const [launched] = yield* sql<{ threadId: string }>`SELECT thread_id AS "threadId"
            FROM kin_wakeups WHERE org_id = ${orgId} ORDER BY wakeup_id`;
          assert.strictEqual(
            yield* lastRunStatus(ThreadId.make(launched!.threadId)),
            "interrupted",
          );
          yield* Fiber.join(wakeup);
          const [row] = yield* sql<{
            status: string;
            threadId: string;
          }>`SELECT status, thread_id AS "threadId" FROM kin_wakeups WHERE org_id = ${orgId} ORDER BY wakeup_id`;
          assert.strictEqual(row!.status, "released");
          assert.strictEqual(yield* lastRunStatus(ThreadId.make(row!.threadId)), "interrupted");
          const now = yield* Clock.currentTimeMillis;
          assert.deepStrictEqual(
            yield* sql`SELECT state, attempts, not_before FROM kin_events WHERE org_id = ${orgId} ORDER BY event_id`,
            [{ state: "queued", attempts: 0, not_before: now + KinStop.PAUSE_POLL_INTERVAL_MS }],
          );
        }).pipe(Effect.provide(harness({ untilInterrupted: true, prepare })));
      }).pipe(provideDeterministicTestRuntime),
  );

  it.effect("a thread that cannot be stopped still lets the others and routines pause", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const stop = yield* KinStop.KinStop;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const log: Array<string> = [];
      const broken = ThreadId.make("broken-lead-thread");
      yield* stop.attach(
        yield* KinStop.makeFanOut(yield* recordingRoutines(log)).pipe(
          Effect.provideService(ThreadManagement.ThreadManagementService, {
            ...threads,
            getThreadProjection: (threadId) =>
              threadId === broken
                ? Effect.die("unreadable projection")
                : threads.getThreadProjection(threadId),
          }),
        ),
      );
      yield* sql`UPDATE kin_leads SET thread_id = ${broken} WHERE org_id = ${orgId} AND agent_id = ${agentId}`;
      const workerThread = ThreadId.make("kin-worker-stop-test");
      yield* launchThread(workerThread);
      yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, model, started_at, status, event_ids) VALUES ('wake', ${orgId}, ${agentId}, 'test', 0, 'completed', '[]')`;
      yield* sql`INSERT INTO kin_workers (worker_id, org_id, agent_id, wakeup_id, kind, thread_id, model_json, provenance_json, status, started_at)
        VALUES ('worker', ${orgId}, ${agentId}, 'wake', 'build', ${workerThread}, '{}', '{"_tag":"system"}', 'running', 0)`;
      yield* worker.drain();

      const failure = yield* Effect.flip(stop.pause(owner, { orgId }));
      assert.include(failure, { _tag: "KinChatError", reason: "unavailable" });
      yield* worker.drain();
      assert.strictEqual(yield* lastRunStatus(workerThread), "interrupted");
      assert.deepStrictEqual(log, ["pause"]);
      assert.isTrue(yield* stop.isPaused(orgId));
    }).pipe(Effect.provide(harness({ untilInterrupted: true })), provideDeterministicTestRuntime),
  );

  it.effect("a resume during a slow pause fan-out waits for it and leaves routines running", () =>
    Effect.gen(function* () {
      yield* seed;
      const stop = yield* KinStop.KinStop;
      const entered = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const log: Array<string> = [];
      yield* stop.attach(
        yield* KinStop.makeFanOut(
          yield* recordingRoutines(
            log,
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(gate))),
          ),
        ),
      );
      const pausing = yield* stop.pause(owner, { orgId }).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const resuming = yield* Effect.sleep("1 second").pipe(
        Effect.andThen(stop.resume(owner, { orgId })),
        Effect.forkChild,
      );
      // Runs the resume until it finishes or blocks, with routines still pausing.
      yield* TestClock.adjust("1 second");
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(pausing);
      yield* Fiber.join(resuming);
      assert.deepStrictEqual(log, ["pause", "resume"]);
      assert.isFalse(yield* stop.isPaused(orgId));
    }).pipe(Effect.provide(harness()), provideDeterministicTestRuntime),
  );

  it.effect("attach resumes routines a resume left paused while detached or failing", () =>
    Effect.gen(function* () {
      yield* seed;
      const stop = yield* KinStop.KinStop;
      const log: Array<string> = [];
      const failing = yield* recordingRoutines(log, Effect.void, () =>
        Effect.fail(new Routines.KinRoutinesError({ orgId, cause: "unavailable" })),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* stop.attach(yield* KinStop.makeFanOut(failing));
          yield* stop.pause(owner, { orgId });
          yield* stop.resume(owner, { orgId });
        }),
      );
      // A restart: this pause and resume run before the lead runtime attaches.
      yield* TestClock.adjust("1 second");
      yield* stop.pause(owner, { orgId });
      yield* stop.resume(owner, { orgId });
      assert.deepStrictEqual(log, ["pause"]);

      yield* stop.attach(yield* KinStop.makeFanOut(yield* recordingRoutines(log)));
      assert.deepStrictEqual(log, ["pause", "resume"]);
      assert.isFalse(yield* stop.isPaused(orgId));
    }).pipe(Effect.provide(harness()), provideDeterministicTestRuntime),
  );

  it.effect("a startup replay stops with new command ids; a repeat press reuses them", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const stop = yield* KinStop.KinStop;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const commandIds: Array<string> = [];
      const fanOut = KinStop.makeFanOut(Option.none()).pipe(
        Effect.provideService(ThreadManagement.ThreadManagementService, {
          ...threads,
          stopDelegatedTasks: (input) =>
            Effect.sync(() => commandIds.push(input.commandId)).pipe(
              Effect.andThen(threads.stopDelegatedTasks(input)),
            ),
        }),
      );
      const leadThread = ThreadId.make("kin-lead-stop-test");
      yield* launchThread(leadThread);
      yield* sql`UPDATE kin_leads SET thread_id = ${leadThread} WHERE org_id = ${orgId} AND agent_id = ${agentId}`;
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* stop.attach(yield* fanOut);
          yield* stop.pause(owner, { orgId });
          yield* stop.pause(owner, { orgId });
        }),
      );
      // Recovery keeps the run id, so only the boot tells the replay from the first fan-out.
      yield* stop.attach(yield* fanOut);
      assert.lengthOf(commandIds, 3);
      assert.strictEqual(commandIds[1], commandIds[0]);
      assert.notStrictEqual(commandIds[2], commandIds[1]);
    }).pipe(Effect.provide(harness()), provideDeterministicTestRuntime),
  );
});
