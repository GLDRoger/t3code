import type { KinOrgId, KinChatId, KinMessageId, KinRole, KinAgentRole } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export interface JudgeInput {
  readonly orgId: KinOrgId;
  readonly chatId: KinChatId;
  readonly messageId: KinMessageId;
  readonly text: string;
  readonly authorRole: KinRole;
  readonly recent: ReadonlyArray<{
    readonly authorKind: "human" | "agent";
    readonly role: string;
    readonly text: string;
  }>;
  readonly agentRoles: ReadonlyArray<KinAgentRole>;
}
export interface Scored<A> {
  readonly value: A;
  readonly confidence: number;
}
export interface JudgeVerdict {
  readonly needsResponse: Scored<boolean>;
  readonly role: Scored<KinAgentRole | null>;
  readonly urgency: Scored<"low" | "normal" | "high">;
  readonly needsHumanDecision: Scored<boolean>;
  readonly commitment: Scored<{
    readonly kind: "none" | "defer" | "promise";
    readonly text: string | null;
  }>;
}
export class JudgeError extends Schema.TaggedError<JudgeError>()("JudgeError", {}) {}
export class Judge extends Context.Service<
  Judge,
  {
    readonly name: string;
    readonly judge: (input: JudgeInput) => Effect.Effect<JudgeVerdict, JudgeError>;
  }
>()("t3/kin/floor/Judge") {}
export const JUDGE_MODE = "shadow";
export const JUDGE_THRESHOLDS = { act: 0.8, ask: 0.5 } as const;
