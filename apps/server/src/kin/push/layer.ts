import * as Layer from "effect/Layer";

import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as Apns from "./Apns.ts";
import * as Devices from "./KinPushDevices.ts";
import * as Presence from "./KinPushPresence.ts";
import * as Sender from "./KinPushSender.ts";

export const layer = Sender.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(Devices.layer, Presence.layer, Apns.layer)),
  Layer.provide(KinPersistence.layer),
);
