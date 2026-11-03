import { KIN_MAIN_THREAD_CHILD_CAP, KIN_PLAN_CAPS, type KinPlanCap } from "@t3tools/contracts";

const ACTIVE_CHILD = new Set(["pending", "running", "waiting"]);

export interface CapChild {
  readonly status: string;
  readonly driver: string;
}

export type CapDecision =
  | { readonly admit: true }
  | { readonly admit: false; readonly reason: string };

export function planCapFor(driver: string): KinPlanCap | undefined {
  return KIN_PLAN_CAPS.find((cap) => cap.driver === driver);
}

export function maxUsedPercent(
  windows: ReadonlyArray<{ readonly usedPercent: number }> | undefined,
): number | null {
  if (windows === undefined || windows.length === 0) return null;
  return Math.max(...windows.map((window) => window.usedPercent));
}

/**
 * Main-thread cap is 20 active children. A plan's own child cap and usage
 * stop apply on top of that.
 */
export function delegationCapDecision(input: {
  readonly children: readonly CapChild[];
  readonly targetDriver: string;
  readonly usedPercent: number | null;
}): CapDecision {
  const active = input.children.filter((child) => ACTIVE_CHILD.has(child.status));
  if (active.length >= KIN_MAIN_THREAD_CHILD_CAP) {
    return {
      admit: false,
      reason: `This main thread already has ${active.length} active children. The cap is ${KIN_MAIN_THREAD_CHILD_CAP}.`,
    };
  }
  const plan = planCapFor(input.targetDriver);
  if (plan === undefined) return { admit: true };
  const onPlan = active.filter((child) => child.driver === input.targetDriver).length;
  if (onPlan >= plan.maxChildren) {
    return {
      admit: false,
      reason: `${plan.plan} already has ${onPlan} active children. The cap is ${plan.maxChildren}.`,
    };
  }
  if (input.usedPercent !== null && input.usedPercent >= plan.maxUsedPercent) {
    return {
      admit: false,
      reason: `${plan.plan} is at ${input.usedPercent}% of its plan. New work stops at ${plan.maxUsedPercent}%.`,
    };
  }
  return { admit: true };
}
