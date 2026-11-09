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
import * as KinApprovals from "./approvals/layer.ts";
import * as T3GitHubCredential from "./approvals/T3GitHubCredential.ts";
import * as ExecutionNotices from "./chat/executionNotices.ts";
import * as KinPush from "./push/layer.ts";
import * as Promotion from "./levels/Promotion.ts";
import { KinChatHub } from "./chat/KinChatHub.ts";

import { KinServer, type Services } from "./KinServer.ts";
export { KinServer } from "./KinServer.ts";
import type * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as KinMcp from "./mcp/layer.ts";
import * as GithubWebhooks from "./triggers/githubWebhooks.ts";

const enabled = Layer.effect(
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
      // Promotion asks for set_level through the same pending actions the executor watches.
      Layer.mergeAll(KinPush.layer, Promotion.layer).pipe(
        Layer.provideMerge(KinApprovals.layer.pipe(Layer.provide(ExecutionNotices.layer))),
      ),
      GithubWebhooks.lockLayer,
    ).pipe(Layer.provideMerge(KinChat.layer)),
  ),
);
const disabled = Layer.succeed(KinServer, {
  taskCardUpdater: Layer.empty,
  services: Option.none(),
  subscribeForViewer: Option.none(),
});

const runtime = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* KinEnabled.KinEnabled;
    return config.enabled
      ? enabled.pipe(
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

export const layer = middleware.pipe(Layer.provideMerge(runtime));

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

// Built with the server's source control host, which the executor's layer comes before.
const t3GitHubCredential = Layer.unwrap(
  Effect.gen(function* () {
    const kin = yield* KinServer;
    return Option.isSome(kin.services)
      ? T3GitHubCredential.installLayer.pipe(
          Layer.provide(Layer.succeedContext(kin.services.value)),
          Layer.catchCause((cause) =>
            Layer.effectDiscard(
              Effect.logWarning(
                "Kin: T3's GitHub credential can't be read; the credential check fails.",
                {
                  cause: Cause.pretty(cause).slice(0, 500),
                },
              ),
            ),
          ),
        )
      : Layer.empty;
  }),
);

export const mcpLayer = (base: Parameters<typeof KinMcp.transport>[0]) =>
  Layer.mergeAll(KinMcp.transport(base), taskCardUpdater, t3GitHubCredential);

export const mcpRegistryLayer = <E, R>(
  base: Layer.Layer<McpSessionRegistry.McpSessionRegistry, E, R>,
) =>
  KinMcp.registry(base).pipe(
    Layer.provideMerge(layer),
    Layer.provide(SqlitePersistence.layerConfig),
  );
