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

/** What the review card shows of one entry's input: the whole action, up to this many chars. */
export const KIN_SHADOW_REVIEW_TEXT_MAX = 2_000;

// guestShare.ts NAME_BREAKING_CHARACTER, widened to every format character (zero-width, BOM).
/** What the server spells out as `[U+XXXX]` in card previews; newlines and tabs stay. */
export const KIN_HIDDEN_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

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
  /** Any unreviewed entry in the trial blocks eligibility. */
  unreviewed: NonNegativeInt,
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
  /** That day's unreviewed entries; `entries` lists them first, so none hide past the cap. */
  unreviewed: NonNegativeInt,
  entries: Schema.Array(
    Schema.Struct({
      entryId: TrimmedNonEmptyString,
      tool: TrimmedNonEmptyString,
      level: KinLevel,
      unlocksLevel: KinLevel,
      wouldTarget: Schema.String,
      /**
       * Lead-written text, hidden characters already spelled out. Clients render it and
       * `wouldTarget` as plain text: no markup, links, mentions or bidi isolation tricks.
       */
      preview: Schema.String.check(Schema.isMaxLength(KIN_SHADOW_REVIEW_TEXT_MAX)),
      /** The preview stops short of the stored input or leaves a field out; Fine is refused. */
      truncated: Schema.Boolean,
      createdAt: Schema.toEncoded(CanonicalUtcTimestamp),
      verdict: Schema.NullOr(KinShadowVerdict),
    }),
  ).check(Schema.isMaxLength(50)),
  promotion: KinPromotionStats,
});
export type KinShadowReviewCard = typeof KinShadowReviewCard.Type;

export const KIN_SHADOW_CHANGES_MAX = 200;

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
  /**
   * While `shadowMemory` is pending: the paths Keep would commit to the default branch, and
   * those the owner reviews in a PR, which make Keep unavailable. Null when not yet listed.
   */
  shadowChanges: Schema.NullOr(
    Schema.Struct({
      paths: Schema.Array(Schema.String).check(Schema.isMaxLength(KIN_SHADOW_CHANGES_MAX)),
      truncated: Schema.Boolean,
      ownerReviewed: Schema.Array(Schema.String).check(Schema.isMaxLength(KIN_SHADOW_CHANGES_MAX)),
    }),
  ),
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
  /** Open `set_level` requests for this lead, waiting on the owner's signature or the executor. */
  pendingRaises: Schema.Array(
    Schema.Struct({
      actionId: KinActionId,
      chatId: Schema.NullOr(KinChatId),
      level: KinLevel,
      state: Schema.Literals(["awaiting_approval", "approved", "executing"]),
    }),
  ),
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
