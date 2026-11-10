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
import * as Presence from "../reply/KinPresence.ts";
import * as Service from "./KinChatService.ts";
import * as Groups from "./KinGroups.ts";
import { KinIdentity, KinIdentityConfig } from "./KinIdentity.ts";

const stop = Stop.layer.pipe(Layer.provide(Presence.layer), Layer.provideMerge(Queue.layer));

export const layer = Layer.mergeAll(
  LevelGate.layer.pipe(Layer.provideMerge(Service.layer), Layer.provideMerge(Presence.layer)),
  Layer.mergeAll(Budget.layer.pipe(Layer.provide(Cache.layer)), OwnerTimeZone.layer).pipe(
    Layer.provideMerge(stop),
  ),
  // A join stops the turns it aborts (`KinGroups.abortTurns`) through the stop switch's fan-out.
  Groups.layer.pipe(
    Layer.provide(Presence.layer),
    Layer.provide(stop),
    Layer.provideMerge(KinIdentity.layer.pipe(Layer.provide(KinIdentityConfig.layer))),
  ),
).pipe(
  Layer.provideMerge(Hub.layer),
  Layer.provideMerge(Repository.layer),
  Layer.provide(KinPersistence.layer),
);
