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
import * as Writer from "../memory/MemoryWriter.ts";
import * as Scan from "../memory/secretScan.ts";
import * as LeadMemory from "./LeadMemory.ts";
import * as Cache from "../memory/MemoryCache.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import { KinLeadToolkit } from "./mcp/tools.ts";
import { handlers } from "./mcp/handlers.ts";
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

const runner = Layer.effectDiscard(
  Effect.gen(function* () {
    const runner = yield* WakeupRunner.WakeupRunner;
    yield* runner.start.pipe(forkParked);
  }),
).pipe(Layer.provide(WakeupRunner.layer));

const withServices = <A, E, R>(entry: Layer.Layer<A, E, R>) =>
  entry.pipe(
    Layer.provide(
      Layer.mergeAll(KinLeadRegistry.layer, KinLeadPrompt.layer).pipe(
        Layer.provideMerge(Layer.mergeAll(Memory.layer, KinChatRepository.layer)),
      ),
    ),
    Layer.provide(
      Layer.succeed(Memory.MemoryRecoveryHooks, {
        notify: Effect.fn("KinMemoryRecovery.notify")((notice) =>
          Effect.logWarning("Kin memory recovery requires operator attention", notice),
        ),
      }),
    ),
    Layer.provide(KinPersistence.layer),
  );

const registration = McpHttpServer.toolkitRegistration(KinLeadToolkit, handlers);
const toolkit = LeadMemory.layer.pipe(
  Layer.provideMerge(Writer.layer),
  Layer.provide(LeadMemory.authority),
  Layer.provide(Cache.layer),
  Layer.provide(Scan.noFindingsStubLayer),
  Layer.provide(
    Layer.succeed(Writer.MemoryWriterHooks, {
      notify: Effect.fn("KinMemoryWriter.notify")((notice) =>
        Effect.logWarning("Kin memory writer refused commit", {
          orgId: notice.orgId,
          wakeupId: notice.wakeupId,
          errorTag: notice.error._tag,
        }),
      ),
    }),
  ),
);

export const layer = withServices(runner);
const production = withServices(
  Layer.merge(runner, registration).pipe(Layer.provideMerge(toolkit)),
);

const Repositories = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ orgId: KinOrgId, repoUrl: Schema.String })),
);
const configured = <A, E, R>(entry: Layer.Layer<A, E, R>) =>
  containStartup(
    Layer.unwrap(
      Effect.gen(function* () {
        const repositories = yield* Config.schema(Repositories, "KIN_MEMORY_REPOSITORIES").pipe(
          Config.withDefault([]),
        );
        if (repositories.length === 0) return Layer.empty;
        return entry.pipe(Layer.provide(MemoryConfig.layer(repositories)));
      }),
    ),
  );

export const layerServer = configured(layer);
export const layerMcp = configured(production);
