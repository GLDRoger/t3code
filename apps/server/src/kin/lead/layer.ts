import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as Routines from "../triggers/routines.ts";
import * as DeferralFlow from "../triggers/deferralFlow.ts";
import * as ScheduledTasks from "../triggers/scheduledTasks.ts";
import * as KinSchedules from "../triggers/kinSchedules.ts";
import * as GithubEvents from "../triggers/githubEvents.ts";
import * as Watchdogs from "../triggers/watchdogs.ts";
import * as GithubReaders from "../triggers/githubReaders.ts";
import * as OwnerCheck from "../triggers/ownerCheck.ts";
import * as TriggerScheduler from "../triggers/KinTriggerScheduler.ts";
import * as TriggerStore from "../triggers/KinTriggerStore.ts";
import * as TriggerInbox from "../triggers/KinTriggerInbox.ts";
import * as TriggerService from "../triggers/KinTriggerService.ts";
import * as OwnerTimeZone from "../triggers/ownerTimeZone.ts";
import { forkParked } from "../../serverActivation.ts";
import * as OwnerNotices from "./OwnerNotices.ts";
import * as Option from "effect/Option";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as KinChatRepository from "../chat/KinChatRepository.ts";
import * as Memory from "../memory/Memory.ts";
import * as MemoryConfig from "../memory/MemoryConfig.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as Writer from "../memory/MemoryWriter.ts";
import * as MemoryLander from "../memory/MemoryLander.ts";
import * as MemoryPullRequests from "../memory/MemoryPullRequests.ts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Scan from "../memory/secretScan.ts";
import * as LeadMemory from "./LeadMemory.ts";
import * as Cache from "../memory/MemoryCache.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import { KinLeadToolkit } from "./mcp/tools.ts";
import { handlers } from "./mcp/handlers.ts";
import { KinWorkToolkit } from "../work/mcp/tools.ts";
import { handlers as workHandlers } from "../work/mcp/handlers.ts";
import { importWork } from "../work/importWork.ts";
import * as KinLeadRegistry from "./KinLeadRegistry.ts";
import { KinLeadPrompt } from "./LeadPrompt.ts";
import * as WakeupRunner from "./WakeupRunner.ts";
import * as ReplyBridge from "../reply/KinReplyBridge.ts";
import * as RoutineContent from "./RoutineContent.ts";
import * as LeadDelivery from "./LeadDelivery.ts";
import * as KinStop from "./KinStop.ts";
import { KinMemoryChanges } from "../memory/MemoryChanges.ts";
import * as DreamRunner from "../dreaming/DreamRunner.ts";
import * as DreamSession from "../dreaming/DreamSession.ts";
import * as Handoff from "./Handoff.ts";
import * as Workers from "./Workers.ts";
import * as KinRepoReads from "../github/KinRepoReads.ts";
import * as WorkerTracker from "./WorkerTracker.ts";
import * as WorkerEnvironment from "./workerEnvironment.ts";
import * as WorkerPublish from "./workerPublish.ts";
import * as ChatWake from "./ChatWake.ts";

export class KinLeadStartupError extends Schema.TaggedError<KinLeadStartupError>()(
  "KinLeadStartupError",
  {
    stage: Schema.Literal("startup"),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export function containStartup<A, E, R>(layer: Layer.Layer<A, E, R>) {
  return Layer.effectDiscard(Effect.void).pipe(
    Layer.provide(layer),
    Layer.catchCause((cause) =>
      Layer.effectDiscard(
        Effect.logError(
          "Kin startup failed; Kin disabled",
          new KinLeadStartupError({ stage: "startup", cause }),
        ),
      ),
    ),
  );
}

const routineRuntime = Layer.mergeAll(
  Routines.layer,
  DeferralFlow.layer,
  ScheduledTasks.layer,
  GithubEvents.consumerLayer,
  Watchdogs.runtimeLayer,
).pipe(
  Layer.provideMerge(LeadDelivery.layer),
  Layer.provideMerge(TriggerScheduler.layer),
  Layer.provideMerge(Layer.mergeAll(TriggerStore.layer, TriggerInbox.layer)),
  // Kin builds in its contained startup scope; orchestration runtime does not expose its scheduler.
  Layer.provideMerge(Scheduler.layer),
);
const dreamRuntime = DreamRunner.layer.pipe(
  Layer.provide(DreamSession.layer),
  Layer.provide(Scan.layer),
  Layer.provide(Cache.layer),
);

// TRIG-15: at startup and every 5 minutes, close memory PRs no write waits on.
const memoryPullRequestSweep = Effect.fn("KinMemoryPullRequests.sweepDue")(function* (
  lander: MemoryLander.MemoryLander["Service"],
) {
  const { repositories } = yield* MemoryConfig.MemoryConfig;
  let due = 0;
  return Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (now < due) return;
    due = now + 5 * 60_000;
    yield* Effect.forEach(
      repositories,
      ({ orgId }) =>
        lander.sweep(orgId).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Kin memory PR sweep failed", {
              orgId,
              cause: Cause.pretty(cause),
            }),
          ),
        ),
      { discard: true },
    );
  });
});

