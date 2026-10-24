import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * Slot the lineage lane fills in. `stableContext` is part of the cache prefix
 * and must be byte-stable for a house (no timestamps or counters). `brief` is
 * appended last and may differ per task.
 */
export interface KinBriefInput {
  readonly houseId: string | undefined;
  readonly profileName: string;
  readonly projectRoot: string | undefined;
  readonly task: string | undefined;
  readonly threadId: string | undefined;
}

export class KinBriefProvider extends Context.Service<
  KinBriefProvider,
  {
    readonly stableContext: (input: KinBriefInput) => Effect.Effect<string>;
    readonly brief: (input: KinBriefInput) => Effect.Effect<string>;
  }
>()("t3/kin/brief/KinBriefProvider") {}

export const layerEmptyBrief = Layer.succeed(KinBriefProvider, {
  stableContext: () => Effect.succeed(""),
  brief: () => Effect.succeed(""),
});
