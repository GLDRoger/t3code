/**
 * Brief slot for the prompt composer.
 *
 * Lane 1 owns the real PromptComposer (profiles, user MD, provider delivery).
 * It should call `KinPromptBriefProvider.briefFor` for the brief slot and keep
 * this prefix byte-identical across tasks. `KinPromptComposer` is the stub
 * until that lands: stable prefix, then the brief, then the task.
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as HouseLineService from "../houseLine/HouseLineService.ts";

export const KIN_PROMPT_STABLE_PREFIX = [
  "Kin base prompt.",
  "Read the brief, then the task.",
  "A crownable lane leaves a will of at most 2500 characters before exit.",
].join("\n");

export class KinPromptBriefProvider extends Context.Service<
  KinPromptBriefProvider,
  {
    readonly briefFor: (laneId: string) => Effect.Effect<string, HouseLineService.HouseLineError>;
  }
>()("t3/kin/prompt/KinPromptBrief/KinPromptBriefProvider") {}

export class KinPromptComposer extends Context.Service<
  KinPromptComposer,
  {
    readonly compose: (input: {
      readonly laneId: string;
      readonly task: string;
    }) => Effect.Effect<
      { readonly prefix: string; readonly brief: string; readonly prompt: string },
      HouseLineService.HouseLineError
    >;
  }
>()("t3/kin/prompt/KinPromptBrief/KinPromptComposer") {}

export const briefLayer = Layer.effect(
  KinPromptBriefProvider,
  Effect.gen(function* () {
    const houseLine = yield* HouseLineService.HouseLineService;
    return KinPromptBriefProvider.of({
      briefFor: (laneId) => houseLine.briefFor(laneId),
    });
  }),
);

export const layer = Layer.effect(
  KinPromptComposer,
  Effect.gen(function* () {
    const briefs = yield* KinPromptBriefProvider;
    return KinPromptComposer.of({
      compose: Effect.fn("KinPromptComposer.compose")(function* (input: {
        readonly laneId: string;
        readonly task: string;
      }) {
        const brief = yield* briefs.briefFor(input.laneId);
        const prefix = KIN_PROMPT_STABLE_PREFIX;
        return {
          prefix,
          brief,
          prompt: `${prefix}\n\n${brief}\n\n${input.task}`,
        };
      }),
    });
  }),
);
