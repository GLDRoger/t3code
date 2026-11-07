import { forkParked } from "../../serverActivation.ts";
import { KinOrgId } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as KinIdentity from "../chat/KinIdentity.ts";
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
    stage: Schema.Literals(["dependencies", "startup"]),
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
    Layer.mergeAll(
      KinLeadRegistry.layer,
      KinEventQueue.layer,
      Memory.layer,
      KinIdentity.KinIdentity.layer.pipe(
        Layer.provide(KinIdentity.KinIdentityConfig.layer),
        Layer.provide(KinChatRepository.layer),
      ),
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
      const prompt = yield* Effect.serviceOption(KinLeadPrompt);
      if (Option.isNone(prompt)) {
        yield* Effect.logWarning(
          "Kin runner disabled: LeadPrompt implementation is not installed",
          new KinLeadStartupError({ stage: "dependencies" }),
        );
        return Layer.empty;
      }
      return layer.pipe(
        Layer.provide(Layer.succeed(KinLeadPrompt, prompt.value)),
        Layer.provide(MemoryConfig.layer(repositories)),
      );
    }),
  ),
);
