import {
  DEFAULT_KIN_ROUTING_SETTINGS,
  type KinAgentProfile,
  type KinRoutingSettings,
  type KinSubscriptionPlan,
} from "@t3tools/contracts";

export interface KinLimitSnapshot {
  readonly provider: string;
  readonly instanceId?: string | undefined;
  readonly usedPercent: number | undefined;
}

export interface KinRouteRequest {
  readonly settings: KinRoutingSettings;
  readonly profile: Pick<KinAgentProfile, "role" | "provider" | "model" | "reasoningEffort">;
  readonly parentDriver: string | undefined;
  readonly parentModel: string | undefined;
  readonly activeTotal: number;
  readonly activeByProvider: Readonly<Record<string, number>>;
  readonly limits: ReadonlyArray<KinLimitSnapshot>;
  /** The caller already pinned a provider instance or model. */
  readonly explicitTarget: boolean;
  readonly stuck: boolean;
}

export type KinRouteDecision =
  | { readonly action: "inherit"; readonly reason: string }
  | {
      readonly action: "launch";
      readonly provider: string;
      readonly model: string | undefined;
      readonly planId: string;
      readonly promptAddendum?: string;
      readonly reason: string;
    }
  | { readonly action: "pause"; readonly reason: string };

const OTHER_MODEL: Readonly<Record<string, string>> = {
  claudeAgent: "codex",
  codex: "claudeAgent",
};

const FRESH_AUTHOR_ADDENDUM =
  "Fix the whole class of failure, not only the single case in front of you.";

const usedPercentFor = (
  plan: KinSubscriptionPlan,
  limits: ReadonlyArray<KinLimitSnapshot>,
): number | undefined => {
  const matches = limits.filter((limit) => limit.provider === plan.provider);
  if (plan.instanceId !== undefined) {
    return matches.find((limit) => limit.instanceId === plan.instanceId)?.usedPercent;
  }
  const known = matches
    .map((limit) => limit.usedPercent)
    .filter((value): value is number => value !== undefined);
  if (known.length === 0) return undefined;
  return Math.min(...known);
};

const nearLimit = (settings: KinRoutingSettings, used: number | undefined): boolean =>
  used !== undefined && used >= settings.nearLimitPercent;

const providerCap = (settings: KinRoutingSettings, provider: string, paused: ReadonlySet<string>) =>
  settings.plans
    .filter((plan) => plan.provider === provider && !paused.has(plan.id))
    .reduce((sum, plan) => sum + plan.concurrencyCap, 0);

const roleModel = (settings: KinRoutingSettings, role: string): string => {
  const models = settings.roleModels;
  if (role in models) return models[role as keyof typeof models];
  return "inherit";
};

const cheapProvider = "openrouter";

