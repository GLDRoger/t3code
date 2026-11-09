import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as ServerConfig from "../../config.ts";
import * as EffectWorker from "../../orchestration-v2/EffectWorker.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { provideDeterministicTestRuntime } from "../../orchestration-v2/testkit/DeterministicRuntime.ts";
import * as ChatService from "../chat/KinChatService.ts";
import * as ChatHub from "../chat/KinChatHub.ts";
import * as Presence from "../reply/KinPresence.ts";
import * as LevelGate from "./LevelGate.ts";
import * as KinEventQueue from "./KinEventQueue.ts";
import * as KinLead from "./layer.ts";
import { event, harness, seed, orgId } from "./WakeupRunner.testkit.ts";

const external = Layer.mergeAll(
  Layer.mock(ChatService.KinChatService)({}),
  Layer.mock(ChatHub.KinChatHub)({ subscribeAll: Effect.succeed(Stream.never) }),
  Layer.mock(LevelGate.KinLevelGate)({}),
  Layer.mock(Presence.KinPresence)({
    set: () => Effect.void,
    clear: () => Effect.void,
    snapshot: () => ({ presence: [], drafts: [] }),
  }),
  ServerConfig.layerTest(process.cwd(), { prefix: "kin-lead-layer-" }),
  Layer.mock(VcsProcess.VcsProcess)({}),
).pipe(Layer.provideMerge(NodeServices.layer));

vi.mock("../memory/Memory.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../memory/Memory.ts")>();
  const Effect = await import("effect/Effect");
  const Layer = await import("effect/Layer");
  const DateTime = await import("effect/DateTime");
  return {
    ...original,
    layer: Layer.effect(
      original.Memory,
      Effect.gen(function* () {
        yield* original.MemoryRecoveryHooks;
        let prepared = false;
        return original.Memory.of({
          withWriterLock: (_orgId, effect) => effect,
          anchor: () => Effect.die("unused"),
          record: () => Effect.die("unused"),
          recover: () => Effect.die("unused"),
          withHistoryRewrite: () => Effect.die("unused"),
          purgeInFlight: () => Effect.die("unused"),
          historyGeneration: () => Effect.die("unused"),
          ensureCheckouts: () => Effect.succeed({ writer: "/private/tmp", read: "/private/tmp" }),
          prepareWakeup: () =>
            Effect.sync(() => {
              prepared = true;
              return { head: "fixture-head", indexAsOf: DateTime.makeUnsafe(0) };
            }),
          readPromptSnapshot: (_orgId, head) =>
            prepared && head === "fixture-head"
              ? Effect.succeed({ rules: "Fixture standing rules", index: "Fixture memory index" })
              : Effect.die("Prompt and runner must share pinned memory"),
          readIndex: () => Effect.die("unused"),
          readRules: () => Effect.die("unused"),
          query: () => Effect.succeed([]),
          readItem: () => Effect.die("unused"),
          readItemQuietly: () => Effect.die("unused"),
          rebuildIndex: () => Effect.die("unused"),
          rebuildCache: () => Effect.die("unused"),
        });
      }),
    ),
  };
});

it.effect("starts configured Kin with the real prompt and the runner's pinned memory", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const hold = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      yield* seed;
      yield* (yield* KinEventQueue.KinEventQueue).enqueue({
        ...event("real-prompt"),
        _tag: "watchdog",
        finding: "Review requested three days ago",
        itemIds: [],
      });
      yield* Layer.build(
        Layer.fresh(KinLead.layerServer).pipe(
          Layer.provide(external),
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                KIN_MEMORY_REPOSITORIES: JSON.stringify([{ orgId, repoUrl: "fixture" }]),
              }),
            ),
          ),
        ),
      );
      yield* TestClock.adjust("20 seconds");
      yield* Deferred.await(entered);
      const sql = yield* SqlClient.SqlClient;
      const [wakeup] = yield* sql<{ thread_id: string }>`SELECT thread_id FROM kin_wakeups`;
      assert.isDefined(wakeup);
      const projection =
        yield* (yield* ThreadManagement.ThreadManagementService).getThreadProjection(
          ThreadId.make(wakeup!.thread_id),
        );
      assert.strictEqual(projection.messages.length, 1);
      assert.include(projection.messages[0]!.text, "instructions-version: 4");
      assert.include(projection.messages[0]!.text, "Fixture standing rules");
      assert.include(projection.messages[0]!.text, "Fixture memory index");
      yield* Deferred.succeed(hold, undefined);
      yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
    }).pipe(Effect.provide(harness({ entered, hold })));
  }).pipe(provideDeterministicTestRuntime),
);

it.effect("leaves unconfigured Kin silent and inert without building its dependencies", () =>
  Effect.gen(function* () {
    const entries: Array<unknown> = [];
    yield* Layer.build(KinLead.layerServer).pipe(
      Effect.provide(
        Layer.mergeAll(
          ConfigProvider.layer(ConfigProvider.fromUnknown({})),
          Logger.layer([Logger.make((entry) => entries.push(entry))]),
          external,
        ),
      ),
    );
    assert.deepStrictEqual(entries, []);
  }).pipe(Effect.provide(Layer.mergeAll(harness(), external)), provideDeterministicTestRuntime),
);
