import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ProviderSessionManager from "../../orchestration-v2/ProviderSessionManager.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as McpSessionRegistryTestkit from "../../mcp/McpSessionRegistry.testkit.ts";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  EnvironmentId,
  MessageId,
  KinWakeupId,
  KinEvent,
  KinAgentId,
  KinPersonId,
  ThreadId,
  RunId,
  RunAttemptId,
  ProviderTurnId,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as OwnerCheck from "../triggers/ownerCheck.ts";
import * as ChatService from "../chat/KinChatService.ts";
import * as ChatHub from "../chat/KinChatHub.ts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Budget from "./KinBudget.ts";
import * as KinIdentity from "../chat/KinIdentity.ts";
import * as Writer from "../memory/MemoryWriter.ts";
import * as Memory from "../memory/Memory.ts";
import * as MemoryConfig from "../memory/MemoryConfig.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as KinIssuedTokens from "../mcp/KinIssuedTokens.ts";
import * as KinLead from "./layer.ts";
import * as KinEventQueue from "./KinEventQueue.ts";
import * as WakeupRunner from "./WakeupRunner.ts";
import { KinLeadPrompt } from "./LeadPrompt.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as DateTime from "effect/DateTime";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as EffectWorker from "../../orchestration-v2/EffectWorker.ts";
import { provideDeterministicTestRuntime } from "../../orchestration-v2/testkit/DeterministicRuntime.ts";
import { harness, seed, orgId, agentId, event } from "./WakeupRunner.testkit.ts";

const decodeEvent = Schema.decodeSync(KinEvent);
const decodeUsage = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        turnTokenUsage: Schema.Struct({
          inputTokens: Schema.Number,
          cachedInputTokens: Schema.Number,
          outputTokens: Schema.Number,
        }),
      }),
    ),
  ),
);
const resolveAgent = Effect.fn("test.resolveAgent")(function* (threadId: ThreadId) {
  const identity = yield* KinIdentity.KinIdentity;
  const sessions = yield* McpSessionRegistry.McpSessionRegistry;
  const issued = yield* sessions.issue({
    threadId,
    providerInstanceId: ProviderInstanceId.make("codex"),
  });
  const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
  const scope = yield* sessions.resolve(token);
  assert.isDefined(scope);
  return yield* identity.resolveAgent(scope!);
});
const run = Effect.fn("test.run")(function* () {
  const runner = yield* WakeupRunner.WakeupRunner;
  const fiber = yield* runner.runOnce(orgId, agentId).pipe(Effect.forkChild);
  yield* TestClock.adjust("20 seconds");
  return fiber;
});

