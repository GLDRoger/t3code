import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as Routines from "../triggers/routines.ts";
import * as DeferralFlow from "../triggers/deferralFlow.ts";
import * as GithubEvents from "../triggers/githubEvents.ts";
import * as Watchdogs from "../triggers/watchdogs.ts";
import * as GithubReaders from "../triggers/githubReaders.ts";
import * as OwnerCheck from "../triggers/ownerCheck.ts";
import * as TriggerScheduler from "../triggers/KinTriggerScheduler.ts";
import * as TriggerStore from "../triggers/KinTriggerStore.ts";
import * as TriggerInbox from "../triggers/KinTriggerInbox.ts";
import * as TriggerService from "../triggers/KinTriggerService.ts";
import { forkParked } from "../../serverActivation.ts";
import { KinOrgId, KinChatId, KinMessageId } from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as SqlClient from "effect/sql/SqlClient";
import * as Option from "effect/Option";
import { KinChatHub } from "../chat/KinChatHub.ts";
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
import * as MemoryPullRequests from "../memory/MemoryPullRequests.ts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Scan from "../memory/secretScan.ts";
import * as LeadMemory from "./LeadMemory.ts";
import * as Cache from "../memory/MemoryCache.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import { KinLeadToolkit } from "./mcp/tools.ts";
import { handlers } from "./mcp/handlers.ts";
import * as KinLeadRegistry from "./KinLeadRegistry.ts";
import { KinLeadPrompt } from "./LeadPrompt.ts";
import * as WakeupRunner from "./WakeupRunner.ts";
import * as RoutineContent from "./RoutineContent.ts";
import * as KinStop from "./KinStop.ts";
import { KinPromotion } from "../levels/Promotion.ts";
import * as DreamRunner from "../dreaming/DreamRunner.ts";
import * as DreamSession from "../dreaming/DreamSession.ts";
import * as Workers from "./Workers.ts";
import * as WorkerTracker from "./WorkerTracker.ts";

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
  GithubEvents.consumerLayer,
  Watchdogs.runtimeLayer,
).pipe(
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
  writer: Writer.MemoryWriter["Service"],
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
        writer.sweepPullRequests(orgId).pipe(
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

const runner = Layer.effectDiscard(
  Effect.gen(function* () {
    const runner = yield* WakeupRunner.WakeupRunner;
    const stop = yield* KinStop.KinStop;
    // The owner's keep-or-discard of shadow memory runs on this runtime's writer.
    const writer = yield* Effect.serviceOption(Writer.MemoryWriter);
    const promotion = yield* Effect.serviceOption(KinPromotion);
    if (Option.isSome(writer) && Option.isSome(promotion))
      yield* promotion.value.attachShadowMemory(writer.value.settleShadow);
    yield* Effect.gen(function* () {
      const context = yield* Layer.build(routineRuntime);
      if (Option.isSome(writer))
        yield* Context.get(context, Scheduler.Scheduler).register(
          "kin-memory-pull-requests",
          yield* memoryPullRequestSweep(writer.value),
        );
      yield* Layer.build(dreamRuntime.pipe(Layer.provide(Layer.succeedContext(context)))).pipe(
        Effect.catchCause((cause) => Effect.logError("Kin dreams unavailable", { cause })),
      );
      yield* stop.attach(
        yield* KinStop.makeFanOut(Context.getOption(context, Routines.KinRoutines)),
      );
      yield* runner.start.pipe(Effect.provideContext(context));
    }).pipe(forkParked);
  }),
).pipe(
  Layer.provide(WakeupRunner.layer),
  Layer.provide(Layer.mergeAll(OwnerCheck.layer, RoutineContent.layer)),
);

const withServices = <A, E, R>(entry: Layer.Layer<A, E, R>) =>
  entry.pipe(
    Layer.provide(
      Layer.mergeAll(KinLeadRegistry.layer, KinLeadPrompt.layer).pipe(
        Layer.provideMerge(Layer.mergeAll(Memory.layer, KinChatRepository.layer)),
      ),
    ),
    Layer.provide(
      Layer.effect(
        Memory.MemoryRecoveryHooks,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const chat = yield* KinChatRepository.KinChatRepository;
          const hub = yield* Effect.serviceOption(KinChatHub);
          return Memory.MemoryRecoveryHooks.of({
            notify: Effect.fn("KinMemoryRecovery.notify")(
              function* (notice) {
                yield* Effect.logWarning("Kin memory recovery requires operator attention", notice);
                const leads = yield* sql<{
                  chatId: string;
                }>`SELECT DISTINCT l.owner_chat_id AS "chatId" FROM kin_leads l
                  JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
                    AND a.retired_at IS NULL
                  WHERE l.org_id = ${notice.orgId} ORDER BY l.owner_chat_id`;
                for (const lead of leads) {
                  const message = yield* chat.insertMessage({
                    orgId: notice.orgId,
                    chatId: KinChatId.make(lead.chatId),
                    messageId: KinMessageId.make(`kin-memory:${SecureRandom.uuidV4Unsafe()}`),
                    author: { _tag: "system" },
                    kind: "text",
                    body: notice.reason,
                    intent: null,
                    mentions: [],
                    replyTo: null,
                    widgetId: null,
                    floorRunId: null,
                    status: "posted",
                    sentBy: null,
                    clientMessageId: null,
                    createdAt: DateTime.formatIso(yield* DateTime.now),
                    editedAt: null,
                  });
                  if (Option.isSome(hub))
                    yield* hub.value.publish({
                      type: "message.posted",
                      orgId: notice.orgId,
                      message,
                    });
                }
              },
              Effect.catchCause((cause) =>
                Effect.logError("Kin memory owner notice failed", cause),
              ),
            ),
          });
        }),
      ).pipe(Layer.provide(KinChatRepository.layer)),
    ),
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

const registration = McpHttpServer.toolkitRegistration(KinLeadToolkit, handlers);
const toolkit = LeadMemory.layer.pipe(
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

export const layer = withServices(runner);
const tracker = Layer.effectDiscard(
  Effect.gen(function* () {
    const tracker = yield* WorkerTracker.WorkerTracker;
    yield* tracker.start.pipe(forkParked);
  }),
).pipe(Layer.provide(WorkerTracker.layer));
const production = withServices(
  Layer.mergeAll(runner, registration, tracker).pipe(
    Layer.provideMerge(Workers.layer),
    Layer.provideMerge(toolkit),
  ),
);

const Repositories = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ orgId: KinOrgId, repoUrl: Schema.String })),
);
const configured = <A, E, R>(entry: Layer.Layer<A, E, R>) =>
  containStartup(
    Layer.unwrap(
      Effect.gen(function* () {
        const repositories = yield* Config.schema(Repositories, "KIN_MEMORY_REPOSITORIES").pipe(
          Config.withDefault([]),
        );
        if (repositories.length === 0) return Layer.empty;
        return entry.pipe(Layer.provide(MemoryConfig.layer(repositories)));
      }),
    ),
  );

export const layerServer = configured(layer);
export const layerMcp = configured(production);
