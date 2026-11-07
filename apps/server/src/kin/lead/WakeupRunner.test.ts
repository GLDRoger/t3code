import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  KinWakeupId,
  ThreadId,
  RunId,
  RunAttemptId,
  ProviderTurnId,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as KinIdentity from "../chat/KinIdentity.ts";
import * as Memory from "../memory/Memory.ts";
import * as MemoryConfig from "../memory/MemoryConfig.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as KinLead from "./layer.ts";
import * as KinLeadRegistry from "./KinLeadRegistry.ts";
import * as KinEventQueue from "./KinEventQueue.ts";
import * as WakeupRunner from "./WakeupRunner.ts";
import { KinLeadPrompt } from "./LeadPrompt.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as EffectWorker from "../../orchestration-v2/EffectWorker.ts";
import { provideDeterministicTestRuntime } from "../../orchestration-v2/testkit/DeterministicRuntime.ts";
import { harness, seed, orgId, agentId, event } from "./WakeupRunner.testkit.ts";

const decodeUsage = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        inputTokens: Schema.Number,
        cachedInputTokens: Schema.Number,
        outputTokens: Schema.Number,
      }),
    ),
  ),
);
const resolveAgent = Effect.fn("test.resolveAgent")(function* (threadId: ThreadId) {
  const identity = yield* KinIdentity.KinIdentity;
  return yield* identity.resolveAgent({
    environmentId: EnvironmentId.make("test"),
    capabilities: new Set(),
    issuedAt: 0,
    requestNamespace: "test",
    client: undefined,
    thread: {
      threadId,
      providerSessionId: "test",
      providerInstanceId: ProviderInstanceId.make("codex"),
      subagent: false,
    },
  });
});
const run = Effect.fn("test.run")(function* () {
  const runner = yield* WakeupRunner.WakeupRunner;
  const fiber = yield* runner.runOnce(orgId, agentId).pipe(Effect.forkChild);
  yield* TestClock.adjust("20 seconds");
  return fiber;
});

