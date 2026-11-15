import type { KinBudget, KinBudgetLimits } from "@t3tools/contracts";

// The host's old defaults; it has no limit until the owner picks one. Choices scale both.
const USUAL = { leadUnits: 2_000_000, workerUnits: 6_000_000 };
const CHOICES = [
  { times: 0.5, label: "Half the usual" },
  { times: 1, label: "The usual" },
  { times: 2, label: "Twice the usual" },
  { times: 5, label: "Five times the usual" },
] as const;

export const KIN_DAILY_LIMIT = {
  title: "Daily limit",
  detail:
    "How much work your agents do each day. Once they reach it, only your urgent messages run until midnight.",
  custom: "Set elsewhere",
  failed: "Couldn't change the daily limit. Try again.",
};

export interface KinDailyLimitChoice {
  readonly value: string;
  readonly label: string;
  readonly limits: KinBudgetLimits;
}

/** The limits on offer, with the host's current one first named if it is none of them. */
export function kinDailyLimitChoices(budget: KinBudget | null): {
  readonly choices: ReadonlyArray<KinDailyLimitChoice>;
  readonly current: string | null;
} {
  const choices: Array<KinDailyLimitChoice> = CHOICES.map(({ times, label }) => ({
    value: String(times),
    label,
    limits: {
      leadUnits: Math.round(USUAL.leadUnits * times),
      workerUnits: Math.round(USUAL.workerUnits * times),
    },
  }));
  if (budget === null) return { choices, current: null };
  const match = choices.find((choice) => choice.limits.leadUnits === budget.limits.leadUnits);
  if (match !== undefined) return { choices, current: match.value };
  const custom = { value: "custom", label: KIN_DAILY_LIMIT.custom, limits: budget.limits };
  return { choices: [custom, ...choices], current: custom.value };
}
