/**
 * Will-before-exit. Run finalization yields this reference after the checkpoint.
 * The default is a no-op so existing finalization tests stay quiet. Production
 * provides `layer`, which asks once and then marks the lane `will_missing`.
 */

import { CommandId, MessageId, type RunId, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as HouseLineService from "./HouseLineService.ts";

export const KIN_WILL_FOLLOW_UP =
  "This lane has not left a will. Crown with lineage_crown, then write one with lineage_will. A will is at most 2500 characters.";

export class HouseLineWillGate extends Context.Reference<{
  readonly afterRun: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
  }) => Effect.Effect<void>;
}>("t3/kin/HouseLineWillGate", {
  defaultValue: () => ({ afterRun: () => Effect.void }),
}) {}

export const layer = Layer.effect(
  HouseLineWillGate,
  Effect.gen(function* () {
    const houseLine = yield* HouseLineService.HouseLineService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const crypto = yield* Crypto.Crypto;
    return {
      afterRun: (input) =>
        houseLine.finishLane(input.threadId).pipe(
          Effect.flatMap((result) =>
            result.prompt
              ? crypto.randomUUIDv4().pipe(
                  Effect.orDie,
                  Effect.flatMap((id) =>
                    orchestrator.dispatch({
                      type: "message.dispatch",
                      createdBy: "system",
                      creationSource: "server",
                      commandId: CommandId.make(`kin-will-gate:${id}`),
                      threadId: input.threadId,
                      messageId: MessageId.make(`kin-will-gate:${id}`),
                      text: KIN_WILL_FOLLOW_UP,
                      attachments: [],
                      dispatchMode: { type: "queue_after_active" },
                    }),
                  ),
                  Effect.asVoid,
                )
              : Effect.void,
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("Kin will gate could not finish the lane", {
              threadId: input.threadId,
              cause,
            }),
          ),
        ),
    };
  }),
);
