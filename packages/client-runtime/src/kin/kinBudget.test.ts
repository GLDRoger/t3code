import { KinAgentId, KinOrgId, type KinBudget } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  kinDailyLimitAsks,
  kinDailyLimitChoices,
  kinDailyLimitUsed,
  kinDailyLimitWaiting,
} from "./kinBudget.ts";

const budget = (leadUnits: number | null, workerUnits: number | null): KinBudget => ({
  orgId: KinOrgId.make("invented-org"),
  day: "2026-11-15",
  leadUnits: 0,
  workerUnits: 0,
  limits: { leadUnits, workerUnits },
});

describe("the daily limit", () => {
  it("names the host's limit among the choices, and keeps one set elsewhere choosable", () => {
    expect(kinDailyLimitChoices(budget(4_000_000, 12_000_000)).current).toBe("2");
    const custom = kinDailyLimitChoices(budget(3_000_000, 1_000_000));
    expect(custom.current).toBe("custom");
    expect(custom.choices[0]?.limits).toEqual({ leadUnits: 3_000_000, workerUnits: 1_000_000 });
    expect(custom.choices.find((choice) => choice.value === "0.5")?.limits).toEqual({
      leadUnits: 1_000_000,
      workerUnits: 3_000_000,
    });
    // A host that sends its own usual scales the choices from it.
    const scaled = {
      ...budget(1_000_000, 4_000_000),
      usual: { leadUnits: 500_000, workerUnits: 2_000_000 },
    };
    expect(kinDailyLimitChoices(scaled).current).toBe("2");
    // Each choice names its amount, so "the usual" is never left unexplained.
    expect(kinDailyLimitChoices(scaled).choices.map((choice) => choice.label)).toEqual([
      "No limit",
      "Half the usual (250k units a day)",
      "The usual (500k units a day)",
      "Twice the usual (1M units a day)",
      "Five times the usual (2.5M units a day)",
    ]);
  });

  it("says what today used against each limit, or in units where there is none", () => {
    expect(
      kinDailyLimitUsed({ ...budget(2_000_000, null), leadUnits: 500_000, workerUnits: 1_250_000 }),
    ).toBe("agents 25% of the limit, tasks they started 1.3M units");
    expect(
      kinDailyLimitUsed({ ...budget(null, null), leadUnits: 2_500_000, workerUnits: 40_000 }),
    ).toBe("agents 2.5M units, tasks they started 40k units");
    expect(kinDailyLimitUsed(null)).toBeNull();
  });

  it("names no limit, the default, and keeps a teammate's own share through a pick", () => {
    expect(kinDailyLimitChoices(budget(null, null)).current).toBe("none");
    const shared = {
      ...budget(null, null),
      limits: { leadUnits: null, workerUnits: null, teammateUnits: 5 },
    };
    expect(
      kinDailyLimitChoices(shared).choices.find((choice) => choice.value === "1")?.limits,
    ).toEqual({
      leadUnits: 2_000_000,
      workerUnits: 6_000_000,
      teammateUnits: 5,
    });
    // No limit is none for anyone, so it never pauses anyone's work, and it alone is asked first.
    const { choices, current } = kinDailyLimitChoices(shared);
    expect(current).toBe("custom");
    expect(choices.find(kinDailyLimitAsks)?.limits).toEqual({
      leadUnits: null,
      workerUnits: null,
      teammateUnits: null,
    });
    expect(choices.filter(kinDailyLimitAsks).map((choice) => choice.value)).toEqual(["none"]);
  });

  it("says what waits for tomorrow", () => {
    const waiting: KinBudget = {
      ...budget(1, 1),
      waiting: {
        until: null,
        agents: [
          { agentId: KinAgentId.make("a1"), name: "Finance", requests: 2, tasks: 1, other: 0 },
          { agentId: KinAgentId.make("a2"), name: "Idle", requests: 0, tasks: 0, other: 0 },
        ],
      },
    };
    expect(kinDailyLimitWaiting(waiting)).toEqual([
      { agentId: KinAgentId.make("a1"), name: "Finance", line: "2 messages, 1 task" },
    ]);
  });
});