/**
 * The writer's fsck and remote sync, off the reply path: at start, then every five minutes. Each
 * sync then ends who may know whatever the default branch now holds retired, GitHub merges too.
 */
const memorySync = Effect.fn("KinMemory.syncDue")(function* (
  memory: Memory.Memory["Service"],
  writer: Option.Option<Writer.MemoryWriter["Service"]>,
) {
  const { repositories } = yield* MemoryConfig.MemoryConfig;
  let due = 0;
  return Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (now < due) return;
    due = now + 5 * 60_000;
    yield* Effect.forEach(
      repositories,
      ({ orgId }) =>
        memory.syncCheckout(orgId).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Kin memory sync failed; the next wake-up re-checks", {
              orgId,
              cause: Cause.pretty(cause),
            }),
          ),
          Effect.andThen(
            Option.isNone(writer)
              ? Effect.void
              : writer.value.reconcileSharing(orgId).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("Kin could not reconcile retired memory's sharing", {
                      orgId,
                      cause: Cause.pretty(cause),
                    }),
                  ),
                ),
          ),
        ),
      { discard: true },
    );
  });
});

const runner = Layer.effectDiscard(
  Effect.gen(function* () {
    const runner = yield* WakeupRunner.WakeupRunner;
    const memory = yield* Memory.Memory;
    const stop = yield* KinStop.KinStop;
    const ownerTimeZone = yield* Effect.serviceOption(OwnerTimeZone.KinOwnerTimeZone);
    // The owner's Undo on a memory change card runs on this runtime's writer.
    const writer = yield* Effect.serviceOption(Writer.MemoryWriter);
    const memoryChanges = yield* Effect.serviceOption(KinMemoryChanges);
    const lander = yield* Effect.serviceOption(MemoryLander.MemoryLander);
    if (Option.isSome(writer) && Option.isSome(memoryChanges))
      yield* memoryChanges.value.attachWriter({
        undo: writer.value.undoChange,
        relabel: writer.value.relabel,
        retire: writer.value.retire,
        items: (orgId) => memory.items(orgId),
      });
    yield* Effect.gen(function* () {
      const context = yield* Layer.build(routineRuntime);
      yield* Context.get(context, Scheduler.Scheduler).register(
        "kin-memory-sync",
        yield* memorySync(memory, writer),
      );
      if (Option.isSome(lander))
        yield* Context.get(context, Scheduler.Scheduler).register(
          "kin-memory-pull-requests",
          yield* memoryPullRequestSweep(lander.value),
        );
      yield* Layer.build(dreamRuntime.pipe(Layer.provide(Layer.succeedContext(context)))).pipe(
        Effect.catchCause((cause) => Effect.logError("Kin dreams unavailable", { cause })),
      );
      const routines = Context.getOption(context, Routines.KinRoutines);
      yield* stop.attach({ ...(yield* KinStop.makeFanOut(routines)), abort: runner.abort });
      if (Option.isSome(routines) && Option.isSome(ownerTimeZone))
        yield* ownerTimeZone.value.attach(routines.value);
      yield* runner.start.pipe(Effect.provideContext(context));
    }).pipe(forkParked);
  }),
).pipe(
  Layer.provide(WakeupRunner.layer.pipe(Layer.provide(ReplyBridge.layer))),
  Layer.provide(Layer.mergeAll(OwnerCheck.layer, RoutineContent.layer)),
);

const withServices = <A, E, R>(entry: Layer.Layer<A, E, R>) =>
  entry.pipe(
    Layer.provide(
      Layer.mergeAll(KinLeadRegistry.layer, KinLeadPrompt.layer).pipe(
        Layer.provideMerge(Layer.mergeAll(Memory.layer, KinChatRepository.layer)),
      ),
    ),
    Layer.provide(OwnerNotices.layer.pipe(Layer.provide(KinChatRepository.layer))),
    Layer.provide(
      TriggerService.syncHooksLayer.pipe(
        Layer.provide(TriggerService.layer),
        Layer.provide(KinChatRepository.layer),
      ),
    ),
    Layer.provide(KinPersistence.layer),
    Layer.provide(GithubReaders.layer),
  );

// TRIG-15: without the Kin App, memory writes to the default branch are refused unless
// KIN_MEMORY_DIRECT_PUSH=true, because the memory repo's ruleset rejects a direct push.
const memoryPullRequests = Layer.unwrap(
  Effect.gen(function* () {
    const off =
      "memory writes to the default branch are refused unless KIN_MEMORY_DIRECT_PUSH=true";
    if (Option.isNone(yield* Config.option(Config.String("KIN_GITHUB_APP_ID")))) {
      yield* Effect.logWarning(`Kin memory PRs are off: KIN_GITHUB_APP_ID is unset, so ${off}`);
      return Layer.empty;
    }
    return MemoryPullRequests.layer.pipe(
      Layer.provide(GithubReaders.appLayer),
      Layer.catchCause((cause) =>
        Layer.effectDiscard(
          Effect.logWarning(
            `Kin memory PRs are off: the Kin GitHub App is unavailable, so ${off}`,
            Cause.pretty(cause),
          ),
        ),
      ),
    );
  }),
);

