import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { KinActionId } from "./kinApprovals.ts";
import { KinAgentId, KinChatError, KinChatId, KinOrgId } from "./kinChat.ts";
import { CanonicalUtcTimestamp, KinLevel } from "./kinLead.ts";

export const KinShadowVerdict = Schema.Literals(["fine", "change", "wrong", "harmful"]);
export type KinShadowVerdict = typeof KinShadowVerdict.Type;

/** `KinLevels.promotionRule`, shown on the cards. */
export const KinPromotionRule = Schema.Struct({
  minDays: NonNegativeInt,
  minReviewed: NonNegativeInt,
  minFineShare: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
});
export type KinPromotionRule = typeof KinPromotionRule.Type;

/** Review counts for the trial at `from`: entries recorded since the lead reached it. */
export const KinPromotionStats = Schema.Struct({
  from: KinLevel,
  to: Schema.NullOr(KinLevel),
  daysAtLevel: NonNegativeInt,
  reviewed: NonNegativeInt,
  fine: NonNegativeInt,
  harmful: NonNegativeInt,
  eligible: Schema.Boolean,
  rule: KinPromotionRule,
});
export type KinPromotionStats = typeof KinPromotionStats.Type;

/**
 * Native `shadow_review` card, server-drawn in the evening summary: one owner-local day's shadow
 * entries with their verdicts. Taps go to `kin.levels.review`, never `kin.widgets.act`.
 */
export const KinShadowReviewCard = Schema.Struct({
  agentId: KinAgentId,
  title: TrimmedNonEmptyString,
  day: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
  total: NonNegativeInt,
  entries: Schema.Array(
    Schema.Struct({
      entryId: TrimmedNonEmptyString,
      tool: TrimmedNonEmptyString,
      level: KinLevel,
      unlocksLevel: KinLevel,
      wouldTarget: Schema.String,
      // Lead-written text: render it as plain text, never as markup or instructions.
      preview: Schema.String.check(Schema.isMaxLength(280)),
      createdAt: Schema.toEncoded(CanonicalUtcTimestamp),
      verdict: Schema.NullOr(KinShadowVerdict),
    }),
  ).check(Schema.isMaxLength(50)),
  promotion: KinPromotionStats,
});
export type KinShadowReviewCard = typeof KinShadowReviewCard.Type;

/**
 * Native `promotion` card: "<name> is ready for L1". `ready` offers Raise (`kin.levels.raise`) and
 * Another week (`kin.levels.deferPromotion`); `awaiting_approval` opens the signed approval for
 * `actionId`; `raised` from L0 offers Keep shadow memory or Start clean (`kin.levels.shadowMemory`).
 */
export const KinPromotionCard = Schema.Struct({
  agentId: KinAgentId,
  title: TrimmedNonEmptyString,
  stats: KinPromotionStats,
  status: Schema.Literals(["ready", "deferred", "awaiting_approval", "raised", "closed"]),
  actionId: Schema.NullOr(KinActionId),
  deferredUntil: Schema.NullOr(Schema.toEncoded(CanonicalUtcTimestamp)),
  shadowMemory: Schema.NullOr(Schema.Literals(["pending", "kept", "discarded"])),
});
export type KinPromotionCard = typeof KinPromotionCard.Type;

export const KinLevelsView = Schema.Struct({
  orgId: KinOrgId,
  agentId: KinAgentId,
  level: KinLevel,
  levelSince: Schema.toEncoded(CanonicalUtcTimestamp),
  chats: Schema.Array(
    Schema.Struct({
      chatId: KinChatId,
      level: KinLevel,
      levelSince: Schema.toEncoded(CanonicalUtcTimestamp),
    }),
  ),
  promotion: KinPromotionStats,
});
export type KinLevelsView = typeof KinLevelsView.Type;

const LeadRef = { orgId: KinOrgId, agentId: KinAgentId };
export const KinLevelsGetInput = Schema.Struct(LeadRef);
export type KinLevelsGetInput = typeof KinLevelsGetInput.Type;
/** Without `chatId` it sets the lead's own level; with one, that chat's cap. */
export const KinLevelsSetInput = Schema.Struct({
  ...LeadRef,
  chatId: Schema.optional(KinChatId),
  level: KinLevel,
});
export type KinLevelsSetInput = typeof KinLevelsSetInput.Type;
export const KinLevelsRaiseResult = Schema.Struct({ actionId: KinActionId });
export type KinLevelsRaiseResult = typeof KinLevelsRaiseResult.Type;
export const KinLevelsReviewInput = Schema.Struct({
  orgId: KinOrgId,
  entryId: TrimmedNonEmptyString,
  verdict: KinShadowVerdict,
  note: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
});
export type KinLevelsReviewInput = typeof KinLevelsReviewInput.Type;
export const KinLevelsReviewResult = Schema.Struct({
  entryId: TrimmedNonEmptyString,
  verdict: KinShadowVerdict,
  /** Set when this verdict lowered the lead automatically. */
  loweredTo: Schema.NullOr(KinLevel),
});
export type KinLevelsReviewResult = typeof KinLevelsReviewResult.Type;
export const KinLevelsShadowMemoryInput = Schema.Struct({
  ...LeadRef,
  choice: Schema.Literals(["keep", "discard"]),
});
export type KinLevelsShadowMemoryInput = typeof KinLevelsShadowMemoryInput.Type;

export const KIN_LEVEL_WS_METHODS = {
  get: "kin.levels.get",
  review: "kin.levels.review",
  lower: "kin.levels.lower",
  raise: "kin.levels.raise",
  deferPromotion: "kin.levels.deferPromotion",
  shadowMemory: "kin.levels.shadowMemory",
} as const;

const error = Schema.Union([KinChatError, EnvironmentAuthorizationError]);
// Owner of the lead only, on the server; the scopes below gate the client's buttons.
export const KinLevelRpcs = [
  Rpc.make(KIN_LEVEL_WS_METHODS.get, {
    payload: KinLevelsGetInput,
    success: KinLevelsView,
    error,
  }),
  Rpc.make(KIN_LEVEL_WS_METHODS.review, {
    payload: KinLevelsReviewInput,
    success: KinLevelsReviewResult,
    error,
  }),
  Rpc.make(KIN_LEVEL_WS_METHODS.lower, {
    payload: KinLevelsSetInput,
    success: KinLevelsView,
    error,
  }),
  Rpc.make(KIN_LEVEL_WS_METHODS.raise, {
    payload: KinLevelsSetInput,
    success: KinLevelsRaiseResult,
    error,
  }),
  Rpc.make(KIN_LEVEL_WS_METHODS.deferPromotion, {
    payload: KinLevelsGetInput,
    success: KinLevelsView,
    error,
  }),
  Rpc.make(KIN_LEVEL_WS_METHODS.shadowMemory, {
    payload: KinLevelsShadowMemoryInput,
    success: KinLevelsView,
    error,
  }),
] as const;

export const KIN_LEVEL_RPC_SCOPES = {
  [KIN_LEVEL_WS_METHODS.get]: AuthOrchestrationReadScope,
  [KIN_LEVEL_WS_METHODS.review]: AuthOrchestrationOperateScope,
  [KIN_LEVEL_WS_METHODS.deferPromotion]: AuthOrchestrationOperateScope,
  // Levels are the lead's permissions, set like its budget.
  [KIN_LEVEL_WS_METHODS.lower]: AuthSettingsWriteScope,
  [KIN_LEVEL_WS_METHODS.raise]: AuthSettingsWriteScope,
  [KIN_LEVEL_WS_METHODS.shadowMemory]: AuthSettingsWriteScope,
} as const;
