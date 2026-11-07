import { forkParked } from "../../serverActivation.ts";
import { KinOrgId } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as KinChatRepository from "../chat/KinChatRepository.ts";
import * as Memory from "../memory/Memory.ts";
import * as MemoryConfig from "../memory/MemoryConfig.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as KinEventQueue from "./KinEventQueue.ts";
import * as KinLeadRegistry from "./KinLeadRegistry.ts";
import { KinLeadPrompt } from "./LeadPrompt.ts";
import * as WakeupRunner from "./WakeupRunner.ts";

export class KinLeadStartupError extends Schema.TaggedError<KinLeadStartupError>()(
  "KinLeadStartupError",
  {
    stage: Schema.Literal("startup"),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export function containStartup<A, E, R>(layer: Layer.Layer<A, E, R>) {
  return Layer.effectDiscard(Effect.void).pipe(
    Layer.provide(layer),
    Layer.catchCause((cause) =>
      Layer.effectDiscard(
        Effect.logError(
          "Kin startup failed; Kin disabled",
          new KinLeadStartupError({ stage: "startup", cause }),
        ),
      ),
    ),
  );
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const runner = yield* WakeupRunner.WakeupRunner;
    yield* runner.start.pipe(forkParked);
  }),
).pipe(
  Layer.provide(WakeupRunner.layer),
  Layer.provide(
    Layer.mergeAll(KinLeadRegistry.layer, KinEventQueue.layer, KinLeadPrompt.layer).pipe(
      Layer.provideMerge(Layer.mergeAll(Memory.layer, KinChatRepository.layer)),
    ),
  ),
  Layer.provide(KinPersistence.layer),
);

const Repositories = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ orgId: KinOrgId, repoUrl: Schema.String })),
);
export const layerServer = containStartup(
  Layer.unwrap(
    Effect.gen(function* () {
      const repositories = yield* Config.schema(Repositories, "KIN_MEMORY_REPOSITORIES").pipe(
        Config.withDefault([]),
      );
      if (repositories.length === 0) return Layer.empty;
      return layer.pipe(Layer.provide(MemoryConfig.layer(repositories)));
    }),
  ),
);
