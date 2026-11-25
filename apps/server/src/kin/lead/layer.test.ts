import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { KinChatId, KinOrgId, ThreadId } from "@t3tools/contracts";
import { McpServer } from "effect/ai";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient } from "effect/http";
import { vi } from "vite-plus/test";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import { ProcessRunner } from "../../processRunner.ts";
import { KinServer } from "../KinServer.ts";
import { KinSocial } from "../social/SocialService.ts";
import { KinPictures } from "../pictures/KinPictures.ts";
import * as PreviewBrowser from "../../preview/PreviewBrowser.ts";
import { zernio } from "../social/Zernio.ts";
import { KinSocialToolkit } from "../social/mcp.ts";
import { KinSalesToolkit } from "../sales/mcp.ts";
import { KinPulseToolkit } from "../pulse/mcp.ts";
import { KinDocumentToolkit } from "../gendocs/mcp.ts";
import { KinPictureToolkit } from "../pictures/mcp.ts";
import { KinWorkToolkit } from "../work/mcp/tools.ts";
import { KinDocsToolkit } from "../work/mcp/docTools.ts";
import { KinStatementToolkit } from "../work/mcp/statementTools.ts";
import { KinLeadToolkit } from "./mcp/tools.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as ServerConfig from "../../config.ts";
import * as DocumentText from "../../provider/DocumentText.ts";
import * as EffectWorker from "../../orchestration-v2/EffectWorker.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import { provideDeterministicTestRuntime } from "../../orchestration-v2/testkit/DeterministicRuntime.ts";
import * as ChatService from "../chat/KinChatService.ts";
import * as ChatHub from "../chat/KinChatHub.ts";
import * as Presence from "../reply/KinPresence.ts";
import * as LevelGate from "./LevelGate.ts";
import * as KinEventQueue from "./KinEventQueue.ts";
import * as Writer from "../memory/MemoryWriter.ts";
import * as KinRecords from "../work/KinRecords.ts";
import * as KinLead from "./layer.ts";
import { event, harness, seed, orgId } from "./WakeupRunner.testkit.ts";

const external = Layer.mergeAll(
  // The lead runtime attaches its memory reader for deferral card taps.
  Layer.mock(ChatService.KinChatService)({ attachDeferralItems: () => Effect.void }),
  Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
  Layer.mock(KinRecords.KinRecords)({}),
  Layer.mock(ChatHub.KinChatHub)({ subscribeAll: Effect.succeed(Stream.never) }),
  Layer.mock(LevelGate.KinLevelGate)({}),
  Layer.mock(Presence.KinPresence)({
    set: () => Effect.void,
    clear: () => Effect.void,
    snapshot: () => Effect.succeed({ presence: [], drafts: [] }),
    lines: () => [],
  }),
  Layer.mock(DocumentText.DocumentText)({}),
  Layer.mock(VcsProcess.VcsProcess)({}),
  // What the server and Kin's own services hand the runtime in `kin/mcp/layer.ts`.
  McpHttpServer.layerInProcessMcpServer,
  Layer.mock(KinServer)({
    services: Option.none(),
    subscribeForViewer: Option.none(),
    taskCardUpdater: Layer.empty,
  }),
  Layer.mock(KinSocial)({ provider: zernio }),
  Layer.mock(KinPictures)({}),
  Layer.mock(PreviewBrowser.PreviewBrowser)({}),
  Layer.mock(ProcessRunner)({}),
  Layer.mock(ServerEnvironment.ServerEnvironment)({}),
  FetchHttpClient.layer,
).pipe(
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-lead-layer-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

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
          withLandingLock: (_org, effect) => effect,
          landingState: () => Effect.die("unused"),
          purgeInFlight: () => Effect.die("unused"),
          historyGeneration: () => Effect.die("unused"),
          ensureCheckouts: () => Effect.succeed({ writer: "/private/tmp", read: "/private/tmp" }),
          prepareWakeup: () =>
            Effect.sync(() => {
              prepared = true;
              return {
                head: "fixture-head",
                indexAsOf: DateTime.makeUnsafe(0),
                read: "/private/tmp",
              };
            }),
          items: () => Effect.die("Unused"),
          snapshotItems: () => Effect.die("Unused"),
          readPromptSnapshot: (_orgId, head) =>
            prepared && head === "fixture-head"
              ? Effect.succeed({
                  rules: "Fixture standing rules",
                  index: "Fixture memory index",
                  items: [],
                  bodies: new Map(),
                })
              : Effect.die("Prompt and runner must share pinned memory"),
          readIndex: () => Effect.die("unused"),
          readRules: () => Effect.die("unused"),
          query: () => Effect.succeed([]),
          readItem: () => Effect.die("unused"),
          readItemQuietly: () => Effect.die("unused"),
          rebuildIndex: () => Effect.die("unused"),
          rebuildCache: () => Effect.die("unused"),
          syncCheckout: () => Effect.void,
        });
      }),
    ),
  };
});

