import { KinRecordId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { goalFigure, goalsNow } from "../../work/goals.ts";
import { playbookThreshold } from "../../work/playbooks.ts";
import { agentOrOwner, iso, type SenseContext, type SensedFact } from "./shared.ts";

/** goal_behind: an open goal more than the playbook's percent under its straight line. */
export const goalSenses = Effect.fn("KinPulse.goalSenses")(function* (ctx: SenseContext) {
  const { goals, behindPercent } = yield* goalsNow(ctx.orgId, ctx.at, { money: true });
  const from = (yield* playbookThreshold(ctx.orgId, "goal_behind_percent")).from;
  return goals
    .filter((goal) => goal.behind)
    .map(
      (goal): SensedFact => ({
        sense: "goal_behind",
        family: "goals",
        // A new target or date is a new episode.
        key: `goal_behind:${goal.key}:target=${goal.target}:due=${goal.dueOn ?? ""}`,
        subject: {
          kind: "record",
          key: goal.key,
          title: goal.title,
          recordId: KinRecordId.make(goal.recordId),
        },
        scope: {},
        since: iso(ctx.at),
        measure: {
          value: goal.expected === 0 ? 0 : Math.floor((goal.current / goal.expected) * 100),
          unit: "percent",
          threshold: 100 - behindPercent,
          from,
        },
        consequence: `${goalFigure(goal, goal.current, false)} of ${goalFigure(goal, goal.target)} by ${goal.dueOn}; ${goalFigure(goal, goal.expected)} would be on pace by now.`,
        actor: agentOrOwner(ctx.chief),
        sensitive: goal.currency !== undefined,
        wake: "brief",
      }),
    );
});
