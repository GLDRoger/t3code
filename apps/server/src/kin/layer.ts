import * as Cause from "effect/Cause";
import * as KinEnabled from "./KinEnabled.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Option from "effect/Option";
import * as KinLead from "./lead/layer.ts";
import * as KinChat from "./chat/layer.ts";
import { KinIdentity } from "./chat/KinIdentity.ts";
import { KinChatService } from "./chat/KinChatService.ts";
import { KinChatHub } from "./chat/KinChatHub.ts";

type Services = KinIdentity | KinChatService;

export class KinServer extends Context.Service<
  KinServer,
  {
    readonly services: Option.Option<Context.Context<Services>>;
    readonly subscribeForViewer: Option.Option<KinChatHub["Service"]["subscribeForViewer"]>;
  }
>()("t3/kin/layer/KinServer") {}

const lead = KinLead.layerServer;
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
