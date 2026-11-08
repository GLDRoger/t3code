import * as Layer from "effect/Layer";

import { runKinMigrations } from "./KinMigrations.ts";

export const layer = Layer.effectDiscard(runKinMigrations());
