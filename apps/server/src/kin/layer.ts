import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Option from "effect/Option";
import * as KinChat from "./chat/layer.ts";
import { KinChatRepository } from "./chat/KinChatRepository.ts";
import { KinIdentity } from "./chat/KinIdentity.ts";
import { KinChatService } from "./chat/KinChatService.ts";
import { KinChatHub } from "./chat/KinChatHub.ts";

type Services = KinIdentity | KinChatService | KinChatHub | KinChatRepository;

export class KinServer extends Context.Service<
  KinServer,
  {
    readonly services: Option.Option<Context.Context<Services>>;
  }
>()("t3/kin/layer/KinServer") {}

// LEAD-5 supplies its runner here, using this root's identity rather than building another.
const lead: Layer.Layer<never, never, Services> = Layer.empty;
const enabled = Layer.effect(
  KinServer,
  Effect.context<Services>().pipe(Effect.map((services) => ({ services: Option.some(services) }))),
).pipe(Layer.provide(lead.pipe(Layer.provideMerge(KinChat.layer))));
const disabled = Layer.succeed(KinServer, { services: Option.none() });

const runtime = Layer.unwrap(
  Config.Boolean("KIN_ENABLED").pipe(
    Config.withDefault(false),
    Effect.map((configured) => (configured ? enabled : disabled)),
  ),
).pipe(
  Layer.catchCause(() =>
    Layer.effect(
      KinServer,
      Effect.logError("Kin disabled: initialization failed.").pipe(
        Effect.as({ services: Option.none() }),
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
