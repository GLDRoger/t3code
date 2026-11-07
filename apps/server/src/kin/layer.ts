import * as Cause from "effect/Cause";
import * as KinEnabled from "./KinEnabled.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Option from "effect/Option";
import * as KinChat from "./chat/layer.ts";
import { KinChatHub } from "./chat/KinChatHub.ts";

import { KinServer, type Services } from "./KinServer.ts";
export { KinServer } from "./KinServer.ts";
import type * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as KinMcp from "./mcp/layer.ts";

// LEAD-5 supplies its runner here, using this root's identity rather than building another.
const lead: Layer.Layer<never, never, Services | KinChatHub> = Layer.empty;
const enabled = Layer.effect(
  KinServer,
  Effect.gen(function* () {
    const services = yield* Effect.context<Services>();
    const hub = yield* KinChatHub;
    return {
      services: Option.some(services),
      subscribeForViewer: Option.some(hub.subscribeForViewer),
    };
  }),
).pipe(Layer.provide(lead.pipe(Layer.provideMerge(KinChat.layer))));
const disabled = Layer.succeed(KinServer, {
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
              config
                .reportFailure(cause)
                .pipe(Effect.as({ services: Option.none(), subscribeForViewer: Option.none() })),
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
        Effect.as({ services: Option.none(), subscribeForViewer: Option.none() }),
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

export const mcpLayer = (base: Parameters<typeof KinMcp.transport>[0]) =>
  KinMcp.transport(base).pipe(Layer.provide(layer));
export const mcpRegistryLayer = <E, R>(
  base: Layer.Layer<McpSessionRegistry.McpSessionRegistry, E, R>,
) =>
  KinMcp.registry(base).pipe(
    Layer.provideMerge(layer),
    Layer.provide(SqlitePersistence.layerConfig),
  );
