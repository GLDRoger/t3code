import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { AuthKinChatScope, EnvironmentAuthorizationError } from "./auth.ts";
import { IsoDateTime, KinTrimmedText } from "./baseSchemas.ts";
import { KinAgentId, KinChatError, KinOrgId } from "./kinChat.ts";

/**
 * Settings → Company → Recommendations: each change Kin suggested to the owner, with what came of
 * it. Every word is the server's; `rule` is a plain string so a later rule needs no change here.
 */
export const KinRecommendationsInput = Schema.Struct({ orgId: KinOrgId });
export type KinRecommendationsInput = typeof KinRecommendationsInput.Type;

/**
 * The one button a row offers: let Kin suggest it again, or open the agent's page, where who can
 * message it is changed.
 */
export const KinRecommendationAction = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("ask_again"), label: KinTrimmedText }),
  Schema.Struct({ kind: Schema.Literal("open_agent"), label: KinTrimmedText, agentId: KinAgentId }),
]);
export type KinRecommendationAction = typeof KinRecommendationAction.Type;

export const KinRecommendationRow = Schema.Struct({
  recId: KinTrimmedText,
  rule: Schema.String,
  /** What Kin noticed, as the card said it. */
  noticed: Schema.String,
  /** What came of it, with its date. */
  outcome: Schema.String,
  postedAt: IsoDateTime,
  decidedAt: Schema.NullOr(IsoDateTime),
  action: Schema.NullOr(KinRecommendationAction),
});
export type KinRecommendationRow = typeof KinRecommendationRow.Type;

/** Newest first. */
export const KinRecommendationsResult = Schema.Struct({
  rows: Schema.Array(KinRecommendationRow),
});
export type KinRecommendationsResult = typeof KinRecommendationsResult.Type;

export const KinRecommendationActInput = Schema.Struct({
  orgId: KinOrgId,
  recId: KinTrimmedText.check(Schema.isMaxLength(200)),
});
export type KinRecommendationActInput = typeof KinRecommendationActInput.Type;

const KIN_RECOMMENDATION_WS_METHODS = {
  list: "kin.recommendations.list",
  askAgain: "kin.recommendations.askAgain",
} as const;

const error = Schema.Union([KinChatError, EnvironmentAuthorizationError]);

/** Ask again answers with the list as it stands after it. */
export const KinRecommendationRpcs = [
  Rpc.make(KIN_RECOMMENDATION_WS_METHODS.list, {
    payload: KinRecommendationsInput,
    success: KinRecommendationsResult,
    error,
  }),
  Rpc.make(KIN_RECOMMENDATION_WS_METHODS.askAgain, {
    payload: KinRecommendationActInput,
    success: KinRecommendationsResult,
    error,
  }),
] as const;

export const KIN_RECOMMENDATION_RPC_SCOPES = {
  [KIN_RECOMMENDATION_WS_METHODS.list]: AuthKinChatScope,
  [KIN_RECOMMENDATION_WS_METHODS.askAgain]: AuthKinChatScope,
} as const;