describe("WakeupRunner", () => {
  it.effect(
    "runs two wake-ups on one T3 thread with distinct provider threads and captures only each run's usage",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const queue = yield* KinEventQueue.KinEventQueue;
        const sql = yield* SqlClient.SqlClient;
        const registry = yield* KinLeadRegistry.KinLeadRegistry;
        for (const id of ["first", "second"]) {
          yield* queue.enqueue(event(id));
          yield* Fiber.join(yield* run());
        }
        const rows = yield* sql<{
          thread_id: string;
          tokens_json: string;
          wakeup_id: string;
        }>`SELECT thread_id, tokens_json, wakeup_id FROM kin_wakeups ORDER BY started_at`;
        assert.strictEqual(rows.length, 2);
        assert.strictEqual(rows[0]?.thread_id, rows[1]?.thread_id);
        assert.match(rows[0]!.wakeup_id, /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
        const threads = yield* ThreadManagement.ThreadManagementService;
        const projection = yield* threads.getThreadProjection(ThreadId.make(rows[0]!.thread_id));
        assert.strictEqual(projection.runs.length, 2);
        assert.notEqual(projection.runs[0]?.providerThreadId, projection.runs[1]?.providerThreadId);
        assert.strictEqual(projection.providerThreads.length, 2);
        for (const row of rows) {
          const usage = yield* decodeUsage(row.tokens_json);
          assert.deepStrictEqual(usage, [
            { inputTokens: 20, cachedInputTokens: 5, outputTokens: 10 },
          ]);
        }
        assert.isFalse(registry.isLeadCaller(projection.thread.id));
        assert.include(yield* resolveAgent(projection.thread.id).pipe(Effect.flip), {
          reason: "not_allowed",
        });
        assert.isTrue((yield* KinIdentity.KinIdentity).isAgentThread(projection.thread.id));
        assert.deepStrictEqual(yield* sql`SELECT state FROM kin_events ORDER BY event_id`, [
          { state: "done" },
          { state: "done" },
        ]);
      }).pipe(Effect.provide(harness()), provideDeterministicTestRuntime),
  );
  it.effect("interrupts mid-wake-up without counting an attempt and admits the next claim", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        yield* seed;
        const queue = yield* KinEventQueue.KinEventQueue;
        const runner = yield* WakeupRunner.WakeupRunner;
        const sql = yield* SqlClient.SqlClient;
        yield* queue.enqueue(event("interrupt"));
        const fiber = yield* run();
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(fiber);
        assert.deepStrictEqual(yield* sql`SELECT status FROM kin_wakeups ORDER BY wakeup_id`, [
          { status: "interrupted" },
        ]);
        assert.deepStrictEqual(yield* sql`SELECT state, attempts FROM kin_events`, [
          { state: "queued", attempts: 0 },
        ]);
        yield* queue.enqueue(event("next"));
        yield* TestClock.adjust("20 seconds");
        const events = yield* Effect.scoped(
          queue.claim({ orgId, agentId, wakeupId: KinWakeupId.make("next"), model: "test" }),
        );
        assert.deepStrictEqual(
          events.map((item) => item.eventId),
          [event("interrupt").eventId, event("next").eventId],
        );
        yield* queue.finish({ orgId, wakeupId: KinWakeupId.make("next"), status: "completed" });
        assert.isDefined(runner);
      }).pipe(
        Effect.provide(
          harness({
            prepare: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
          }),
        ),
      );
    }).pipe(provideDeterministicTestRuntime),
  );

  it.effect("backs off a cross-process busy claim on TestClock instead of spinning", () =>
    Effect.gen(function* () {
      yield* seed;
      const queue = yield* KinEventQueue.KinEventQueue;
      const sql = yield* SqlClient.SqlClient;
      yield* queue.enqueue(event("blocker"));
      yield* TestClock.adjust("20 seconds");
      yield* Effect.scoped(
        queue.claim({ orgId, agentId, wakeupId: KinWakeupId.make("blocker"), model: "test" }),
      );
      yield* queue.enqueue(event("waiting"));
      const fiber = yield* run();
      yield* queue.finish({ orgId, wakeupId: KinWakeupId.make("blocker"), status: "completed" });
      yield* TestClock.adjust("4 seconds");
      assert.isUndefined(fiber.pollUnsafe());
      assert.strictEqual((yield* sql`SELECT * FROM kin_wakeups`).length, 1);
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(fiber);
      assert.deepStrictEqual(yield* sql`SELECT state FROM kin_events ORDER BY event_id`, [
        { state: "done" },
        { state: "done" },
      ]);
    }).pipe(Effect.provide(harness()), provideDeterministicTestRuntime),
  );

  it.effect(
    "times out and interrupts a held provider run without leaving the organization busy",
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const hold = yield* Deferred.make<void>();
        yield* Effect.gen(function* () {
          yield* seed;
          const queue = yield* KinEventQueue.KinEventQueue;
          const sql = yield* SqlClient.SqlClient;
          yield* queue.enqueue(event("timeout"));
          const fiber = yield* run();
          yield* Deferred.await(entered);
          const [lead] = yield* sql<{
            thread_id: string;
          }>`SELECT thread_id FROM kin_leads WHERE org_id = ${orgId} AND agent_id = ${agentId}`;
          const threadId = ThreadId.make(lead!.thread_id);
          assert.strictEqual((yield* resolveAgent(threadId)).agentId, agentId);
          yield* TestClock.adjust("15 minutes");
          yield* TestClock.adjust("30 seconds");
          yield* Fiber.join(fiber);
          assert.include(yield* resolveAgent(threadId).pipe(Effect.flip), {
            reason: "not_allowed",
          });
          assert.deepStrictEqual(yield* sql`SELECT status FROM kin_wakeups`, [
            { status: "timed_out" },
          ]);
          yield* Deferred.succeed(hold, undefined);
          yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
        }).pipe(Effect.provide(harness({ entered, hold })));
      }).pipe(provideDeterministicTestRuntime),
  );

  it.effect(
    "recovers abandoned and completed wake-ups once after restart without relaunching",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const queue = yield* KinEventQueue.KinEventQueue;
        const runner = yield* WakeupRunner.WakeupRunner;
        const sql = yield* SqlClient.SqlClient;
        yield* queue.enqueue(event("abandoned"));
        yield* TestClock.adjust("20 seconds");
        yield* Effect.scoped(
          queue.claim({ orgId, agentId, wakeupId: KinWakeupId.make("abandoned"), model: "test" }),
        );
        const missingThread = ThreadId.make("provisional-thread");
        yield* (yield* KinIdentity.KinIdentity).registerAgentThread({
          orgId,
          agentId,
          threadId: missingThread,
        });
        yield* sql`UPDATE kin_leads SET thread_id = ${missingThread} WHERE org_id = ${orgId} AND agent_id = ${agentId}`;
        yield* sql`UPDATE kin_wakeups SET thread_id = ${missingThread} WHERE org_id = ${orgId} AND wakeup_id = 'abandoned'`;
        yield* runner.recover;
        assert.deepStrictEqual(yield* sql`SELECT thread_id FROM kin_leads`, [{ thread_id: null }]);
        assert.deepStrictEqual(yield* sql`SELECT status FROM kin_wakeups`, [
          { status: "interrupted" },
        ]);
        yield* Fiber.join(yield* run());
        yield* sql`UPDATE kin_wakeups SET status = 'running', ended_at = NULL WHERE status = 'completed'`;
        yield* sql`UPDATE kin_events SET state = 'claimed' WHERE state = 'done'`;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const recoveredRunner = yield* WakeupRunner.WakeupRunner.pipe(
          Effect.provide(Layer.fresh(WakeupRunner.layer)),
          Effect.provideService(ThreadManagement.ThreadManagementService, {
            ...threads,
            getThreadProjection: (threadId) =>
              threads.getThreadProjection(threadId).pipe(
                Effect.map((projection) => {
                  const run = projection.runs[0];
                  const attempt = projection.attempts[0];
                  const turn = projection.providerTurns[0];
                  assert.isDefined(run);
                  assert.isDefined(attempt);
                  assert.isDefined(turn);
                  const continuedRunId = RunId.make("restart-continuation");
                  const continuedAttemptId = RunAttemptId.make("restart-attempt");
                  return {
                    ...projection,
                    runs: [
                      ...projection.runs,
                      {
                        ...run!,
                        id: continuedRunId,
                        ordinal: run!.ordinal + 1,
                        restartContinuationOfRunId: run!.id,
                      },
                    ],
                    attempts: [
                      ...projection.attempts,
                      { ...attempt!, id: continuedAttemptId, runId: continuedRunId },
                    ],
                    providerTurns: [
                      ...projection.providerTurns,
                      {
                        ...turn!,
                        id: ProviderTurnId.make("restart-turn"),
                        runAttemptId: continuedAttemptId,
                      },
                    ],
                  };
                }),
              ),
          }),
        );
        yield* recoveredRunner.recover;
        yield* recoveredRunner.recover;
        const [usageRow] = yield* sql<{
          tokens_json: string;
        }>`SELECT tokens_json FROM kin_wakeups WHERE status = 'completed'`;
        assert.strictEqual((yield* decodeUsage(usageRow!.tokens_json)).length, 2);
        assert.deepStrictEqual(yield* sql`SELECT status FROM kin_wakeups ORDER BY status`, [
          { status: "completed" },
          { status: "interrupted" },
        ]);
        const [row] = yield* sql<{ thread_id: string }>`SELECT thread_id FROM kin_leads`;
        const projection =
          yield* (yield* ThreadManagement.ThreadManagementService).getThreadProjection(
            ThreadId.make(row!.thread_id),
          );
        assert.strictEqual(projection.runs.length, 1);
        assert.deepStrictEqual(yield* sql`SELECT state, attempts FROM kin_events`, [
          { state: "done", attempts: 0 },
        ]);
      }).pipe(Effect.provide(harness()), provideDeterministicTestRuntime),
  );

  it.effect.each(["MemorySyncConflict", "MemoryCheckoutInvalid"] as const)(
    "fails and backs off %s without launching a provider",
    (tag) =>
      Effect.gen(function* () {
        const error =
          tag === "MemorySyncConflict"
            ? new Memory.MemorySyncConflict({ orgId, operation: "sync", reason: "fixture" })
            : new Memory.MemoryCheckoutInvalid({ orgId, operation: "checkout", reason: "fixture" });
        let notified = 0;
        yield* Effect.gen(function* () {
          yield* seed;
          const queue = yield* KinEventQueue.KinEventQueue;
          yield* queue.enqueue(event("memory-failure"));
          const result = yield* Fiber.await(yield* run());
          assert.strictEqual(result._tag, "Failure");
          const sql = yield* SqlClient.SqlClient;
          assert.deepStrictEqual(yield* sql`SELECT state, attempts FROM kin_events`, [
            { state: "queued", attempts: 1 },
          ]);
          assert.deepStrictEqual(yield* sql`SELECT status, thread_id FROM kin_wakeups`, [
            { status: "failed", thread_id: null },
          ]);
          assert.strictEqual(notified, tag === "MemoryCheckoutInvalid" ? 1 : 0);
        }).pipe(
          Effect.provide(
            harness({ prepare: () => Effect.fail(error) }).pipe(
              Layer.provide(
                Layer.succeed(WakeupRunner.KinWakeupHooks, {
                  memoryCheckoutInvalid: () =>
                    Effect.sync(() => {
                      notified++;
                    }),
                }),
              ),
            ),
          ),
        );
      }).pipe(provideDeterministicTestRuntime),
  );

  it.effect("expires retired leads' queued events and ends their durable thread registration", () =>
    Effect.gen(function* () {
      yield* seed;
      const queue = yield* KinEventQueue.KinEventQueue;
      const runner = yield* WakeupRunner.WakeupRunner;
      const sql = yield* SqlClient.SqlClient;
      yield* queue.enqueue(event("first"));
      yield* Fiber.join(yield* run());
      yield* queue.enqueue(event("retired"));
      yield* sql`UPDATE kin_agents SET retired_at = '2026-11-08T00:00:00.000Z' WHERE org_id = ${orgId} AND agent_id = ${agentId}`;
      yield* runner.runOnce(orgId, agentId);
      assert.deepStrictEqual(yield* sql`SELECT state FROM kin_events WHERE event_id = 'retired'`, [
        { state: "expired" },
      ]);
      assert.strictEqual(
        (yield* sql`SELECT 1 FROM kin_agent_threads WHERE ended_at IS NULL AND org_id = ${orgId}`)
          .length,
        0,
      );
      assert.strictEqual((yield* sql`SELECT 1 FROM kin_wakeups`).length, 1);
    }).pipe(Effect.provide(harness()), provideDeterministicTestRuntime),
  );

  it.effect(
    "recovers other organizations while keeping a recovered active run claimed until completion",
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const hold = yield* Deferred.make<void>();
        yield* Effect.gen(function* () {
          yield* seed;
          const queue = yield* KinEventQueue.KinEventQueue;
          const sql = yield* SqlClient.SqlClient;
          const wakeupId = KinWakeupId.make("recovery-active");
          yield* queue.enqueue(event("active"));
          yield* TestClock.adjust("20 seconds");
          yield* Effect.scoped(queue.claim({ orgId, agentId, wakeupId, model: "test" }));
          const launch = yield* ThreadLaunch.ThreadLaunchService;
          const sent = yield* launch.launch({
            commandId: CommandId.make(`kin-wakeup:${wakeupId}`),
            projectId: ProjectId.make("kin:org"),
            title: "Lead",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5.1-codex",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            workspaceStrategy: { type: "root" },
            initialMessage: {
              messageId: MessageId.make(`kin-wakeup-msg:${wakeupId}`),
              text: "Wake up",
              attachments: [],
            },
            createdBy: "system",
            creationSource: "server",
          });
          yield* sql`UPDATE kin_leads SET thread_id = ${sent.threadId} WHERE org_id = ${orgId} AND agent_id = ${agentId}`;
          yield* sql`UPDATE kin_wakeups SET thread_id = ${sent.threadId} WHERE org_id = ${orgId} AND wakeup_id = ${wakeupId}`;
          yield* Deferred.await(entered);
          yield* sql`INSERT INTO kin_orgs VALUES ('other-org', 'Other', '2026-11-08T00:00:00.000Z')`;
          yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
            VALUES ('other-owner', 'other-org', 'owner', 'Owner', '2026-11-08T00:00:00.000Z')`;
          yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
            VALUES ('other-lead', 'other-org', 'Lead', 'lead', 'other-owner', '2026-11-08T00:00:00.000Z')`;
          yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at)
            VALUES ('other-chat', 'other-org', 'team_group', 0, '2026-11-08T00:00:00.000Z')`;
          yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id)
            SELECT 'other-lead', 'other-org', 'Lead', 0, models_json, '[]', 'other-chat' FROM kin_leads WHERE agent_id = ${agentId}`;
          yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, model, started_at, status, event_ids)
            VALUES ('other-abandoned', 'other-org', 'other-lead', 'test', 0, 'running', '[]')`;
          const reconciled = yield* Deferred.make<void>();
          const runner = yield* WakeupRunner.WakeupRunner.pipe(
            Effect.provide(Layer.fresh(WakeupRunner.layer)),
            Effect.provideService(KinEventQueue.KinEventQueue, {
              ...queue,
              requeueUnfinished: Effect.fn("test.requeueUnfinished")(function* (org, wakeup) {
                const count = yield* queue.requeueUnfinished(org, wakeup);
                yield* Deferred.succeed(reconciled, undefined);
                return count;
              }),
            }),
          );
          const recovered = yield* runner.recover.pipe(Effect.forkChild);
          yield* Deferred.await(reconciled);
          assert.deepStrictEqual(
            yield* sql`SELECT status FROM kin_wakeups WHERE wakeup_id = 'other-abandoned'`,
            [{ status: "interrupted" }],
          );
          yield* sql`DELETE FROM kin_wakeups WHERE wakeup_id = 'other-abandoned'`;
          assert.deepStrictEqual(yield* sql`SELECT state FROM kin_events`, [{ state: "claimed" }]);
          assert.isUndefined(recovered.pollUnsafe());
          yield* Deferred.succeed(hold, undefined);
          yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
          yield* Fiber.join(recovered);
          assert.deepStrictEqual(yield* sql`SELECT status FROM kin_wakeups`, [
            { status: "completed" },
          ]);
          yield* runner.recover;
          assert.deepStrictEqual(yield* sql`SELECT state FROM kin_events`, [{ state: "done" }]);
        }).pipe(Effect.provide(harness({ entered, hold })));
      }).pipe(provideDeterministicTestRuntime),
  );

  it.effect(
    "releases an organization paused during the quiet window without consuming an attempt",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const queue = yield* KinEventQueue.KinEventQueue;
        const runner = yield* WakeupRunner.WakeupRunner;
        const sql = yield* SqlClient.SqlClient;
        yield* queue.enqueue(event("paused"));
        const fiber = yield* runner.runOnce(orgId, agentId).pipe(Effect.forkChild);
        yield* TestClock.adjust("1 second");
        yield* sql`INSERT INTO kin_org_state (org_id, paused, paused_at, paused_by) VALUES (${orgId}, 1, 1000, 'owner')`;
        yield* TestClock.adjust("19 seconds");
        yield* Fiber.join(fiber);
        assert.deepStrictEqual(yield* sql`SELECT state, attempts FROM kin_events`, [
          { state: "queued", attempts: 0 },
        ]);
        assert.deepStrictEqual(yield* sql`SELECT status, thread_id FROM kin_wakeups`, [
          { status: "released", thread_id: null },
        ]);
        yield* sql`UPDATE kin_org_state SET paused = 0, paused_at = NULL, paused_by = NULL WHERE org_id = ${orgId}`;
        yield* Fiber.join(yield* run());
        assert.deepStrictEqual(yield* sql`SELECT state FROM kin_events`, [{ state: "done" }]);
      }).pipe(Effect.provide(harness()), provideDeterministicTestRuntime),
  );

  it.effect("keeps an org loop alive after a one-shot defect", () =>
    Effect.gen(function* () {
      const failed = yield* Deferred.make<void>();
      const continued = yield* Deferred.make<void>();
      let calls = 0;
      yield* Effect.gen(function* () {
        yield* seed;
        const queue = yield* KinEventQueue.KinEventQueue;
        const runner = yield* WakeupRunner.WakeupRunner;
        yield* runner.start;
        yield* queue.enqueue(event("defect"));
        yield* TestClock.adjust("20 seconds");
        yield* Deferred.await(failed);
        yield* queue.enqueue(event("after-defect"));
        yield* TestClock.adjust("21 seconds");
        yield* Deferred.await(continued);
        assert.strictEqual(calls, 2);
      }).pipe(
        Effect.provide(
          harness({
            prepare: () =>
              Effect.gen(function* () {
                if (++calls === 1) {
                  yield* Deferred.succeed(failed, undefined);
                  return yield* Effect.die("one-shot defect");
                }
                yield* Deferred.succeed(continued, undefined);
                return yield* Effect.never;
              }),
          }),
        ),
      );
    }).pipe(provideDeterministicTestRuntime),
  );

  it.effect("contains Kin startup failures while building the non-Kin server runtime", () => {
    class Core extends Context.Service<Core, { readonly ready: boolean }>()(
      "t3/kin/lead/WakeupRunner.test/Core",
    ) {}
    return Effect.gen(function* () {
      yield* seed;
      const failing = KinLead.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
            Layer.mock(ThreadManagement.ThreadManagementService)({}),
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.succeed(KinLeadPrompt, { build: () => Effect.succeed("unused") }),
            Layer.succeed(MemoryConfig.MemoryConfig, {
              baseDirectory: "/private/tmp",
              repositories: [],
            }),
            Layer.mock(VcsProcess.VcsProcess)({}),
            NodeServices.layer,
          ),
        ),
      );
      assert.strictEqual((yield* Layer.build(failing).pipe(Effect.exit))._tag, "Failure");
      const runtime = Layer.mergeAll(
        Layer.succeed(Core, { ready: true }),
        KinLead.containStartup(failing),
      );
      const context = yield* Layer.build(runtime);
      assert.isTrue(Context.get(context, Core).ready);
      const defect = Layer.mergeAll(
        Layer.succeed(Core, { ready: true }),
        KinLead.containStartup(Layer.effectDiscard(Effect.die("Kin layer defect"))),
      );
      assert.isTrue(Context.get(yield* Layer.build(defect), Core).ready);
    }).pipe(Effect.provide(KinPersistence.layer.pipe(Layer.provideMerge(Sqlite.layerMemory))));
  });
});
