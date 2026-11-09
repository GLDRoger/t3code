import * as JudgeShadow from "../floor/JudgeShadow.ts";
import * as NoopJudge from "../floor/NoopJudge.ts";
import * as Layer from "effect/Layer";
import * as Budget from "../lead/KinBudget.ts";
import * as Queue from "../lead/KinEventQueue.ts";
import * as Stop from "../lead/KinStop.ts";
import * as OwnerTimeZone from "../triggers/ownerTimeZone.ts";
import * as Cache from "../memory/MemoryCache.ts";
import * as LevelGate from "../lead/LevelGate.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as Repository from "./KinChatRepository.ts";
import * as Hub from "./KinChatHub.ts";
import * as Service from "./KinChatService.ts";
import { KinIdentity, KinIdentityConfig } from "./KinIdentity.ts";

export const layer = Layer.mergeAll(
  LevelGate.layer.pipe(Layer.provideMerge(Service.layer)),
  Layer.mergeAll(
    Budget.layer.pipe(Layer.provide(Cache.layer)),
    Stop.layer,
    OwnerTimeZone.layer,
  ).pipe(Layer.provideMerge(Queue.layer)),
  KinIdentity.layer.pipe(Layer.provide(KinIdentityConfig.layer)),
).pipe(
  Layer.provide(JudgeShadow.layer.pipe(Layer.provide(NoopJudge.layer))),
  Layer.provideMerge(Hub.layer),
  Layer.provideMerge(Repository.layer),
  Layer.provide(KinPersistence.layer),
);
