import type { KinOrgId, KinPulseThresholdSource } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { type PlaybookKey, playbookThresholds } from "../work/playbooks.ts";

/** Pulse thresholds playbooks don't declare: their unit and code default. */
const PULSE_ONLY = {
  late_grace_hours: { unit: "hours", default: 0 },
  retainer_heads_up_days: { unit: "days", default: 5 },
} as const;
const PLAYBOOK_UNITS = {
  due_soon_hours: "hours",
  stalled_after_days: "days",
  waiting_too_long_days: "days",
  chase_invoice_after_days: "days",
  quote_follow_up_days: "days",
  renewal_heads_up_days: "days",
  renewal_draft_days: "days",
  review_waiting_hours: "hours",
  pr_open_too_long_hours: "hours",
  milestone_heads_up_days: "days",
  project_quiet_days: "days",
  meeting_follow_up_hours: "hours",
  deal_quiet_days: "days",
} as const satisfies Partial<Record<PlaybookKey, "hours" | "days">>;
export type ThresholdKey = keyof typeof PULSE_ONLY | keyof typeof PLAYBOOK_UNITS;

export interface Threshold {
  readonly value: number;
  readonly unit: "hours" | "days";
  readonly from: KinPulseThresholdSource;
}

/** A threshold for an org, and for one client where its playbook may set it; else the default. */
export const threshold = Effect.fn("KinPulse.threshold")(function* (
  orgId: KinOrgId,
  key: ThresholdKey,
  clientId?: string,
) {
  if (key === "late_grace_hours" || key === "retainer_heads_up_days") return pulseOnly(key);
  return (yield* thresholds(orgId))(key, clientId);
});

const pulseOnly = (key: keyof typeof PULSE_ONLY): Threshold => ({
  value: PULSE_ONLY[key].default,
  unit: PULSE_ONLY[key].unit,
  from: { _tag: "default" },
});

/** `threshold` for many keys and clients over one read of the playbooks. */
export const thresholds = Effect.fn("KinPulse.thresholds")(function* (orgId: KinOrgId) {
  const playbooks = yield* playbookThresholds(orgId);
  return (key: ThresholdKey, clientId?: string): Threshold => {
    if (key === "late_grace_hours" || key === "retainer_heads_up_days") return pulseOnly(key);
    const found = playbooks(key, clientId);
    return { value: found.value, unit: PLAYBOOK_UNITS[key], from: found.from };
  };
});

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
export const toMs = (t: Threshold) => t.value * (t.unit === "hours" ? HOUR_MS : DAY_MS);