// The runtime builds its own writer; a test that hands it one is heard instead.
vi.mock("../memory/MemoryWriter.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../memory/MemoryWriter.ts")>();
  const Effect = await import("effect/Effect");
  const Layer = await import("effect/Layer");
  const Option = await import("effect/Option");
  return {
    ...original,
    layer: Layer.unwrap(
      Effect.map(Effect.serviceOption(original.MemoryWriter), (given) =>
        Option.isSome(given) ? Layer.succeed(original.MemoryWriter, given.value) : original.layer,
      ),
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
      const built = yield* Layer.build(
        Layer.fresh(
          KinLead.layerRuntime.pipe(Layer.provideMerge(McpHttpServer.layerInProcessMcpServer)),
        ).pipe(
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
      // Every Kin toolkit the agents reach is registered by the same build.
      const registered = new Set(
        Context.get(built, McpServer.McpServer).tools.map(({ tool }) => tool.name),
      );
      for (const toolkit of [
        KinLeadToolkit,
        KinWorkToolkit,
        KinDocsToolkit,
        KinStatementToolkit,
        KinDocumentToolkit,
        KinPictureToolkit,
        KinPulseToolkit,
        KinSocialToolkit,
        KinSalesToolkit,
      ])
        for (const name of Object.keys(toolkit.tools)) assert.isTrue(registered.has(name), name);
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
      assert.notInclude(projection.messages[0]!.text, "instructions-version:");
      assert.include(projection.messages[0]!.text, "Fixture standing rules");
      assert.include(projection.messages[0]!.text, "Fixture memory index");
      yield* Deferred.succeed(hold, undefined);
      yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
    }).pipe(Effect.provide(harness({ entered, hold })));
  }).pipe(provideDeterministicTestRuntime),
);

it.effect("unconfigured Kin builds no runner and says once in the log why agents can't run", () =>
  Effect.gen(function* () {
    const entries: Array<{ readonly message: unknown }> = [];
    yield* Layer.build(KinLead.layerRuntime).pipe(
      Effect.provide(
        Layer.mergeAll(
          ConfigProvider.layer(ConfigProvider.fromUnknown({})),
          Logger.layer([Logger.make((entry) => entries.push(entry))]),
          external,
        ),
      ),
    );
    assert.deepStrictEqual(
      entries.map((entry) => String(entry.message)),
      ["Kin agents can't run: no memory repository is set (KIN_MEMORY_REPOSITORIES)"],
    );
  }).pipe(Effect.provide(Layer.mergeAll(harness(), external)), provideDeterministicTestRuntime),
);

it.effect("a cleared chat and each memory sync sweep deleted messages' quotes", () =>
  Effect.gen(function* () {
    const clearedOrg = KinOrgId.make("cleared-org");
    const cleared = yield* Deferred.make<void>();
    const synced = yield* Deferred.make<void>();
    const writer = Layer.mock(Writer.MemoryWriter)({
      reconcileSharing: () => Effect.void,
      stripQuotes: (org) => Deferred.succeed(org === clearedOrg ? cleared : synced, undefined),
    });
    const hub = Layer.mock(ChatHub.KinChatHub)({
      subscribeAll: Effect.succeed(
        Stream.make({
          type: "chat.cleared" as const,
          orgId: clearedOrg,
          chatId: KinChatId.make("cleared-chat"),
          lastSeq: 1,
          lastChangeSeq: 1,
        }),
      ),
    });
    yield* Layer.build(
      Layer.fresh(KinLead.layerRuntime).pipe(
        Layer.provide(Layer.mergeAll(writer, hub)),
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
    yield* Deferred.await(cleared);
    yield* TestClock.adjust("20 seconds");
    yield* Deferred.await(synced);
  }).pipe(Effect.provide(harness()), provideDeterministicTestRuntime),
);
