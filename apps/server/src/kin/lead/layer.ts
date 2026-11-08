import { forkParked } from "../../serverActivation.ts";
import { KinOrgId, KinMessageId, KinChatId } from "@t3tools/contracts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as KinChatService from "../chat/KinChatService.ts";
import * as Routines from "../triggers/routines.ts";
import * as OwnerCheck from "../triggers/ownerCheck.ts";
import * as TriggerScheduler from "../triggers/KinTriggerScheduler.ts";
import * as TriggerStore from "../triggers/KinTriggerStore.ts";
import * as TriggerInbox from "../triggers/KinTriggerInbox.ts";
import * as Schema from "effect/Schema";

import * as KinChatRepository from "../chat/KinChatRepository.ts";
import * as Memory from "../memory/Memory.ts";
import * as MemoryConfig from "../memory/MemoryConfig.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
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

const recoveryHooks = Layer.effect(
  Memory.MemoryRecoveryHooks,
  Effect.gen(function* () {
    const chat = yield* KinChatService.KinChatService;
    const sql = yield* SqlClient.SqlClient;
    return Memory.MemoryRecoveryHooks.of({
      notify: Effect.fn("KinLead.notifyMemoryRecovery")((notice) =>
        Effect.gen(function* () {
          const [lead] = yield* sql<{
            owner_chat_id: string;
          }>`SELECT owner_chat_id FROM kin_leads WHERE org_id = ${notice.orgId} ORDER BY agent_id LIMIT 1`;
          if (lead !== undefined)
            yield* chat.notice({
              orgId: notice.orgId,
              chatId: KinChatId.make(lead.owner_chat_id),
              messageId: KinMessageId.make(
                `memory-recovery:${notice.orgId}:${notice.conflictBranch ?? notice.branch}:${notice.reason}`,
              ),
              body:
                notice.conflictBranch === undefined
                  ? "Kin memory was recovered. Review the recovery journal before resuming work."
                  : `Kin preserved conflicting memory on ${notice.conflictBranch}. Review it before resuming work.`,
            });
        }).pipe(
          Effect.catch((cause) =>
            Effect.logError("Kin memory recovery notification failed", {
              orgId: notice.orgId,
              cause,
            }),
          ),
        ),
      ),
    });
  }),
);
const routineRuntime = Routines.layer.pipe(
  Layer.provideMerge(TriggerScheduler.layer),
  Layer.provide(Layer.mergeAll(TriggerStore.layer, TriggerInbox.layer)),
  Layer.provide(Scheduler.layer),
);

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const runner = yield* WakeupRunner.WakeupRunner;
    yield* Effect.gen(function* () {
      const context = yield* Layer.build(routineRuntime);
      yield* runner.start.pipe(Effect.provideContext(context));
    }).pipe(forkParked);
  }),
).pipe(
  Layer.provide(WakeupRunner.layer),
  Layer.provide(OwnerCheck.layer),
  Layer.provide(
    Layer.mergeAll(KinLeadRegistry.layer, KinLeadPrompt.layer).pipe(
      Layer.provideMerge(Layer.mergeAll(Memory.layer, KinChatRepository.layer)),
    ),
  ),
  Layer.provide(recoveryHooks),
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
