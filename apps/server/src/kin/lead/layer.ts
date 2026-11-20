import * as SocialMcp from "../social/mcp.ts";
import * as SalesMcp from "../sales/mcp.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as Routines from "../triggers/routines.ts";
import * as DeferralFlow from "../triggers/deferralFlow.ts";
import * as ScheduledTasks from "../triggers/scheduledTasks.ts";
import * as KinSchedules from "../triggers/kinSchedules.ts";
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
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as KinChatRepository from "../chat/KinChatRepository.ts";
import * as Memory from "../memory/Memory.ts";
import * as MemoryConfig from "../memory/MemoryConfig.ts";
import { devMemoryRepository } from "../memory/devMemory.ts";
import { ServerConfig } from "../../config.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as Writer from "../memory/MemoryWriter.ts";
import * as MemoryLander from "../memory/MemoryLander.ts";
import * as MemoryPullRequests from "../memory/MemoryPullRequests.ts";
import * as Cause from "effect/Cause";
import * as Stream from "effect/Stream";
import type { KinOrgId } from "@t3tools/contracts";
import { KinChatHub } from "../chat/KinChatHub.ts";
import * as Clock from "effect/Clock";
import * as Scan from "../memory/secretScan.ts";
import * as LeadMemory from "./LeadMemory.ts";
import * as Cache from "../memory/MemoryCache.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import { KinLeadToolkit } from "./mcp/tools.ts";
import { handlers } from "./mcp/handlers.ts";
import { KinWorkToolkit } from "../work/mcp/tools.ts";
import { handlers as workHandlers } from "../work/mcp/handlers.ts";
import { KinDocsToolkit } from "../work/mcp/docTools.ts";
import { handlers as documentHandlers, KinDocumentToolkit } from "../gendocs/mcp.ts";
import * as Render from "../gendocs/render.ts";
import * as Toolchain from "../gendocs/toolchain.ts";
import * as Workspace from "../gendocs/workspace.ts";
import { handlers as docHandlers } from "../work/mcp/docHandlers.ts";
import { handlers as statementHandlers } from "../work/mcp/statementHandlers.ts";
import { KinStatementToolkit } from "../work/mcp/statementTools.ts";
import * as KinPulse from "../pulse/KinPulse.ts";
import * as KinRecommend from "../recommend/KinRecommend.ts";
import * as OpenShadow from "../open/shadow.ts";
import { handlers as pulseHandlers, KinPulseToolkit } from "../pulse/mcp.ts";
import { importWork } from "../work/importWork.ts";
import { reportIssuedWithoutAmount } from "../gendocs/amounts.ts";
import { countedEntry } from "../work/recordRows.ts";
import * as KinLeadRegistry from "./KinLeadRegistry.ts";
import { KinLeadPrompt } from "./LeadPrompt.ts";
import { KinTurnContent } from "./turn/content.ts";
import * as WakeupRunner from "./WakeupRunner.ts";
import * as ReplyBridge from "../reply/KinReplyBridge.ts";
import * as RoutineContent from "./RoutineContent.ts";
import * as LeadDelivery from "./LeadDelivery.ts";
import * as KinStop from "./KinStop.ts";
import { KinMemoryChanges } from "../memory/MemoryChanges.ts";
import * as DreamRunner from "../dreaming/DreamRunner.ts";
import * as DreamSession from "../dreaming/DreamSession.ts";
import * as Handoff from "./Handoff.ts";
import * as Team from "../team/KinTeam.ts";
import * as GitHubWatch from "../github/GitHubWatch.ts";
import * as TaskWake from "./TaskWake.ts";
import * as DelegatedTasks from "./DelegatedTasks.ts";
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
  GitHubWatch.liveLayer,
  Watchdogs.layer,
  KinPulse.layer,
  KinRecommend.layer,
  OpenShadow.layer,
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

