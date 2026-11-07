import { KinAgentId, KinEvent, KinOrgId, KinWakeupId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class KinLeadPromptError extends Schema.TaggedError<KinLeadPromptError>()(
  "KinLeadPromptError",
  {
    orgId: KinOrgId,
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
export interface KinLeadPromptInput {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly wakeupId: KinWakeupId;
  readonly events: ReadonlyArray<KinEvent>;
  readonly memoryHead: string;
}
export class KinLeadPrompt extends Context.Service<
  KinLeadPrompt,
  {
    readonly build: (input: KinLeadPromptInput) => Effect.Effect<string, KinLeadPromptError>;
  }
>()(
  // @effect-diagnostics-next-line deterministicKeys:off -- LEAD-6 shares this exact dependency key.
  "t3/kin/lead/LeadPrompt",
) {}
