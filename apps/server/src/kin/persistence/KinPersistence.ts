import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { runKinMigrations } from "./KinMigrations.ts";
import * as KinRetention from "./KinRetention.ts";

export const layer = Layer.effectDiscard(
  runKinMigrations().pipe(Effect.andThen(KinRetention.schedule)),
);
