import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { AuthKinChatScope, EnvironmentAuthorizationError } from "./auth.ts";
import { IsoDateTime, KinTrimmedText } from "./baseSchemas.ts";
import { KinChatError, KinOrgId } from "./kinChat.ts";

/**
 * Settings → Company → Recommendations: each change Kin suggested to the owner, with what came of
 * it. Every word is the server's; `rule` is a plain string so a later rule needs no change here.
 */
export const KinRecommendationsInput = Schema.Struct({ orgId: KinOrgId });
export type KinRecommendationsInput = typeof KinRecommendationsInput.Type;

/** The one button a row offers: undo a change still in effect, or let Kin suggest it again. */
export const KinRecommendationAction = Schema.Struct({
  kind: Schema.Literals(["undo", "ask_again"]),
  label: KinTrimmedText,
});
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
  undo: "kin.recommendations.undo",
  askAgain: "kin.recommendations.askAgain",
} as const;

const error = Schema.Union([KinChatError, EnvironmentAuthorizationError]);

/** Undo and Ask again answer with the list as it stands after them. */
export const KinRecommendationRpcs = [
  Rpc.make(KIN_RECOMMENDATION_WS_METHODS.list, {
    payload: KinRecommendationsInput,
    success: KinRecommendationsResult,
    error,
  }),
  Rpc.make(KIN_RECOMMENDATION_WS_METHODS.undo, {
    payload: KinRecommendationActInput,
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
  [KIN_RECOMMENDATION_WS_METHODS.undo]: AuthKinChatScope,
  [KIN_RECOMMENDATION_WS_METHODS.askAgain]: AuthKinChatScope,
} as const;
