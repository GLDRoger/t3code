import { KIN_DAILY_LIMIT_STEPS, type KinBudget, type KinBudgetLimits } from "@t3tools/contracts";

// What a host that doesn't send its own usual limit means by it; choices scale both.
const FALLBACK_USUAL = { leadUnits: 2_000_000, workerUnits: 6_000_000 };

export const KIN_DAILY_LIMIT = {
  title: "Daily limit",
  detail:
    "How much work your agents do each day. Once they reach it, only your urgent messages run until midnight.",
  none: "No limit",
  custom: "Set elsewhere",
  failed: "Couldn't change the daily limit.",
  waiting: "Waiting until tomorrow",
  used: "Used today",
};

export interface KinDailyLimitChoice {
  readonly value: string;
  readonly label: string;
  readonly limits: KinBudgetLimits;
}

const NO_LIMIT = "none";

/** The limits on offer, with the host's current one first named if it is none of them. */
export function kinDailyLimitChoices(budget: KinBudget | null): {
  readonly choices: ReadonlyArray<KinDailyLimitChoice>;
  readonly current: string | null;
} {
  // A teammate's own share is set apart from these choices, so picking one keeps it.
  const teammateUnits = budget?.limits.teammateUnits;
  const usual = budget?.usual ?? FALLBACK_USUAL;
  const kept = teammateUnits === undefined ? {} : { teammateUnits };
  const choices: Array<KinDailyLimitChoice> = [
    {
      value: NO_LIMIT,
      label: KIN_DAILY_LIMIT.none,
      limits: { leadUnits: null, workerUnits: null, ...kept },
    },
    ...KIN_DAILY_LIMIT_STEPS.map(({ times, label }) => ({
      value: String(times),
      label,
      limits: {
        leadUnits: Math.round(usual.leadUnits * times),
        workerUnits: Math.round(usual.workerUnits * times),
        ...kept,
      },
    })),
  ];
  if (budget === null) return { choices, current: null };
  const { leadUnits, workerUnits } = budget.limits;
  const match = choices.find(
    (choice) =>
      choice.limits.leadUnits === leadUnits &&
      (leadUnits !== null || choice.limits.workerUnits === workerUnits),
  );
  if (match !== undefined) return { choices, current: match.value };
  const custom = { value: "custom", label: KIN_DAILY_LIMIT.custom, limits: budget.limits };
  return { choices: [custom, ...choices], current: custom.value };
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Work held for the limit, one line per agent: "Finance: 2 messages, 1 task". */
export function kinDailyLimitWaiting(budget: KinBudget | null): ReadonlyArray<{
  readonly agentId: string;
  readonly name: string;
  readonly line: string;
}> {
  return (budget?.waiting?.agents ?? []).flatMap((agent) => {
    const parts = [
      agent.requests === 0 ? null : count(agent.requests, "message", "messages"),
      agent.tasks === 0 ? null : count(agent.tasks, "task", "tasks"),
      agent.other === 0 ? null : count(agent.other, "other job", "other jobs"),
    ].filter((part) => part !== null);
    return parts.length === 0
      ? []
      : [{ agentId: agent.agentId, name: agent.name, line: parts.join(", ") }];
  });
}

const units = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000
      ? `${Math.round(n / 1_000)}k`
      : `${Math.round(n)}`;
const share = (used: number, limit: number | null) =>
  limit === null
    ? `${units(used)} units`
    : `${Math.round((used / Math.max(limit, 1)) * 100)}% of the limit`;

/** Today's spend against each limit: "agents 40% of the limit, tasks they started 1.2M units". */
export function kinDailyLimitUsed(budget: KinBudget | null): string | null {
  if (budget === null) return null;
  return `agents ${share(budget.leadUnits, budget.limits.leadUnits)}, tasks they started ${share(
    budget.workerUnits,
    budget.limits.workerUnits,
  )}`;
}
