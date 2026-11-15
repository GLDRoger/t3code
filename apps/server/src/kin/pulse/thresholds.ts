import type { KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

/** The closed registry of pulse thresholds: each key's unit, bounds and code default. */
const THRESHOLDS = {
  late_grace_hours: { unit: "hours", min: 0, max: 168, default: 0 },
  due_soon_hours: { unit: "hours", min: 1, max: 336, default: 24 },
  stalled_after_days: { unit: "days", min: 1, max: 60, default: 4 },
  waiting_too_long_days: { unit: "days", min: 1, max: 60, default: 5 },
  chase_invoice_after_days: { unit: "days", min: 1, max: 120, default: 10 },
  quote_follow_up_days: { unit: "days", min: 1, max: 60, default: 5 },
  retainer_heads_up_days: { unit: "days", min: 1, max: 60, default: 5 },
  renewal_heads_up_days: { unit: "days", min: 1, max: 180, default: 30 },
} as const;
export type ThresholdKey = keyof typeof THRESHOLDS;

export interface Threshold {
  readonly value: number;
  readonly unit: "hours" | "days";
  readonly from: "default";
}

/** A threshold's value for an org. Playbooks (slice 2) set values behind this; today, the default. */
export const threshold = (_orgId: KinOrgId, key: ThresholdKey) =>
  Effect.succeed({
    value: THRESHOLDS[key].default,
    unit: THRESHOLDS[key].unit,
    from: "default",
  } satisfies Threshold);

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
export const toMs = (t: Threshold) => t.value * (t.unit === "hours" ? HOUR_MS : DAY_MS);
