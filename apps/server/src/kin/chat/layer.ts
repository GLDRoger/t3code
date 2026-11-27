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
import * as RefreshHub from "./KinRefreshHub.ts";
import * as Presence from "../reply/KinPresence.ts";
import * as Service from "./KinChatService.ts";
import * as Groups from "./KinGroups.ts";
import * as VisualHosts from "./KinVisualHosts.ts";
import * as Records from "../work/KinRecords.ts";
import { KinIdentity, KinIdentityConfig } from "./KinIdentity.ts";

const stop = Stop.layer.pipe(Layer.provide(Presence.layer), Layer.provideMerge(Queue.layer));

const service = Layer.mergeAll(
  // A clear stops the turns answering what it deleted, through the same fan-out as a join.
  LevelGate.layer.pipe(
    Layer.provideMerge(Service.layer),
    Layer.provide(stop),
    Layer.provideMerge(Presence.layer),
  ),
  Layer.mergeAll(
    Budget.layer.pipe(Layer.provide(Cache.layer)),
    OwnerTimeZone.layer,
    VisualHosts.layer,
  ).pipe(Layer.provideMerge(stop)),
  // A join stops the turns it aborts (`KinGroups.shareWith`) through the stop switch's fan-out.
  Groups.layer.pipe(
    Layer.provide(Presence.layer),
    Layer.provide(stop),
    Layer.provideMerge(KinIdentity.layer.pipe(Layer.provide(KinIdentityConfig.layer))),
  ),
);

const storage = Layer.merge(Hub.layer, RefreshHub.layer).pipe(
  Layer.provideMerge(Repository.layer),
  Layer.provide(KinPersistence.layer),
);

export const layer = service.pipe(Layer.provideMerge(storage));

export const layerWithWork = service.pipe(
  Layer.provideMerge(Records.layer.pipe(Layer.provideMerge(Queue.layer))),
  Layer.provideMerge(storage),
);
