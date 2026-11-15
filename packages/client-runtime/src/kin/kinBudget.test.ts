import { KinOrgId, type KinBudget } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { kinDailyLimitChoices } from "./kinBudget.ts";

const budget = (leadUnits: number, workerUnits: number): KinBudget => ({
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
  });
});