describe("WakeupRunner", () => {
  it.effect("handles the owner check in code without starting a provider turn", () =>
    Effect.gen(function* () {
      yield* seed;
      const queue = yield* KinEventQueue.KinEventQueue;
      const sql = yield* SqlClient.SqlClient;
      yield* queue.enqueue(event("owner-check"));
      yield* Fiber.join(yield* run());
      assert.deepEqual(
        yield* sql`SELECT state FROM kin_events WHERE org_id = ${orgId} ORDER BY event_id`,
        [{ state: "done" }],
      );
      assert.deepEqual(
        yield* sql`SELECT thread_id, status FROM kin_wakeups WHERE org_id = ${orgId} ORDER BY wakeup_id`,
        [{ thread_id: null, status: "completed" }],
      );
      assert.lengthOf(
        yield* sql`SELECT thread_id FROM kin_agent_threads WHERE org_id = ${orgId} ORDER BY thread_id`,
        0,
      );
    }).pipe(
      Effect.provide(
        harness().pipe(
          Layer.provide(Layer.mock(OwnerCheck.OwnerCheck)({ post: () => Effect.succeed([]) })),
        ),
      ),
      provideDeterministicTestRuntime,
    ),
  );
  it.effect("discards a failed commit session so the next wake-up can stage", () =>
    Effect.gen(function* () {
      let owner: string | undefined;
      let commits = 0;
      const writer = Layer.succeed(
        Writer.MemoryWriter,
        Writer.MemoryWriter.of({
          dreamBase: () => Effect.die("unused"),
          commitDream: () => Effect.die("unused"),
          deleteDreamBranch: () => Effect.die("unused"),
          stage: (_org, wakeup) =>
            Effect.sync(() => {
              assert.isTrue(owner === undefined || owner === wakeup);
              owner = wakeup;
            }),
          appendJournal: (_org, wakeup) =>
            Effect.sync(() => {
              assert.isTrue(owner === undefined || owner === wakeup);
              owner = wakeup;
            }),
          discard: (_org, wakeup) =>
            Effect.sync(() => {
              if (owner === wakeup) owner = undefined;
            }),
          commitWakeup: () =>
            Effect.suspend(() =>
              ++commits === 1
                ? Effect.fail(
                    new Writer.MemoryWriteRejected({ reason: "fixture validation failure" }),
                  )
                : Effect.succeed({ commit: "fixture" }),
            ),
        }),
      );
      yield* Effect.gen(function* () {
        yield* seed;
        const queue = yield* KinEventQueue.KinEventQueue;
        yield* queue.enqueue(event("first"));
        const first = yield* run();
        assert.strictEqual((yield* Fiber.await(first))._tag, "Failure");
        assert.isUndefined(owner);
        yield* Context.get(yield* Layer.build(writer), Writer.MemoryWriter).stage(
          orgId,
          "next-wakeup",
          {
            path: "claims/test.md",
            content: "fixture",
          },
        );
        yield* Context.get(yield* Layer.build(writer), Writer.MemoryWriter).discard(
          orgId,
          "next-wakeup",
        );
        yield* queue.enqueue(event("second"));
        yield* Fiber.join(yield* run());
        assert.strictEqual(commits, 2);
      }).pipe(Effect.provide(harness({ writer })));
    }).pipe(provideDeterministicTestRuntime),
  );
  it.effect("uses the cheap model for exhausted P0 even when a routine is in the batch", () =>
    Effect.gen(function* () {
      yield* seed;
      const budget = yield* Budget.KinBudget;
      const queue = yield* KinEventQueue.KinEventQueue;
      const sql = yield* SqlClient.SqlClient;
      yield* budget.set([{ _tag: "person", orgId, personId: KinPersonId.make("owner") }], {
        orgId,
        limits: { leadUnits: 0, workerUnits: 0 },
      });
      yield* queue.enqueue({
        ...event("urgent"),
        _tag: "resume",
        pausedAt: DateTime.makeUnsafe(0),
      });
      yield* queue.enqueue(event("routine"));
      yield* Fiber.join(yield* run());
      assert.deepStrictEqual(
        yield* sql`SELECT model, status FROM kin_wakeups WHERE org_id = ${orgId} ORDER BY wakeup_id`,
        [{ model: "gpt-5.1-codex-mini", status: "completed" }],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT event_id, state, attempts FROM kin_events WHERE org_id = ${orgId} ORDER BY event_id`,
        [
          { event_id: "routine", state: "queued", attempts: 0 },
          { event_id: "urgent", state: "done", attempts: 0 },
        ],
      );
    }).pipe(
      Effect.provide(
        harness({
          writer: Layer.effect(
            Writer.MemoryWriter,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              return Writer.MemoryWriter.of({
                stage: () => Effect.die("unused"),
                dreamBase: () => Effect.die("unused"),
                commitDream: () => Effect.die("unused"),
                deleteDreamBranch: () => Effect.die("unused"),
                discard: () => Effect.void,
                appendJournal: (_org, _wakeup, lines) =>
                  Effect.sync(() =>
                    assert.deepStrictEqual(lines, ["Lead ended without calling kin_end."]),
                  ),
                commitWakeup: Effect.fn("test.commitWakeup")(function* (org, wakeupId, outcome) {
                  assert.strictEqual(org, orgId);
                  assert.strictEqual(outcome, "completed");
                  const [row] = yield* sql<{
                    status: string;
                    runStatus: string;
                  }>`SELECT w.status, r.status AS "runStatus" FROM kin_wakeups w JOIN orchestration_v2_projection_runs r ON r.run_id = w.run_id WHERE w.wakeup_id = ${wakeupId}`.pipe(
                    Effect.orDie,
                  );
                  assert.deepStrictEqual(row, { status: "running", runStatus: "completed" });
                  return { commit: "fixture-commit" };
                }),
              });
            }),
          ),
        }),
      ),
      provideDeterministicTestRuntime,
    ),
  );
  it.effect(
    "defers P3 until the owner-local reset without attempts and re-admits it after limits rise",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const queue = yield* KinEventQueue.KinEventQueue;
        const budget = yield* Budget.KinBudget;
        const sql = yield* SqlClient.SqlClient;
        const people = [{ _tag: "person" as const, orgId, personId: KinPersonId.make("owner") }];
        yield* sql`INSERT INTO kin_trigger_settings VALUES (${orgId}, 'America/New_York', '09:00', '18:00', '02:00', 0, 1, '10:00', '{}')`;
        yield* budget.set(people, { orgId, limits: { leadUnits: 100, workerUnits: 100 } });
        yield* sql`UPDATE kin_budget SET lead_units = 85 WHERE org_id = ${orgId}`;
        const pending = decodeEvent({
          ...event("deferred"),
          receivedAt: "1970-01-01T00:00:00.000Z",
          _tag: "watchdog",
          finding: "Check",
          itemIds: [],
        });
        yield* queue.enqueue(pending);
        yield* queue.enqueue(
          decodeEvent({
            ...event("urgent"),
            receivedAt: "1970-01-01T00:00:00.000Z",
            _tag: "resume",
            pausedAt: "1970-01-01T00:00:00.000Z",
          }),
        );
        yield* Fiber.join(yield* run());
        assert.deepStrictEqual(
          yield* sql`SELECT state, not_before, attempts FROM kin_events WHERE org_id = ${orgId} AND event_id = 'deferred' ORDER BY event_id`,
          [{ state: "queued", not_before: 18_000_000, attempts: 0 }],
        );
        yield* budget.set(people, { orgId, limits: { leadUnits: 1000, workerUnits: 100 } });
        yield* Fiber.join(yield* run());
        assert.deepStrictEqual(
          yield* sql`SELECT state, attempts FROM kin_events WHERE org_id = ${orgId} ORDER BY event_id`,
          [
            { state: "done", attempts: 0 },
            { state: "done", attempts: 0 },
          ],
        );
      }).pipe(Effect.provide(harness()), provideDeterministicTestRuntime),
  );
  it.effect("completes Pi wake-ups with disjoint snapshot counters and no turn ledger", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* (yield* KinEventQueue.KinEventQueue).enqueue(event("pi"));
      yield* Fiber.join(yield* run());
      const rows = yield* sql<{
        status: string;
        tokens_json: string;
      }>`SELECT status, tokens_json FROM kin_wakeups WHERE org_id = ${orgId}`;
      assert.strictEqual(rows[0]!.status, "completed");
      assert.include(JSON.parse(rows[0]!.tokens_json)[0].tokenUsage, {
        inputTokens: 2,
        cachedInputTokens: 100,
      });
      assert.strictEqual((yield* (yield* Budget.KinBudget).get(orgId)).leadUnits, 30);
      assert.deepStrictEqual(
        yield* sql`SELECT state, attempts FROM kin_events WHERE org_id = ${orgId}`,
        [{ state: "done", attempts: 0 }],
      );
    }).pipe(Effect.provide(harness({ piUsage: true })), provideDeterministicTestRuntime),
  );
  it.effect(
    "charges failed provider turns from the exact usage recorded on the failed wake-up",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        yield* (yield* KinEventQueue.KinEventQueue).enqueue(event("failed-provider"));
        yield* sql`UPDATE kin_events SET budget_deferred = 1, not_before = 0 WHERE org_id = ${orgId}`;
        yield* Fiber.join(yield* run());
        const [row] = yield* sql<{
          status: string;
          tokens_json: string;
        }>`SELECT status, tokens_json FROM kin_wakeups WHERE org_id = ${orgId} ORDER BY wakeup_id`;
        assert.strictEqual(row!.status, "failed");
        assert.deepStrictEqual(
          yield* sql`SELECT budget_deferred, attempts FROM kin_events WHERE org_id = ${orgId} ORDER BY event_id`,
          [{ budget_deferred: 0, attempts: 1 }],
        );
        assert.strictEqual((yield* decodeUsage(row!.tokens_json)).length, 1);
        assert.deepStrictEqual(
          yield* sql`SELECT units, tokens_json FROM kin_budget_charges WHERE org_id = ${orgId} ORDER BY wakeup_id`,
          [{ units: 55.5, tokens_json: row!.tokens_json }],
        );
        assert.strictEqual((yield* (yield* Budget.KinBudget).get(orgId)).leadUnits, 55.5);
      }).pipe(Effect.provide(harness({ failed: true })), provideDeterministicTestRuntime),
  );
  it.effect(
    "runs two wake-ups on one T3 thread with distinct provider threads and captures only each run's usage",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const queue = yield* KinEventQueue.KinEventQueue;
        const sql = yield* SqlClient.SqlClient;
        for (const id of ["first", "second"]) {
          yield* queue.enqueue(event(id));
          yield* Fiber.join(yield* run());
        }
        const rows = yield* sql<{
          thread_id: string;
          tokens_json: string;
          wakeup_id: string;
          model: string;
        }>`SELECT thread_id, tokens_json, wakeup_id, model FROM kin_wakeups ORDER BY started_at`;
        assert.strictEqual(rows.length, 2);
        assert.isTrue(rows.every((row) => row.model === "gpt-5.1-codex"));
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
            { turnTokenUsage: { inputTokens: 20, cachedInputTokens: 5, outputTokens: 10 } },
          ]);
        }
        const charged = yield* sql<{
          units: number;
          tokens_json: string;
        }>`SELECT units, tokens_json FROM kin_budget_charges WHERE org_id = ${orgId} ORDER BY wakeup_id`;
        assert.strictEqual(charged.length, 2);
        assert.isTrue(charged.every((charge) => charge.units === 55.5));
        assert.deepStrictEqual(
          charged.map((charge) => charge.tokens_json).toSorted(),
          rows.map((row) => row.tokens_json).toSorted(),
        );
        assert.strictEqual((yield* (yield* Budget.KinBudget).get(orgId)).leadUnits, 111);
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
          const sessions = yield* McpSessionRegistry.__testing.make().pipe(
            Effect.provide(
              Layer.mergeAll(
                NodeServices.layer,
                NodeCrypto.layer,
                Layer.mock(HttpServer.HttpServer)({
                  address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
                }),
                Layer.mock(ServerEnvironment.ServerEnvironment)({
                  getEnvironmentId: Effect.succeed(EnvironmentId.make("test")),
                }),
              ),
            ),
          );
          const launch = yield* ThreadLaunch.ThreadLaunchService;
          const runner = yield* WakeupRunner.WakeupRunner.pipe(
            Effect.provide(Layer.fresh(WakeupRunner.layer)),
            Effect.provideService(ThreadLaunch.ThreadLaunchService, {
              ...launch,
              launch: (input) =>
                launch.launch(input).pipe(
                  Effect.tap((result) =>
                    Effect.gen(function* () {
                      assert.strictEqual(
                        (yield* resolveAgent(result.projection.thread.id)).agentId,
                        agentId,
                      );
                    }),
                  ),
                ),
            }),
          );
          yield* queue.enqueue(event("timeout"));
          const fiber = yield* runner.runOnce(orgId, agentId).pipe(Effect.forkChild);
          yield* TestClock.adjust("20 seconds");
          yield* Deferred.await(entered);
          const [lead] = yield* sql<{
            thread_id: string;
          }>`SELECT thread_id FROM kin_leads WHERE org_id = ${orgId} AND agent_id = ${agentId}`;
          const threadId = ThreadId.make(lead!.thread_id);
          const issued = yield* sessions.issue({
            threadId,
            providerInstanceId: ProviderInstanceId.make("codex"),
          });
          const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
          assert.isDefined(yield* sessions.resolve(token));
          assert.strictEqual(
            (yield* (yield* KinIdentity.KinIdentity).resolveAgent(
              (yield* sessions.resolve(token))!,
            )).agentId,
            agentId,
          );
          yield* TestClock.adjust("15 minutes");
          yield* TestClock.adjust("30 seconds");
          yield* Fiber.join(fiber);
          assert.isDefined(yield* sessions.resolve(token));
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
        yield* sql`INSERT INTO kin_lead_tool_calls (org_id, wakeup_id, call_key, request_hash) VALUES (${orgId}, 'abandoned', 'item:test', 'hash')`;
        const recoveryWriter = Layer.mock(Writer.MemoryWriter)({
          commitWakeup: () =>
            Effect.fail(new Writer.MemoryWriteRejected({ reason: "fixture commit failure" })),
          discard: () => Effect.void,
        });
        yield* WakeupRunner.WakeupRunner.pipe(
          Effect.flatMap((recovery) => recovery.recover),
          Effect.provide(Layer.fresh(WakeupRunner.layer).pipe(Layer.provide(recoveryWriter))),
        );
        assert.deepStrictEqual(yield* sql`SELECT attempts, not_before FROM kin_events`, [
          { attempts: 0, not_before: null },
        ]);
        assert.deepStrictEqual(yield* sql`SELECT thread_id FROM kin_leads`, [{ thread_id: null }]);
        assert.deepStrictEqual(yield* sql`SELECT status FROM kin_wakeups`, [
          { status: "interrupted" },
        ]);
        yield* Fiber.join(yield* run());
        // Reconstruct a crash before the atomic usage capture and charge committed.
        yield* sql`DELETE FROM kin_budget_charges WHERE org_id = ${orgId}`;
        yield* sql`UPDATE kin_budget SET lead_units = 0 WHERE org_id = ${orgId}`;
        yield* sql`UPDATE kin_wakeups SET status = 'running', ended_at = NULL, tokens_json = NULL WHERE status = 'completed'`;
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
        assert.strictEqual((yield* (yield* Budget.KinBudget).get(orgId)).leadUnits, 111);
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

  it.effect.each(["projection", "decode"] as const)(
    "finalizes recovery after a %s failure instead of retrying forever",
    (failure) =>
      Effect.gen(function* () {
        yield* seed;
        const queue = yield* KinEventQueue.KinEventQueue;
        const sql = yield* SqlClient.SqlClient;
        yield* queue.enqueue(event("recovery-failure"));
        yield* Fiber.join(yield* run());
        yield* sql`UPDATE kin_wakeups SET status = 'running', ended_at = NULL`;
        yield* sql`UPDATE kin_events SET state = 'claimed'`;
        if (failure === "decode") yield* sql`UPDATE kin_wakeups SET run_id = ''`;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const runner = yield* WakeupRunner.WakeupRunner.pipe(
          Effect.provide(Layer.fresh(WakeupRunner.layer)),
          Effect.provideService(ThreadManagement.ThreadManagementService, {
            ...threads,
            getThreadProjection: () => Effect.die("projection unavailable"),
          }),
        );
        yield* runner.recover;
        yield* runner.recover;
        assert.deepStrictEqual(yield* sql`SELECT status FROM kin_wakeups`, [{ status: "failed" }]);
        assert.deepStrictEqual(yield* sql`SELECT state, attempts FROM kin_events`, [
          { state: "queued", attempts: 1 },
        ]);
      }).pipe(Effect.provide(harness()), provideDeterministicTestRuntime),
  );

  it.effect("wakes another lead while the first has a held queued run", () =>
    Effect.gen(function* () {
      yield* seed;
      const queue = yield* KinEventQueue.KinEventQueue;
      const sql = yield* SqlClient.SqlClient;
      yield* queue.enqueue(event("first"));
      yield* Fiber.join(yield* run());
      const [lead] = yield* sql<{ thread_id: string }>`SELECT thread_id FROM kin_leads`;
      const threadId = ThreadId.make(lead!.thread_id);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("hold"),
        threadId,
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("held-message"),
        threadId,
        messageId: MessageId.make("held-message"),
        text: "Held",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("held-second"),
        threadId,
        messageId: MessageId.make("held-second"),
        text: "Held",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("hold-queue"),
        threadId,
      });
      assert.strictEqual(
        (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!.status,
        "queued",
      );
      yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
        SELECT 'lead-z', org_id, display_name, role, owner_person_id, created_at FROM kin_agents WHERE agent_id = 'lead'`;
      yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id)
        SELECT 'lead-z', org_id, name, level_since, models_json, worker_projects_json, owner_chat_id FROM kin_leads WHERE agent_id = 'lead'`;
      yield* queue.enqueue(event("busy"));
      yield* queue.enqueue({ ...event("other"), agentId: KinAgentId.make("lead-z") });
      yield* TestClock.adjust("20 seconds");
      const next = yield* queue.nextReady(orgId);
      assert.strictEqual(next?.agentId, "lead-z");
      yield* Fiber.join(
        yield* (yield* WakeupRunner.WakeupRunner)
          .runOnce(orgId, next!.agentId)
          .pipe(Effect.forkChild),
      );
      assert.deepStrictEqual(yield* sql`SELECT state FROM kin_events WHERE event_id = 'other'`, [
        { state: "done" },
      ]);
      assert.deepStrictEqual(yield* sql`SELECT state FROM kin_events WHERE event_id = 'busy'`, [
        { state: "queued" },
      ]);
    }).pipe(Effect.provide(harness()), provideDeterministicTestRuntime),
  );

  it.effect("defers claims while an interrupted run's provider turn is unfinished", () =>
    Effect.gen(function* () {
      yield* seed;
      const queue = yield* KinEventQueue.KinEventQueue;
      const runner = yield* WakeupRunner.WakeupRunner;
      const sql = yield* SqlClient.SqlClient;
      yield* queue.enqueue(event("first"));
      yield* Fiber.join(yield* run());
      const threads = yield* ThreadManagement.ThreadManagementService;
      const [lead] = yield* sql<{ thread_id: string }>`SELECT thread_id FROM kin_leads`;
      const projection = yield* threads.getThreadProjection(ThreadId.make(lead!.thread_id));
      const sink = yield* EventSink.EventSinkV2;
      const turn = projection.providerTurns[0]!;
      const occurredAt = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            id: EventId.make("unfinished-run"),
            type: "run.updated",
            threadId: projection.thread.id,
            occurredAt,
            payload: { ...projection.runs[0]!, status: "interrupted" },
          },
          {
            id: EventId.make("unfinished-turn"),
            type: "provider-turn.updated",
            threadId: projection.thread.id,
            occurredAt,
            payload: { ...turn, status: "running", completedAt: null },
          },
        ],
      });
      yield* queue.enqueue(event("next"));
      const deferred = yield* runner.runOnce(orgId, agentId).pipe(Effect.forkChild);
      yield* TestClock.adjust("60 seconds");
      yield* Fiber.join(deferred);
      assert.deepStrictEqual(yield* sql`SELECT status FROM kin_wakeups`, [{ status: "completed" }]);
      assert.deepStrictEqual(
        yield* sql`SELECT state, attempts FROM kin_events WHERE event_id = 'next'`,
        [{ state: "queued", attempts: 0 }],
      );
      yield* sink.write({
        events: [
          {
            id: EventId.make("finished-turn"),
            type: "provider-turn.updated",
            threadId: projection.thread.id,
            occurredAt: yield* DateTime.now,
            payload: turn,
          },
        ],
      });
      yield* Fiber.join(yield* run());
      assert.lengthOf(yield* sql`SELECT 1 FROM kin_wakeups`, 2);
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

  it.effect.each(["released", "shared", "releasing"] as const)(
    "expires retired leads' queued events and ends their durable thread registration (%s)",
    (outcome) =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const hold = yield* Deferred.make<void>();
        const releaseEntered = yield* Deferred.make<void>();
        const releaseHold = yield* Deferred.make<void>();
        const releaseDone = yield* Deferred.make<void>();
        yield* Effect.gen(function* () {
          yield* seed;
          const queue = yield* KinEventQueue.KinEventQueue;
          const sql = yield* SqlClient.SqlClient;
          yield* queue.enqueue(event("first"));
          const active = yield* run();
          yield* Deferred.await(entered);
          yield* queue.enqueue(event("retired"));
          const identity = yield* KinIdentity.KinIdentity;
          const threads = yield* ThreadManagement.ThreadManagementService;
          const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
          const [lead] = yield* sql<{ thread_id: string }>`SELECT thread_id FROM kin_leads`;
          const threadId = ThreadId.make(lead!.thread_id);
          const projection = yield* threads.getThreadProjection(threadId);
          const credentials = yield* McpSessionRegistry.McpSessionRegistry;
          const issued = yield* credentials.issue({
            threadId,
            providerInstanceId: ProviderInstanceId.make("codex"),
          });
          const token = issued.config.authorizationHeader.slice(7);
          const caller = yield* credentials.resolve(token);
          assert.isDefined(caller);
          yield* identity.resolveAgent(caller!);
          yield* sql`UPDATE kin_agents SET retired_at = '2026-11-08T00:00:00.000Z' WHERE org_id = ${orgId} AND agent_id = ${agentId}`;
          let stops = 0;
          const retiringRunner = yield* WakeupRunner.WakeupRunner.pipe(
            Effect.provide(Layer.fresh(WakeupRunner.layer)),
            Effect.provideService(ThreadManagement.ThreadManagementService, {
              ...threads,
              forceStopThread: Effect.fn("test.forceStopThread")(function* (input) {
                stops++;
                const result = yield* threads.forceStopThread(input);
                assert.strictEqual(result.outcome, stops === 1 ? outcome : "released");
                return result;
              }),
            }),
            Effect.provideService(KinIdentity.KinIdentity, {
              ...identity,
              endAgentThread: Effect.fn("test.endAgentThread")(function* (
                input: Parameters<typeof identity.endAgentThread>[0],
              ) {
                const projection = yield* threads
                  .getThreadProjection(input.threadId)
                  .pipe(Effect.orDie);
                assert.isTrue(identity.isAgentThread(input.threadId));
                for (const providerThread of projection.providerThreads)
                  if (providerThread.providerSessionId !== null)
                    assert.strictEqual(
                      yield* sessions.isLive(providerThread.providerSessionId),
                      outcome === "shared",
                    );
                return yield* identity.endAgentThread(input);
              }),
            }),
          );
          const firstPass = yield* retiringRunner.runOnce(orgId, agentId).pipe(Effect.forkChild);
          if (outcome === "releasing") {
            yield* Deferred.await(releaseEntered);
            yield* TestClock.adjust("10 seconds");
          }
          yield* Fiber.join(firstPass);
          assert.strictEqual(identity.isAgentThread(threadId), outcome === "releasing");
          if (outcome === "releasing") {
            assert.isTrue(identity.isAgentThread(threadId));
            assert.lengthOf(yield* sql`SELECT 1 FROM kin_agent_threads WHERE ended_at IS NULL`, 1);
            yield* Deferred.succeed(releaseHold, undefined);
            yield* Deferred.await(releaseDone);
          }
          yield* retiringRunner.runOnce(orgId, agentId);
          assert.strictEqual(stops, outcome === "releasing" ? 2 : 1);
          if (outcome === "shared") {
            assert.isTrue(
              yield* sessions.isLive(projection.providerThreads[0]!.providerSessionId!),
            );
            assert.isDefined(yield* credentials.resolve(token));
            const denied = yield* identity.resolveAgent(caller!).pipe(Effect.flip);
            assert.propertyVal(denied, "reason", "not_allowed");
            assert.strictEqual(denied.message, "Kin agent thread is not active.");
          }
          yield* Deferred.succeed(hold, undefined);
          yield* Fiber.join(active);
          assert.deepStrictEqual(
            yield* sql`SELECT state FROM kin_events WHERE event_id = 'retired'`,
            [{ state: "expired" }],
          );
          assert.strictEqual(
            (yield* sql`SELECT 1 FROM kin_agent_threads WHERE ended_at IS NULL AND org_id = ${orgId}`)
              .length,
            0,
          );
          assert.strictEqual((yield* sql`SELECT 1 FROM kin_wakeups`).length, 1);
        }).pipe(
          Effect.provide(
            harness({
              entered,
              hold,
              ...(outcome === "shared" ? { sharedWith: [ThreadId.make("sibling")] } : {}),
              ...(outcome === "releasing" ? { releaseEntered, releaseHold, releaseDone } : {}),
            }),
          ),
        );
      }).pipe(provideDeterministicTestRuntime),
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
          Layer.mock(KinIdentity.KinIdentity)({
            owner: { _tag: "person", orgId, personId: KinPersonId.make("owner") },
            isAgentThread: () => false,
          }),
        ),
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ChatService.KinChatService)({}),
            Layer.mock(ChatHub.KinChatHub)({}),
            Layer.mock(Budget.KinBudget)({}),
            Layer.mock(KinEventQueue.KinEventQueue)({}),
            Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
            Layer.mock(ThreadManagement.ThreadManagementService)({}),
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(ServerSettings.ServerSettingsService)({}),
            Layer.mock(KinIssuedTokens.KinIssuedTokens)({}),
            Layer.succeed(KinLeadPrompt, { build: () => Effect.succeed("unused") }),
            Layer.effect(MemoryConfig.MemoryConfig, Effect.die("invalid memory config")),
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
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          McpSessionRegistryTestkit.layer,
          KinPersistence.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)),
        ),
      ),
    );
  });
});