/** A failed sweep is retried by the next sync, which also finishes one a crash cut short. */
const stripQuotes = (writer: Writer.MemoryWriter["Service"], orgId: KinOrgId) =>
  writer.stripQuotes(orgId).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Kin could not drop the quotes of deleted messages", {
        orgId,
        cause: Cause.pretty(cause),
      }),
    ),
  );

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
                  Effect.andThen(stripQuotes(writer.value, orgId)),
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
    const hub = yield* KinChatHub;
    const team = yield* Effect.serviceOption(Team.KinTeam);
    // A cleared chat's messages are gone, so are the words memory quoted from them.
    if (Option.isSome(writer))
      yield* (yield* hub.subscribeAll).pipe(
        Stream.filter((event) => event.type === "chat.cleared"),
        Stream.runForEach((event) => stripQuotes(writer.value, event.orgId)),
        Effect.forkScoped,
      );
    if (Option.isSome(writer) && Option.isSome(memoryChanges))
      yield* memoryChanges.value.attachWriter({
        undo: writer.value.undoChange,
        relabel: writer.value.relabel,
        retire: writer.value.retire,
        restore: writer.value.restore,
        recordDecision: writer.value.recordDecision,
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
      if (Option.isSome(team))
        yield* Context.get(context, Scheduler.Scheduler).register(
          "kin-team-sweep",
          team.value.sweep(),
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
      Layer.mergeAll(KinLeadRegistry.layer, KinLeadPrompt.layer, KinTurnContent.layer).pipe(
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

// TRIG-15: memory writes to the default branch land through PRs, as Kin's GitHub App where it is
// installed, else as the owner, unless KIN_MEMORY_DIRECT_PUSH=true; with neither, they're refused.
const memoryPullRequests = Layer.unwrap(
  Effect.gen(function* () {
    const { directMainPush } = yield* MemoryConfig.MemoryConfig;
    if (directMainPush === true) return Layer.empty;
    return MemoryPullRequests.layer.pipe(Layer.provide(GitHubWatch.ghApiLayer));
  }),
);

const registration = Layer.mergeAll(
  SocialMcp.registration,
  SalesMcp.registration,
  McpHttpServer.toolkitRegistration(KinLeadToolkit, handlers),
  McpHttpServer.toolkitRegistration(KinWorkToolkit, workHandlers),
  McpHttpServer.toolkitRegistration(KinDocsToolkit, docHandlers),
  McpHttpServer.toolkitRegistration(KinStatementToolkit, statementHandlers),
  McpHttpServer.toolkitRegistration(KinDocumentToolkit, documentHandlers),
  McpHttpServer.toolkitRegistration(KinPulseToolkit, pulseHandlers),
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
// Documents render on this server; agents' own files and recipe drafts come through it too.
const documents = Render.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(Workspace.layer, Toolchain.layer)),
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
          if (imported.memory > 0)
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
// At every start: each issued invoice left with no amount is named to the owner once; no amount is
// written (`gendocs/amounts.ts`).
const issuedAmounts = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // A startup scan across orgs: only those holding such an invoice not yet named.
    const orgs = yield* sql<{ orgId: KinOrgId }>`SELECT DISTINCT n.org_id AS "orgId"
      FROM kin_issued_numbers n
      JOIN kin_records r ON r.org_id = n.org_id AND r.record_id = n.record_id
      WHERE n.register_id = 'invoices' AND r.amount_minor IS NULL AND ${countedEntry(sql)}
        AND NOT EXISTS (SELECT 1 FROM kin_amount_notices a
          WHERE a.org_id = n.org_id AND a.record_id = n.record_id)
      ORDER BY n.org_id`;
    yield* Effect.forEach(
      orgs,
      ({ orgId }) =>
        reportIssuedWithoutAmount(orgId).pipe(
          Effect.tap((done) =>
            Effect.logInfo("Kin named issued invoices with no amount to the owner", {
              orgId,
              reported: done.reported.length,
              kept: done.kept.length,
            }),
          ),
        ),
      { discard: true },
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(
        "Kin couldn't name issued invoices with no amount; the next start tries again",
        {
          cause: Cause.pretty(cause),
        },
      ),
    ),
    forkParked,
  ),
);
const production = withServices(
  Layer.mergeAll(
    runner,
    ChatWake.layer,
    registration,
    TaskWake.layer,
    DelegatedTasks.layer,
    workImport,
    issuedAmounts,
  ).pipe(
    Layer.provideMerge(documents),
    Layer.provideMerge(Team.layer),
    Layer.provideMerge(Handoff.layer),
    Layer.provideMerge(toolkit),
  ),
);

const configured = <A, E, R>(entry: Layer.Layer<A, E, R>) =>
  Layer.merge(
    containStartup(
      Layer.unwrap(
        Effect.gen(function* () {
          const repositories = yield* MemoryConfig.configuredRepositories;
          if (repositories.length > 0)
            return entry.pipe(Layer.provide(MemoryConfig.layer(repositories)));
          const dev = yield* devMemoryRepository();
          if (dev === undefined) return Layer.empty;
          return entry.pipe(Layer.provide(MemoryConfig.layer(dev, { directMainPush: true })));
        }),
      ),
    ),
    unconfigured,
  );

// An installed host with no memory repository runs no agent; each chat with one hears why.
const unconfigured = containStartup(
  Layer.unwrap(
    Effect.gen(function* () {
      const repositories = yield* MemoryConfig.configuredRepositories;
      if (repositories.length > 0 || (yield* ServerConfig).devUrl !== undefined) return Layer.empty;
      yield* Effect.logError(
        "Kin agents can't run: no memory repository is set (KIN_MEMORY_REPOSITORIES)",
      );
      return ChatWake.unconfiguredLayer.pipe(Layer.provide(KinChatRepository.layer));
    }),
  ),
);

export const layerServer = configured(layer);
export const layerMcp = configured(production);
