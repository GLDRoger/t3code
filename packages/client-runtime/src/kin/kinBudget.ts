import type { KinBudget, KinBudgetLimits } from "@t3tools/contracts";

// What a host that doesn't send its own usual limit means by it; choices scale both.
const FALLBACK_USUAL = { leadUnits: 2_000_000, workerUnits: 6_000_000 };
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
  none: "No limit",
  custom: "Set elsewhere",
  failed: "Couldn't change the daily limit. Try again.",
  waiting: "Waiting until tomorrow",
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
    ...CHOICES.map(({ times, label }) => ({
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

const share = (units: number, of: number) => {
  const percent = Math.round((units / of) * 100);
  return units > 0 && percent === 0 ? "under 1%" : `${percent}%`;
};

/**
 * Today's use in the owner's words: theirs beside their teammates', as a share of the limit, or of
 * a usual day when there is none. Null when the host doesn't say whose turns used what.
 */
export function kinDailyLimitUse(budget: KinBudget | null): string | null {
  if (budget === null || budget.ownerUnits === undefined) return null;
  const limit = budget.limits.leadUnits;
  const of = limit === null || limit === 0 ? (budget.usual ?? FALLBACK_USUAL).leadUnits : limit;
  const unit = limit === null || limit === 0 ? "of a usual day" : "of the limit";
  const teammates = budget.teammateUnits ?? 0;
  return teammates === 0
    ? `Today: you ${share(budget.ownerUnits, of)} ${unit}.`
    : `Today: you ${share(budget.ownerUnits, of)}, teammates ${share(teammates, of)} ${unit}.`;
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
