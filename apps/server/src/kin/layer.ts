import { TaskCardIndex } from "./widgets/taskCard.ts";
import { KinChatRepository } from "./chat/KinChatRepository.ts";
import type * as SqlClient from "effect/sql/SqlClient";
import * as TaskCardUpdater from "./chat/TaskCardUpdater.ts";
import * as Cause from "effect/Cause";
import * as KinEnabled from "./KinEnabled.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Option from "effect/Option";
import * as KinChat from "./chat/layer.ts";
import * as KinAttachmentStore from "./chat/KinAttachmentStore.ts";
import * as KinApprovals from "./approvals/layer.ts";
import * as RetiredActions from "./approvals/retiredActions.ts";
import * as KeySeal from "./approvals/KeySeal.ts";
import * as ApprovalCards from "./chat/approvalCards.ts";
import * as ExecutionNotices from "./chat/executionNotices.ts";
import * as KinPush from "./push/layer.ts";
import * as LevelControl from "./levels/LevelControl.ts";
import * as MemoryChanges from "./memory/MemoryChanges.ts";
import * as KinRecords from "./work/KinRecords.ts";
import { KinChatHub } from "./chat/KinChatHub.ts";

import { KinServer, type Services } from "./KinServer.ts";
export { KinServer } from "./KinServer.ts";
import type * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as KinMcp from "./mcp/layer.ts";
import * as GithubWebhooks from "./triggers/githubWebhooks.ts";

const enabled = <E, R>(seal: Layer.Layer<KeySeal.KinKeySeal, E, R>) =>
  Layer.effect(
    KinServer,
    Effect.gen(function* () {
      const services = yield* Effect.context<Services>();
      const hub = yield* KinChatHub;
      const updaterServices = yield* Effect.context<
        KinChatRepository | TaskCardIndex | KinChatHub | SqlClient.SqlClient
      >();
      return {
        taskCardUpdater: TaskCardUpdater.layer.pipe(
          Layer.provide(Layer.succeedContext(updaterServices)),
        ),
        services: Option.some(services),
        subscribeForViewer: Option.some(hub.subscribeForViewer),
      };
    }),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        // On top of level control and approvals: the executor takes approvals from their
        // pending actions instance.
        KinApprovals.executorLayer.pipe(
          Layer.provide(ExecutionNotices.layer),
          Layer.provideMerge(
            Layer.mergeAll(
              KinPush.layer,
              LevelControl.layer,
              MemoryChanges.layer,
              KinRecords.layer,
              ApprovalCards.layer,
              RetiredActions.layer,
            ).pipe(
              Layer.provideMerge(
                KinApprovals.layer.pipe(Layer.provide(ExecutionNotices.keyNoticesLayer)),
              ),
            ),
          ),
        ),
        GithubWebhooks.lockLayer,
      ).pipe(Layer.provideMerge(KinChat.layer)),
    ),
    // Inside `enabled`: built only with Kin on, and a secret store failure disables Kin, not the server.
    Layer.provide(seal),
  );
const disabled = Layer.succeed(KinServer, {
  taskCardUpdater: Layer.empty,
  services: Option.none(),
  subscribeForViewer: Option.none(),
});

const runtime = <E, R>(seal: Layer.Layer<KeySeal.KinKeySeal, E, R>) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const config = yield* KinEnabled.KinEnabled;
      return config.enabled
        ? enabled(seal).pipe(
            Layer.catchCause((cause) =>
              Layer.effect(
                KinServer,
                config.reportFailure(cause).pipe(
                  Effect.as({
                    taskCardUpdater: Layer.empty,
                    services: Option.none(),
                    subscribeForViewer: Option.none(),
                  }),
                ),
              ),
            ),
          )
        : disabled;
    }),
  ).pipe(
    Layer.provide(KinEnabled.layer),
    Layer.catchCause((cause) =>
      Layer.effect(
        KinServer,
        Effect.logError("Kin disabled: invalid configuration.", Cause.pretty(cause)).pipe(
          Effect.as({
            taskCardUpdater: Layer.empty,
            services: Option.none(),
            subscribeForViewer: Option.none(),
          }),
        ),
      ),
    ),
  );

const middleware = HttpRouter.middleware<{ provides: KinServer }>()(
  Effect.gen(function* () {
    const kin = yield* KinServer;
    return (effect) => Effect.provideService(effect, KinServer, kin);
  }),
).layer;

/** Tests pass `KeySeal.layerTest()` so they can seal the key rows they write. */
export const layerWithSeal = <E, R>(seal: Layer.Layer<KeySeal.KinKeySeal, E, R>) =>
  middleware.pipe(Layer.provideMerge(runtime(seal)));

export const layer = layerWithSeal(KeySeal.layer);

const taskCardUpdater = Layer.unwrap(
  Effect.gen(function* () {
    const kin = yield* KinServer;
    return Option.isSome(kin.services)
      ? kin.taskCardUpdater.pipe(
          Layer.catchCause(() =>
            Layer.effectDiscard(Effect.logWarning("Kin task card updater disabled.")),
          ),
        )
      : Layer.empty;
  }),
);

export const mcpLayer = (base: Parameters<typeof KinMcp.transport>[0]) =>
  Layer.mergeAll(KinMcp.transport(base), taskCardUpdater);

export const mcpRegistryLayer = <E, R>(
  base: Layer.Layer<McpSessionRegistry.McpSessionRegistry, E, R>,
) =>
  KinMcp.registry(base).pipe(
    Layer.provideMerge(layer),
    // The chat service takes this optionally, so the running server names it here.
    Layer.provide(KinAttachmentStore.layer),
    Layer.provide(SqlitePersistence.layerConfig),
  );
