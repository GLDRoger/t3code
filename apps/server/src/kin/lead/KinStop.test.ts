import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  KinAgentId,
  KinChatId,
  KinMemberId,
  KinMessageId,
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
import * as Queue from "effect/Queue";
import * as DateTime from "effect/DateTime";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as EffectWorker from "../../orchestration-v2/EffectWorker.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { provideDeterministicTestRuntime } from "../../orchestration-v2/testkit/DeterministicRuntime.ts";
import { KinRefreshObserver } from "../chat/KinRefreshHub.ts";
import { KinHostCare } from "../host/KinHostCare.ts";
import { KinReplyBridge } from "../reply/KinReplyBridge.ts";
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
    modelSelection: {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-opus-4-6",
    },
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
    "stops a running wake-up and chat session, holds their events and stays paused when pressed twice",
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

          const dreamThread = ThreadId.make("kin-dream:dream-stop-test:extract");
          yield* launchThread(dreamThread);
          yield* sql`INSERT INTO kin_dream_runs (org_id, owner_date, dream_id, full, status, branch, material_from, material_until, started_at, thread_id)
            VALUES (${orgId}, '2026-11-08', 'dream-stop-test', 0, 'running', 'dream/2026-11-08', 0, 0, 0, ${dreamThread})`;
          // A chat's session is a thread too, stopped with the lead's; one already ended is left.
          const localThread = ThreadId.make("kin-chat:session");
          yield* launchThread(localThread);
          yield* sql`INSERT INTO kin_agent_threads (thread_id, org_id, agent_id, started_at, ended_at)
            VALUES (${localThread}, ${orgId}, ${agentId}, '2026-11-09T00:00:00.000Z', NULL),
              ('kin-chat:ended', ${orgId}, ${agentId}, '2026-11-09T00:00:00.000Z', '2026-11-09T01:00:00.000Z')`;
          yield* worker.drain();
          const live = lastRunStatus;
          assert.include(ThreadManagement.ACTIVE_RUN_STATUSES, yield* live(dreamThread));
          assert.include(ThreadManagement.ACTIVE_RUN_STATUSES, yield* live(localThread));

          const paused = yield* stop.pause(owner, { orgId, reason: "Testing" });
          assert.include(paused, { paused: true, pausedBy: owner[0]!.personId, reason: "Testing" });
          yield* worker.drain();
          yield* Fiber.join(wakeup);

          assert.strictEqual(yield* live(leadThread), "interrupted");
          assert.strictEqual(yield* live(dreamThread), "interrupted");
          assert.strictEqual(yield* live(localThread), "interrupted");
          assert.sameMembers(delegated, [leadThread, dreamThread, localThread]);
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

  // QA: Stop pressed twice answered true both times, so a client couldn't tell it was done.
  it.effect("an owner's stop answers true once, then false while the wake-up winds down", () =>
    Effect.gen(function* () {
      const entered = yield* Queue.unbounded<ThreadId>();
      // Whatever a failure would set off: a trouble's notice, or a line in the chat.
      const failures: Array<string> = [];
      const care = Layer.succeed(
        KinHostCare,
        KinHostCare.of({
          host: true,
          clean: () => Effect.die("not cleaned here"),
          spaceFailed: () => Effect.succeed(false),
          storageFailed: () => Effect.void,
          storageRecovered: () => Effect.void,
          devFullDisk: Effect.void,
          failed: (input) => Effect.sync(() => (failures.push(`notice ${input.cause}`), true)),
          succeeded: () => Effect.void,
          troubleOpen: () => Effect.succeed(false),
          causeFor: () => Effect.undefined,
          refresh: () => Effect.void,
          checkBackup: () => Effect.void,
          status: () => Effect.die("not read here"),
          freeSpace: () => Effect.die("not tapped here"),
          backUpNow: () => Effect.die("not tapped here"),
          retry: () => Effect.die("not tapped here"),
        }),
      );
      const bridge = Layer.mock(KinReplyBridge)({
        lane: () =>
          Effect.succeedSome({
            chatId: KinChatId.make("owner-chat"),
            mode: "reply" as const,
            owed: true,
            leadName: "Lead",
          }),
        preparing: () => Effect.void,
        begin: () => Effect.void,
        complete: () => Effect.void,
        end: () => Effect.void,
        failed: (input) => Effect.sync(() => void failures.push(`line ${input.outcome}`)),
      });
      yield* Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const queue = yield* KinEventQueue.KinEventQueue;
        const runner = yield* WakeupRunner.WakeupRunner;
        const stop = yield* KinStop.KinStop;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* stop.attach(yield* KinStop.makeFanOut(Option.none()));
        yield* queue.enqueue(event("work"));
        yield* queue.enqueue(event("more-work"));
        const run = yield* runner.runOnce(orgId, agentId).pipe(Effect.forkChild);
        yield* TestClock.adjust("20 seconds");
        yield* Queue.take(entered);
        const [running] = yield* sql<{ wakeupId: KinWakeupId }>`SELECT wakeup_id AS "wakeupId"
          FROM kin_wakeups WHERE org_id = ${orgId} AND status = 'running' ORDER BY wakeup_id`;
        const input = { orgId, wakeupId: running!.wakeupId };
        assert.deepStrictEqual(yield* stop.interrupt(owner, input), { interrupted: true });
        assert.deepStrictEqual(yield* stop.interrupt(owner, input), { interrupted: false });
        yield* worker.drain();
        yield* Fiber.join(run);
        assert.deepStrictEqual(yield* stop.interrupt(owner, input), { interrupted: false });
        // A deliberate stop is no failure, and the chat says who stopped it, once.
        assert.deepStrictEqual(
          yield* sql`SELECT status FROM kin_wakeups WHERE org_id = ${orgId} ORDER BY wakeup_id`,
          [{ status: "interrupted" }],
        );
        assert.deepStrictEqual(
          yield* sql`SELECT chat_id, body FROM kin_messages WHERE org_id = ${orgId} ORDER BY seq`,
          [{ chat_id: "owner-chat", body: "Owner stopped Lead." }],
        );
        // Its batch is over: not split to run alone, no try spent, nothing held for a trouble.
        assert.deepStrictEqual(
          yield* sql`SELECT event_id, state, attempts, json_extract(json, '$._retryAlone') AS alone,
            held_by FROM kin_events WHERE org_id = ${orgId} ORDER BY event_id`,
          [
            { event_id: "more-work", state: "done", attempts: 0, alone: null, held_by: null },
            { event_id: "work", state: "done", attempts: 0, alone: null, held_by: null },
          ],
        );
        assert.deepStrictEqual(failures, []);
      }).pipe(
        Effect.provide(
          harness({
            untilInterrupted: true,
            onTurn: ({ threadId }) => Queue.offer(entered, threadId).pipe(Effect.asVoid),
          }).pipe(Layer.provide(Layer.mergeAll(care, bridge))),
        ),
      );
    }).pipe(provideDeterministicTestRuntime),
  );

  it.effect("a stop on a turn a trouble holds drops it and says so once", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const queue = yield* KinEventQueue.KinEventQueue;
      const stop = yield* KinStop.KinStop;
      yield* stop.attach(yield* KinStop.makeFanOut(Option.none()));
      yield* queue.enqueue(event("held"));
      yield* queue.enqueue(event("other"));
      const wakeupId = KinWakeupId.make("wake-held");
      const claim = yield* Effect.scoped(
        queue.claim({ orgId, agentId, wakeupId, model: "test-model" }),
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("20 seconds");
      yield* Fiber.join(claim);
      // Its start failed for a cause Kin waits out: the batch waits, held by that trouble.
      const holdUntil = (yield* Clock.currentTimeMillis) + 3_600_000;
      yield* queue.finish({ orgId, wakeupId, status: "failed", holdUntil });
      yield* sql`UPDATE kin_events SET held_by = 'trouble-1' WHERE org_id = ${orgId}`;
      const input = { orgId, wakeupId };
      assert.deepStrictEqual(yield* stop.interrupt(owner, input), { interrupted: true });
      assert.deepStrictEqual(yield* stop.interrupt(owner, input), { interrupted: false });
      assert.deepStrictEqual(
        yield* sql`SELECT event_id, state, held_by FROM kin_events WHERE org_id = ${orgId}
          ORDER BY event_id`,
        [
          { event_id: "held", state: "done", held_by: null },
          { event_id: "other", state: "done", held_by: null },
        ],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT chat_id, body FROM kin_messages WHERE org_id = ${orgId} ORDER BY seq`,
        [{ chat_id: "owner-chat", body: "Owner stopped Lead." }],
      );
    }).pipe(Effect.provide(harness()), provideDeterministicTestRuntime),
  );

  it.effect("a stopped turn of a batch split to run alone ends only that one", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const queue = yield* KinEventQueue.KinEventQueue;
      yield* queue.enqueue(event("first"));
      yield* queue.enqueue(event("second"));
      const claimAs = (id: string) =>
        Effect.gen(function* () {
          const wakeupId = KinWakeupId.make(id);
          const claim = yield* Effect.scoped(
            queue.claim({ orgId, agentId, wakeupId, model: "test-model" }),
          ).pipe(Effect.forkChild);
          yield* TestClock.adjust("20 seconds");
          return { wakeupId, claimed: (yield* Fiber.join(claim)).map((one) => one.eventId) };
        });
      const batch = yield* claimAs("wake-batch");
      assert.deepStrictEqual(batch.claimed, ["first", "second"]);
      // A silent batch failure: each event runs again on its own.
      yield* queue.finish({ orgId, wakeupId: batch.wakeupId, status: "failed" });
      const alone = yield* claimAs("wake-alone");
      assert.strictEqual(alone.claimed.length, 1);
      yield* queue.finish({ orgId, wakeupId: alone.wakeupId, status: "interrupted" });
      assert.deepStrictEqual(
        yield* sql`SELECT state, json_extract(json, '$._retryAlone') AS alone, attempts
          FROM kin_events WHERE org_id = ${orgId} ORDER BY state`,
        [
          { state: "done", alone: 1, attempts: 0 },
          { state: "queued", alone: 1, attempts: 0 },
        ],
      );
    }).pipe(Effect.provide(harness()), provideDeterministicTestRuntime),
  );

  it.effect("stops two leads' running wake-ups at once and starts none until resume", () =>
    Effect.gen(function* () {
      const enteredThreads = yield* Queue.unbounded<ThreadId>();
      yield* Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const queue = yield* KinEventQueue.KinEventQueue;
        const runner = yield* WakeupRunner.WakeupRunner;
        const stop = yield* KinStop.KinStop;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* stop.attach(yield* KinStop.makeFanOut(Option.none()));
        yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
          SELECT 'lead-z', org_id, display_name, role, owner_person_id, created_at FROM kin_agents WHERE agent_id = 'lead'`;
        yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id)
          SELECT 'lead-z', org_id, name, level_since, models_json, worker_projects_json, owner_chat_id FROM kin_leads WHERE agent_id = 'lead'`;
        const otherLead = KinAgentId.make("lead-z");
        yield* queue.enqueue(event("work"));
        yield* queue.enqueue({ ...event("other-work"), agentId: otherLead });
        const first = yield* runner.runOnce(orgId, agentId).pipe(Effect.forkChild);
        const second = yield* runner.runOnce(orgId, otherLead).pipe(Effect.forkChild);
        yield* TestClock.adjust("20 seconds");
        const threads = [yield* Queue.take(enteredThreads), yield* Queue.take(enteredThreads)];
        assert.deepStrictEqual(
          yield* sql`SELECT agent_id FROM kin_wakeups WHERE org_id = ${orgId} AND status = 'running' ORDER BY agent_id`,
          [{ agent_id: "lead" }, { agent_id: "lead-z" }],
        );

        const paused = yield* stop.pause(owner, { orgId });
        assert.isTrue(paused.paused);
        yield* worker.drain();
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        for (const threadId of threads)
          assert.strictEqual(yield* lastRunStatus(threadId), "interrupted");
        assert.deepStrictEqual(
          yield* sql`SELECT status FROM kin_wakeups WHERE org_id = ${orgId} ORDER BY wakeup_id`,
          [{ status: "released" }, { status: "released" }],
        );
        assert.deepStrictEqual(
          yield* sql`SELECT state, attempts FROM kin_events WHERE org_id = ${orgId} ORDER BY event_id`,
          [
            { state: "queued", attempts: 0 },
            { state: "queued", attempts: 0 },
          ],
        );

        yield* queue.enqueue(event("held"));
        yield* TestClock.adjust("2 minutes");
        yield* runner.runOnce(orgId, agentId);
        yield* runner.runOnce(orgId, otherLead);
        assert.lengthOf(
          yield* sql`SELECT 1 FROM kin_wakeups WHERE org_id = ${orgId} ORDER BY wakeup_id`,
          2,
        );
        const resumed = yield* stop.resume(owner, { orgId });
        assert.isFalse(resumed.paused);
      }).pipe(
        Effect.provide(
          harness({
            untilInterrupted: true,
            onTurn: ({ threadId }) => Queue.offer(enteredThreads, threadId).pipe(Effect.asVoid),
          }),
        ),
      );
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
      // Each real change moves the topic open screens follow; a repeat moves nothing.
      const touched: Array<string> = [];
      const told = Effect.provideService(KinRefreshObserver, {
        touch: (org, topic) => Effect.sync(() => void touched.push(`${org}:${topic}`)),
      });
      const paused = yield* stop.pause(owner, { orgId }).pipe(told);
      yield* stop.pause(owner, { orgId }).pipe(told);
      assert.deepStrictEqual(touched, [`${orgId}:stop`]);
      assert.isTrue(yield* stop.isPaused(orgId));
      const directChat = KinChatId.make("direct");
      const groupChat = KinChatId.make("renewals");
      const meera = KinPersonId.make("meera");
      const createdAt = "2026-11-08T00:00:00.000Z";
      yield* sql`UPDATE kin_chats SET title = 'Chief of staff' WHERE org_id = ${orgId} AND chat_id = 'owner-chat'`;
      yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, title, direct_key, last_seq, created_at)
        VALUES (${directChat}, ${orgId}, 'direct', NULL, 'meera:lead', 1, ${createdAt}),
          (${groupChat}, ${orgId}, 'project_group', 'Renewals', NULL, 1, ${createdAt})`;
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
        VALUES (${meera}, ${orgId}, 'meera', 'Meera', ${createdAt})`;
      yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, agent_id, role, joined_at)
        VALUES ('direct-lead', ${orgId}, ${directChat}, 'agent', ${agentId}, 'member', ${createdAt})`;
      for (const [id, chatId] of [
        ["old-direct", directChat],
        ["old-group", groupChat],
      ] as const) {
        const memberId = KinMemberId.make(`member-${id}`);
        const messageId = KinMessageId.make(`message-${id}`);
        yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
          VALUES (${memberId}, ${orgId}, ${chatId}, 'person', ${meera}, 'member', ${createdAt})`;
        yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind,
          author_person_id, author_member_id, author_role, kind, body, mentions_json, status, created_at)
          VALUES (${messageId}, ${orgId}, ${chatId}, 1, 'human', ${meera}, ${memberId}, 'member',
            'text', 'Can you check the renewal?', '[]', 'posted', ${createdAt})`;
        yield* queue.enqueue({
          ...event(id),
          _tag: "chat.message",
          provenance: { _tag: "human", personId: meera, memberId },
          chatId,
          messageId,
        });
      }
      for (let n = 0; n < 10; n++)
        yield* queue.enqueue({
          ...event(`routine-${n}`),
          receivedAt: DateTime.makeUnsafe("2026-11-08T00:01:00.000Z"),
        });
      yield* TestClock.adjust("25 hours");
      yield* queue.enqueue(event("fresh"));

      const resumed = yield* stop.resume(owner, { orgId }).pipe(told);
      assert.deepStrictEqual(resumed, {
        orgId,
        paused: false,
        pausedAt: null,
        pausedBy: null,
        reason: null,
      });
      assert.deepStrictEqual(yield* stop.resume(owner, { orgId }).pipe(told), resumed);
      assert.deepStrictEqual(touched, [`${orgId}:stop`, `${orgId}:stop`]);
      assert.isFalse(yield* stop.isPaused(orgId));
      assert.deepStrictEqual(
        yield* sql`SELECT body FROM kin_messages WHERE org_id = ${orgId} AND author_kind = 'system' ORDER BY seq`,
        [
          { body: KinStop.PAUSED_NOTICE },
          {
            body: [
              "Kin resumed. 11 queued events expired.",
              "Renewals (from Meera)",
              ...Array.from({ length: 9 }, () => "Chief of staff (from Kin)"),
              "and 1 more",
            ].join("\n"),
          },
        ],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT event_id FROM kin_events WHERE org_id = ${orgId} AND state = 'queued'
          AND tag != 'resume' ORDER BY event_id`,
        [{ event_id: "fresh" }, { event_id: "old-direct" }],
      );
      const resumes = yield* sql<{
        json: string;
        priority: string;
      }>`SELECT json, priority FROM kin_events WHERE org_id = ${orgId} AND tag = 'resume' ORDER BY event_id`;
      assert.lengthOf(resumes, 1);
      assert.strictEqual(resumes[0]!.priority, "P0");
      assert.match(JSON.parse(resumes[0]!.json).eventId, /^resume-[a-f0-9]{32}$/);
      assert.isTrue(paused.paused);
      assert.include(JSON.parse(resumes[0]!.json), {
        _tag: "resume",
        pausedAt: paused.pausedAt === null ? null : DateTime.formatIso(paused.pausedAt),
      });
      const expired = JSON.parse(resumes[0]!.json).expired;
      assert.strictEqual(expired.count, 11);
      assert.deepStrictEqual(expired.events[0], {
        eventId: "old-group",
        tag: "chat.message",
        receivedAt: createdAt,
      });
      assert.lengthOf(expired.events, 11);

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
            Effect.as({
              head: "abc",
              indexAsOf: DateTime.makeUnsafe("2026-11-08T00:00:00.000Z"),
              read: "/private/tmp",
            }),
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
      const failure = yield* Effect.flip(stop.pause(owner, { orgId }));
      assert.include(failure, { _tag: "KinChatError", reason: "unavailable" });
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
