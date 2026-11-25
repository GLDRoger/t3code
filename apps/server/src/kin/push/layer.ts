import * as Layer from "effect/Layer";

import * as Cache from "../memory/MemoryCache.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as DevPushCapture from "./DevPushCapture.ts";
import * as Devices from "./KinPushDevices.ts";
import * as Dispatch from "./KinPushDispatch.ts";
import * as Presence from "./KinPushPresence.ts";
import * as Sender from "./KinPushSender.ts";

export const layer = Layer.merge(Dispatch.layer, Sender.recoverLayer).pipe(
  Layer.provideMerge(Sender.layer),
  Layer.provideMerge(Layer.mergeAll(Devices.layer, Presence.layer, DevPushCapture.layer)),
  Layer.provide(Cache.layer),
  Layer.provide(KinPersistence.layer),
);
