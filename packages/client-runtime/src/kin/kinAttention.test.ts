// @effect-diagnostics globalDate:off - Fixtures read days relative to a fixed local date.
import {
  KinAgentId,
  KinPersonId,
  KinRecordId,
  type KinGoal,
  type KinPulseFact,
  type KinPulseRead,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  kinAttention,
  kinAttentionCount,
  kinGoalView,
  kinNeedsYouBeside,
  kinPlainDates,
  kinTasksAttention,
  kinSnoozeDays,
} from "./kinAttention.ts";
import type { KinNeedsYouRow } from "./kinWorkHome.ts";

// Invented projects, clients and figures only.
const at = DateTime.makeUnsafe(Date.UTC(2026, 10, 15));
const fact = (
  sense: KinPulseFact["sense"],
  key: string,
  extra: Partial<KinPulseFact> = {},
): KinPulseFact => ({
  sense,
  family: sense === "invoice_overdue" ? "money" : "work",
  key: `${sense}:${key}`,
  subject: { kind: "record", key, title: `Invented ${key}`, recordId: KinRecordId.make(key) },
  scope: { projectKey: "P-1", projectTitle: "Atlas", clientKey: "C-1", clientTitle: "Lumen" },
  since: at,
  consequence: `${key} needs someone`,
  actor: { _tag: "agent", agentId: KinAgentId.make("cos") },
  sensitive: sense === "invoice_overdue",
  wake: "sweep",
  handled: null,
  ...extra,
});
const read = (facts: ReadonlyArray<KinPulseFact>): KinPulseRead => ({
  asOf: at,
  total: facts.length,
  facts,
});
const now = new Date(2026, 10, 15);
const names = new Map([["owner", "Arjun"]]);

describe("kinAttention", () => {
  it("shows a screen only its own facts, the late ones first, and keeps handled ones apart", () => {
    const facts = [
      fact("task_due_soon", "W-1"),
      fact("task_late", "W-2"),
      fact("task_stalled", "W-3", { scope: { projectKey: "P-2", projectTitle: "Other" } }),
      fact("invoice_overdue", "INV-1", {
        handled: {
          by: { _tag: "person", personId: KinPersonId.make("owner") },
          at,
          until: DateTime.makeUnsafe(Date.UTC(2026, 10, 18)),
          note: null,
        },
      }),
    ];
    const project = kinAttention(read(facts), {
      scope: { type: "project", key: "P-1" },
      names,
      now,
    });
    expect(project.open.map((row) => row.factKey)).toEqual(["task_late:W-2", "task_due_soon:W-1"]);
    expect(project.open[0]!.about).toBe("W-2");
    expect(project.handled.map((row) => row.handled)).toEqual([
      expect.stringMatching(/^Arjun has it until /),
    ]);
    // A client's page keeps its own matters; Tasks has its late and due tasks.
    const client = kinAttention(read([...facts, fact("client_cold", "C-1")]), {
      scope: { type: "client", key: "C-1" },
      names,
      now,
    });
    expect(client.open.map((row) => row.factKey)).toEqual(["client_cold:C-1"]);
    const money = kinAttention(read(facts), { scope: { type: "money" }, names, now });
    expect(money.open).toHaveLength(0);
    expect(money.handled).toHaveLength(1);
    expect(kinAttentionCount(read(facts))).toBe(3);
    const all = kinAttention(read([...facts.slice(0, 2), fact("invoice_overdue", "INV-2")]), {
      scope: { type: "all" },
      names,
      now,
    });
    const tasks = kinTasksAttention(all.open);
    expect(tasks.rows.map((row) => row.factKey)).toEqual(["task_late:W-2", "task_due_soon:W-1"]);
    expect(tasks.money).toBe(1);
  });

  it("leaves out of Needs you what an attention row already covers", () => {
    const attention = kinAttention(
      read([
        fact("task_late", "W-2"),
        fact("invoice_overdue", "INV-1"),
        fact("task_stalled", "W-7", {
          handled: {
            by: { _tag: "person", personId: KinPersonId.make("owner") },
            at,
            until: DateTime.makeUnsafe(Date.UTC(2026, 10, 18)),
            note: null,
          },
        }),
      ]),
      {
        scope: { type: "all" },
        names,
        now,
      },
    );
    const row = (id: string, open: KinNeedsYouRow["open"]): KinNeedsYouRow => ({
      id,
      kind: "task",
      title: id,
      detail: "",
      late: false,
      open,
    });
    const rest = kinNeedsYouBeside(
      [
        row("task:W-2", { type: "task", key: "W-2" }),
        row("task:W-5", { type: "task", key: "W-5" }),
        row("task:W-7", { type: "task", key: "W-7" }),
        row("money:overdue", { type: "money" }),
      ],
      attention,
    );
    expect(rest.map((one) => one.id)).toEqual(["task:W-5"]);
  });

  it("words the host's ISO days as a person reads them", () => {
    expect(kinPlainDates("₹1,85,000.00 owed, 44 days past due (2026-10-01).")).toBe(
      "₹1,85,000.00 owed, 44 days past due.",
    );
    expect(kinPlainDates("Was due 2026-11-12, 3 days ago.")).toBe("Was due Nov 12, 3 days ago.");
    expect(kinPlainDates("₹22,610.00 spent of a ₹5,000.00 limit in 2026-11.")).toBe(
      "₹22,610.00 spent of a ₹5,000.00 limit in November.",
    );
  });

  it("snoozes to tomorrow, the next Monday and a week on", () => {
    // 15 Nov 2026 is a Sunday: Monday is the next day, never the same day.
    expect(kinSnoozeDays(now).map((one) => one.until)).toEqual([
      "2026-11-16",
      "2026-11-16",
      "2026-11-22",
    ]);
    expect(kinSnoozeDays(new Date(2026, 10, 16))[1].until).toBe("2026-11-23");
  });

  it("draws a goal against its straight line", () => {
    const goal: KinGoal = {
      recordId: KinRecordId.make("G-1"),
      key: "G-1",
      title: "Q4 received",
      rev: 1,
      state: "open",
      measure: "revenue_received",
      currency: "INR",
      target: 40_00_000_00,
      current: 10_00_000_00,
      expected: 20_00_000_00,
      startsOn: "2026-10-01",
      dueOn: "2026-12-31",
      behind: true,
    };
    const view = kinGoalView(goal, now);
    expect(view).toMatchObject({ progress: 0.25, pace: 0.5, status: "behind" });
    expect(view.figure).toBe("₹10,00,000 of ₹40,00,000");
    expect(kinGoalView({ ...goal, current: goal.target }, now).status).toBe("reached");
  });
});
