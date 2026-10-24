import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Wire types for Kin profiles, prompt preview, and routing settings.
 * The markdown files stay the source of truth; these are the validated forms.
 */
export const KinProfileRole = Schema.Literals([
  "main",
  "implementer",
  "reviewer",
  "researcher",
  "archivist",
  "custom",
]);
export type KinProfileRole = typeof KinProfileRole.Type;

export const KinProfileProvider = Schema.Literals(["codex", "claudeAgent", "pi", "inherit"]);
export type KinProfileProvider = typeof KinProfileProvider.Type;

export const KinProfileName = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  Schema.isPattern(/^(?!_adhoc$).+$/),
);
export type KinProfileName = typeof KinProfileName.Type;

export const KinProfileSource = Schema.Literals(["project", "user", "default", "adhoc"]);
export type KinProfileSource = typeof KinProfileSource.Type;

export const KinProfileTools = Schema.Record(Schema.String, Schema.Array(Schema.String));
export type KinProfileTools = typeof KinProfileTools.Type;

export const KinAgentProfile = Schema.Struct({
  name: KinProfileName,
  role: KinProfileRole,
  provider: KinProfileProvider,
  model: TrimmedNonEmptyString,
  reasoningEffort: TrimmedNonEmptyString,
  userMd: Schema.Array(Schema.String),
  tools: KinProfileTools,
  crownable: Schema.Boolean,
  seesWills: Schema.Boolean,
  body: Schema.String,
  source: KinProfileSource,
  path: Schema.optional(Schema.String),
});
export type KinAgentProfile = typeof KinAgentProfile.Type;

/** Inline profile on `delegate_task`. Saved under `.kin/agents/_adhoc/` for audit. */
export const KinInlineProfile = Schema.Struct({
  name: Schema.optional(KinProfileName),
  role: Schema.optional(KinProfileRole),
  provider: Schema.optional(KinProfileProvider),
  model: Schema.optional(TrimmedNonEmptyString),
  reasoningEffort: Schema.optional(TrimmedNonEmptyString),
  userMd: Schema.optional(Schema.Array(Schema.String)),
  tools: Schema.optional(KinProfileTools),
  crownable: Schema.optional(Schema.Boolean),
  seesWills: Schema.optional(Schema.Boolean),
  prompt: Schema.String.check(Schema.isMaxLength(100_000)),
});
export type KinInlineProfile = typeof KinInlineProfile.Type;

export const KinDelegateProfile = Schema.Union([KinProfileName, KinInlineProfile]).annotate({
  description:
    "Named profile from .kin/agents or ~/.kin/agents, or an inline profile. Inline profiles are saved under .kin/agents/_adhoc/ and the saved name is what the child runs.",
});
export type KinDelegateProfile = typeof KinDelegateProfile.Type;

export const KinProfileListResult = Schema.Struct({
  profiles: Schema.Array(KinAgentProfile),
});
export type KinProfileListResult = typeof KinProfileListResult.Type;

export const KinProjectInput = Schema.Struct({
  projectRoot: Schema.optional(Schema.String),
});
export type KinProjectInput = typeof KinProjectInput.Type;

export const KinProfileReadInput = Schema.Struct({
  projectRoot: Schema.optional(Schema.String),
  name: KinProfileName,
});
export type KinProfileReadInput = typeof KinProfileReadInput.Type;

export const KinProfileSourceResult = Schema.Struct({
  profile: KinAgentProfile,
  text: Schema.String,
});
export type KinProfileSourceResult = typeof KinProfileSourceResult.Type;

export const KinProfileWriteInput = Schema.Struct({
  projectRoot: Schema.optional(Schema.String),
  scope: Schema.Literals(["project", "user"]),
  text: Schema.String.check(Schema.isMaxLength(200_000)),
});
export type KinProfileWriteInput = typeof KinProfileWriteInput.Type;

export const KinTextDocument = Schema.Struct({
  text: Schema.String,
});
export type KinTextDocument = typeof KinTextDocument.Type;

export const KinBasePromptWriteInput = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(200_000)),
});
export type KinBasePromptWriteInput = typeof KinBasePromptWriteInput.Type;

export const KinMdScope = Schema.Literals(["project", "user"]);
export type KinMdScope = typeof KinMdScope.Type;

export const KinMdFile = Schema.Struct({
  scope: KinMdScope,
  name: TrimmedNonEmptyString,
  path: Schema.String,
});
export type KinMdFile = typeof KinMdFile.Type;

export const KinMdListResult = Schema.Struct({
  files: Schema.Array(KinMdFile),
});
export type KinMdListResult = typeof KinMdListResult.Type;

export const KinMdReadInput = Schema.Struct({
  projectRoot: Schema.optional(Schema.String),
  scope: KinMdScope,
  name: TrimmedNonEmptyString,
});
export type KinMdReadInput = typeof KinMdReadInput.Type;

export const KinMdWriteInput = Schema.Struct({
  projectRoot: Schema.optional(Schema.String),
  scope: KinMdScope,
  name: TrimmedNonEmptyString,
  text: Schema.String.check(Schema.isMaxLength(200_000)),
});
export type KinMdWriteInput = typeof KinMdWriteInput.Type;

export const KinPromptProviderKind = Schema.Literals([
  "codex",
  "claudeAgent",
  "pi",
  "grok",
  "openrouter",
  "other",
]);
export type KinPromptProviderKind = typeof KinPromptProviderKind.Type;

