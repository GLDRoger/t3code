import * as Layer from "effect/Layer";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as Repository from "./KinChatRepository.ts";
import * as Hub from "./KinChatHub.ts";
import * as Service from "./KinChatService.ts";
import { KinIdentity, KinIdentityConfig } from "./KinIdentity.ts";

export const layer = Layer.mergeAll(
  Service.layer,
  KinIdentity.layer.pipe(Layer.provide(KinIdentityConfig.layer)),
).pipe(
  Layer.provideMerge(Hub.layer),
  Layer.provideMerge(Repository.layer),
  Layer.provide(KinPersistence.layer),
);