const registration = Layer.merge(
  McpHttpServer.toolkitRegistration(KinLeadToolkit, handlers),
  McpHttpServer.toolkitRegistration(KinWorkToolkit, workHandlers),
);
const toolkit = LeadMemory.layer.pipe(
  Layer.provide(KinSchedules.layer),
  Layer.provideMerge(Writer.layer),
  Layer.provide(memoryPullRequests),
  Layer.provide(LeadMemory.authority),
  Layer.provide(Cache.layer),
  Layer.provide(Scan.layer),
  Layer.provide(
    Layer.succeed(Writer.MemoryWriterHooks, {
      notify: Effect.fn("KinMemoryWriter.notify")((notice) =>
        Effect.logWarning("Kin memory writer refused commit", {
          orgId: notice.orgId,
          wakeupId: notice.wakeupId,
          errorTag: notice.error._tag,
        }),
      ),
    }),
  ),
);

export const layer = withServices(Layer.merge(runner, ChatWake.layer));
// Workers hold no GitHub write credential; without the Kin App, their branches stay there.
const workerPublish = Layer.unwrap(
  Effect.gen(function* () {
    const off = "finished workers' branches stay in the worker environment";
    if (Option.isNone(yield* Config.option(Config.String("KIN_GITHUB_APP_ID")))) {
      yield* Effect.logWarning(
        `Kin worker publishing is off: KIN_GITHUB_APP_ID is unset, so ${off}`,
      );
      return Layer.empty;
    }
    return WorkerPublish.layer.pipe(
      Layer.provide(GithubReaders.appLayer),
      Layer.catchCause((cause) =>
        Layer.effectDiscard(
          Effect.logWarning(
            `Kin worker publishing is off: the Kin GitHub App is unavailable, so ${off}`,
            Cause.pretty(cause),
          ),
        ),
      ),
    );
  }),
);
// A lead's GitHub read tools; without the Kin App they answer that GitHub isn't connected.
const repoReads = Layer.unwrap(
  Effect.gen(function* () {
    if (Option.isNone(yield* Config.option(Config.String("KIN_GITHUB_APP_ID"))))
      return KinRepoReads.notConnectedLayer;
    return KinRepoReads.layer.pipe(
      Layer.provide(Layer.mergeAll(GithubReaders.appLayer, GithubEvents.repoScopeLayer)),
      Layer.catchCause((cause) =>
        KinRepoReads.notConnectedLayer.pipe(
          Layer.tap(() =>
            Effect.logWarning(
              "Kin lead GitHub reads are off: the Kin GitHub App is unavailable",
              Cause.pretty(cause),
            ),
          ),
        ),
      ),
    );
  }),
);
// Workers run only in the linked worker environment; see workerEnvironment.ts.
const workers = Workers.layer.pipe(
  Layer.provideMerge(WorkerTracker.layer.pipe(Layer.provide(workerPublish))),
  Layer.provideMerge(WorkerEnvironment.layer),
  // The repositories the owner connected are part of where the owner's own work may start.
  Layer.provide(GithubEvents.repoScopeLayer),
);
const tracker = Layer.effectDiscard(
  Effect.gen(function* () {
    const tracker = yield* WorkerTracker.WorkerTracker;
    yield* tracker.start.pipe(forkParked);
  }),
);
// Once per item, at every start: what leads tracked before Work existed becomes entries.
const workImport = Layer.effectDiscard(
  Effect.gen(function* () {
    const memory = yield* Memory.Memory;
    const { repositories } = yield* MemoryConfig.MemoryConfig;
    yield* Effect.forEach(
      repositories,
      ({ orgId }) =>
        Effect.gen(function* () {
          const items = yield* memory.items(orgId, "triggers");
          const imported = yield* importWork(
            orgId,
            items.map((item) => item.head),
          );
          if (imported.workers + imported.memory > 0)
            yield* Effect.logInfo("Kin brought earlier tracking into Work", { orgId, ...imported });
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Kin Work import failed; the next start tries again", {
              orgId,
              cause: Cause.pretty(cause),
            }),
          ),
        ),
      { discard: true },
    ).pipe(forkParked);
  }),
);
const production = withServices(
  Layer.mergeAll(runner, ChatWake.layer, registration, tracker, workImport).pipe(
    Layer.provideMerge(workers),
    Layer.provideMerge(Handoff.layer),
    Layer.provideMerge(toolkit),
    Layer.provide(repoReads),
  ),
);

const configured = <A, E, R>(entry: Layer.Layer<A, E, R>) =>
  containStartup(
    Layer.unwrap(
      Effect.gen(function* () {
        const repositories = yield* MemoryConfig.configuredRepositories;
        if (repositories.length === 0) return Layer.empty;
        return entry.pipe(Layer.provide(MemoryConfig.layer(repositories)));
      }),
    ),
  );

export const layerServer = configured(layer);
export const layerMcp = configured(production);