export const KinPromptPreviewInput = Schema.Struct({
  projectRoot: Schema.optional(Schema.String),
  profile: KinProfileName,
  provider: KinPromptProviderKind,
  houseId: Schema.optional(Schema.String),
  brief: Schema.optional(Schema.String),
});
export type KinPromptPreviewInput = typeof KinPromptPreviewInput.Type;

export const KinPromptPreview = Schema.Struct({
  prefix: Schema.String,
  text: Schema.String,
  /** What is appended after the provider's own runtime instructions. */
  suffix: Schema.String,
});
export type KinPromptPreview = typeof KinPromptPreview.Type;

export const KinSubscriptionPlan = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  provider: TrimmedNonEmptyString,
  monthlyUsd: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  concurrencyCap: NonNegativeInt,
  instanceId: Schema.optional(Schema.String),
});
export type KinSubscriptionPlan = typeof KinSubscriptionPlan.Type;

export const KinRoleModels = Schema.Struct({
  main: TrimmedNonEmptyString,
  implementer: TrimmedNonEmptyString,
  reviewer: TrimmedNonEmptyString,
  researcher: TrimmedNonEmptyString,
  archivist: TrimmedNonEmptyString,
  triage: TrimmedNonEmptyString,
  sweep: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
});
export type KinRoleModels = typeof KinRoleModels.Type;

export const KinRoutingSettings = Schema.Struct({
  mainThreadConcurrency: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
  nearLimitPercent: Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
  /** Section 9. Off leaves cross-model review and fresh-author escalation unused. */
  routingPolicyEnabled: Schema.Boolean,
  crossModelReview: Schema.Boolean,
  freshAuthorEscalation: Schema.Boolean,
  cheapModel: TrimmedNonEmptyString,
  plans: Schema.Array(KinSubscriptionPlan).check(Schema.isMinLength(1)),
  roleModels: KinRoleModels,
});
export type KinRoutingSettings = typeof KinRoutingSettings.Type;

export const DEFAULT_KIN_ROUTING_SETTINGS: KinRoutingSettings = {
  mainThreadConcurrency: 20,
  nearLimitPercent: 90,
  routingPolicyEnabled: false,
  crossModelReview: false,
  freshAuthorEscalation: false,
  cheapModel: "openai/gpt-4o-mini",
  plans: [
    {
      id: "claude-200-a",
      label: "Claude $200",
      provider: "claudeAgent",
      monthlyUsd: 200,
      concurrencyCap: 8,
    },
    {
      id: "claude-200-b",
      label: "Claude $200",
      provider: "claudeAgent",
      monthlyUsd: 200,
      concurrencyCap: 8,
    },
    {
      id: "codex-100",
      label: "Codex $100",
      provider: "codex",
      monthlyUsd: 100,
      concurrencyCap: 6,
    },
    {
      id: "grok-100",
      label: "Grok $100",
      provider: "grok",
      monthlyUsd: 100,
      concurrencyCap: 4,
    },
    {
      id: "openrouter",
      label: "OpenRouter",
      provider: "openrouter",
      monthlyUsd: 100,
      concurrencyCap: 8,
    },
  ],
  roleModels: {
    main: "inherit",
    implementer: "inherit",
    reviewer: "inherit",
    researcher: "inherit",
    archivist: "cheap",
    triage: "cheap",
    sweep: "cheap",
    summary: "cheap",
  },
};

export const KinPlanStatus = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  provider: Schema.String,
  monthlyUsd: Schema.Number,
  concurrencyCap: NonNegativeInt,
  usedPercent: Schema.NullOr(Schema.Number),
  paused: Schema.Boolean,
  active: NonNegativeInt,
});
export type KinPlanStatus = typeof KinPlanStatus.Type;

export const KinLaneUsage = Schema.Struct({
  id: Schema.String,
  threadId: Schema.optional(Schema.String),
  parentThreadId: Schema.optional(Schema.String),
  profile: Schema.String,
  planId: Schema.String,
  provider: Schema.String,
  model: Schema.NullOr(Schema.String),
  inputTokens: NonNegativeInt,
  cachedInputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  cacheHitRate: Schema.NullOr(Schema.Number),
  at: Schema.String,
});
export type KinLaneUsage = typeof KinLaneUsage.Type;

export const KinProviderUsage = Schema.Struct({
  provider: Schema.String,
  inputTokens: NonNegativeInt,
  cachedInputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  cacheHitRate: Schema.NullOr(Schema.Number),
});
export type KinProviderUsage = typeof KinProviderUsage.Type;

export const KinRoutingSnapshot = Schema.Struct({
  settings: KinRoutingSettings,
  plans: Schema.Array(KinPlanStatus),
  lanes: Schema.Array(KinLaneUsage),
  planUsage: Schema.Array(KinProviderUsage),
  launchesPaused: Schema.Boolean,
});
export type KinRoutingSnapshot = typeof KinRoutingSnapshot.Type;

export const KinRoutingGetInput = Schema.Struct({
  timeZone: Schema.optional(TrimmedNonEmptyString),
});
export type KinRoutingGetInput = typeof KinRoutingGetInput.Type;

export class KinError extends Schema.TaggedError<KinError>()("KinError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}