export function decideKinRoute(request: KinRouteRequest): KinRouteDecision {
  const { settings } = request;
  if (request.activeTotal >= settings.mainThreadConcurrency) {
    return {
      action: "pause",
      reason: `This main thread already has ${request.activeTotal} agents. The cap is ${settings.mainThreadConcurrency}.`,
    };
  }

  const paused = new Set(
    settings.plans
      .filter((plan) => nearLimit(settings, usedPercentFor(plan, request.limits)))
      .map((plan) => plan.id),
  );

  const section9 = settings.routingPolicyEnabled;
  const crossReview = section9 && settings.crossModelReview && request.profile.role === "reviewer";
  const escalate = section9 && settings.freshAuthorEscalation && request.stuck;
  const other = request.parentDriver === undefined ? undefined : OTHER_MODEL[request.parentDriver];

  if (request.explicitTarget && !crossReview && !escalate) {
    const pinned = settings.plans.find(
      (plan) =>
        plan.provider === request.parentDriver ||
        (request.profile.provider !== "inherit" && plan.provider === request.profile.provider),
    );
    if (pinned !== undefined && paused.has(pinned.id)) {
      return {
        action: "pause",
        reason: `${pinned.label} is at or above ${settings.nearLimitPercent}% of its limit. Kin paused this launch instead of starting a lane that would fail mid-run.`,
      };
    }
    return { action: "inherit", reason: "The caller pinned a provider and it still has headroom." };
  }

  let preferredProvider =
    request.profile.provider === "inherit" ? request.parentDriver : request.profile.provider;
  let addendum: string | undefined;
  if ((crossReview || escalate) && other !== undefined) {
    preferredProvider = other;
    if (escalate) addendum = FRESH_AUTHOR_ADDENDUM;
  }

  const mapped = roleModel(settings, request.profile.role);
  if (mapped === "cheap") preferredProvider = cheapProvider;

  const eligible = settings.plans.filter((plan) => {
    if (paused.has(plan.id)) return false;
    return (
      providerCap(settings, plan.provider, paused) > (request.activeByProvider[plan.provider] ?? 0)
    );
  });
  if (eligible.length === 0) {
    return {
      action: "pause",
      reason:
        "Every plan is near its usage limit or at its concurrency cap. Kin paused new launches.",
    };
  }

  const preferred = eligible.filter((plan) => plan.provider === preferredProvider);
  const pool = preferred.length > 0 ? preferred : eligible;
  const ranked = [...pool].sort((left, right) => {
    const leftUsed = usedPercentFor(left, request.limits) ?? -1;
    const rightUsed = usedPercentFor(right, request.limits) ?? -1;
    return leftUsed - rightUsed;
  });
  const chosen = ranked[0];
  if (chosen === undefined) {
    return { action: "pause", reason: "No plan has headroom." };
  }
  if (
    (request.activeByProvider[chosen.provider] ?? 0) >=
    providerCap(settings, chosen.provider, paused)
  ) {
    return {
      action: "pause",
      reason: `${chosen.label} is at its concurrency cap.`,
    };
  }

  const model = resolveModel(request, mapped);
  return {
    action: "launch",
    provider: chosen.provider,
    model,
    planId: chosen.id,
    ...(addendum === undefined ? {} : { promptAddendum: addendum }),
    reason: crossReview
      ? `Cross-model review is on, so this reviewer runs on ${chosen.label}.`
      : escalate
        ? `Fresh-author escalation is on, so this stuck lane moves to ${chosen.label}.`
        : `${chosen.label} has the most headroom.`,
  };
}

const resolveModel = (request: KinRouteRequest, mapped: string): string | undefined => {
  if (mapped === "cheap") return request.settings.cheapModel;
  if (mapped !== "inherit") return mapped;
  if (request.profile.model !== "inherit") return request.profile.model;
  return undefined;
};

export function planStatuses(input: {
  readonly settings: KinRoutingSettings;
  readonly limits: ReadonlyArray<KinLimitSnapshot>;
  readonly activeByProvider: Readonly<Record<string, number>>;
}): {
  readonly plans: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly provider: string;
    readonly monthlyUsd: number;
    readonly concurrencyCap: number;
    readonly usedPercent: number | null;
    readonly paused: boolean;
    readonly active: number;
  }>;
  readonly launchesPaused: boolean;
} {
  const plans = input.settings.plans.map((plan) => {
    const used = usedPercentFor(plan, input.limits);
    return {
      id: plan.id,
      label: plan.label,
      provider: plan.provider,
      monthlyUsd: plan.monthlyUsd,
      concurrencyCap: plan.concurrencyCap,
      usedPercent: used ?? null,
      paused: nearLimit(input.settings, used),
      active: input.activeByProvider[plan.provider] ?? 0,
    };
  });
  return {
    plans,
    launchesPaused: plans.length > 0 && plans.every((plan) => plan.paused),
  };
}

export function limitsFromProviders(
  providers: ReadonlyArray<{
    readonly driver: string;
    readonly instanceId: string;
    readonly usageLimits?:
      | { readonly windows: ReadonlyArray<{ readonly usedPercent: number }> }
      | undefined;
  }>,
): ReadonlyArray<KinLimitSnapshot> {
  return providers.flatMap((provider) => {
    const windows = provider.usageLimits?.windows ?? [];
    if (windows.length === 0) return [];
    const usedPercent = Math.max(...windows.map((window) => window.usedPercent));
    return [{ provider: provider.driver, instanceId: provider.instanceId, usedPercent }];
  });
}

export { DEFAULT_KIN_ROUTING_SETTINGS };
