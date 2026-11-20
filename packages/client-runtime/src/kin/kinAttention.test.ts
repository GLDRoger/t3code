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
  kinAsideOf,
  kinAttention,
  kinAttentionCount,
  kinGoalView,
  kinNeedsYouBeside,
  kinPlainDates,
  kinTasksAttention,
  kinTasksBadgeCount,
  kinTasksBlock,
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
const owed = (key: string) => fact("invoice_overdue", key);
const now = new Date(2026, 10, 15);
const names = new Map([["owner", "Arjun"]]);

describe("kinAttention", () => {
  it("shows a record set aside as one Handled row, by whom and on whose word, on its own page too", () => {
    const aside = {
      record: { key: "C-1" as never, title: "Lumen" },
      covers: "all" as const,
      until: DateTime.makeUnsafe(new Date(2026, 11, 17).getTime()),
      by: { _tag: "agent" as const, agentId: KinAgentId.make("fin") },
      onWordOf: KinPersonId.make("owner"),
      mine: false,
      at,
      note: null,
      liftable: true,
      byYou: false,
      yourWord: true,
    };
    const held = {
      ...fact("invoice_overdue", "INV-4"),
      aside,
      handled: {
        by: aside.by,
        at,
        until: aside.until,
        note: null,
      },
    };
    const facts = [held, { ...fact("task_late", "W-4"), aside, handled: held.handled }];
    const named = new Map([...names, ["fin", "Finance"]]);
    const all = kinAttention(
      { ...read(facts), setAside: [aside] },
      {
        scope: { type: "all" },
        names: named,
        now,
      },
    );
    expect(all.handled).toEqual([]);
    expect(all.asides.map((row) => [row.record, row.detail, row.liftable])).toEqual([
      ["C-1", "Set aside until Dec 17 · by Finance, on your word", true],
    ]);
    // Its tasks stay answered in Needs you rather than coming back as plain rows.
    expect(all.held.map((row) => row.record)).toEqual(["INV-4", "W-4"]);
    expect(
      kinAsideOf(
        {
          ...read(facts),
          setAside: [
            {
              ...aside,
              until: null,
              by: { _tag: "person" as const, personId: KinPersonId.make("owner") },
              onWordOf: null,
              byYou: true,
              yourWord: false,
            },
          ],
        },
        "C-1" as never,
        { names: named, now },
      )?.detail,
    ).toBe("Set aside until lifted · by you");
    // From an older host, which sends no list of holds, its facts are handled rows as before.
    expect(
      kinAttention(read(facts), { scope: { type: "all" }, names: named, now }).handled,
    ).toHaveLength(2);
  });

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
    // An issued invoice is named by its number; one without a number yet by its key.
    const numbered = kinAttention(
      read([
        fact("invoice_overdue", "INV-7", {
          subject: { kind: "record", key: "INV-7", title: "Retainer", number: "AM/26-27/004" },
        }),
        fact("invoice_overdue", "INV-8"),
      ]),
      { scope: { type: "money" }, names, now },
    );
    expect(numbered.open.map((row) => row.about)).toEqual([
      "AM/26-27/004 · Atlas · Lumen",
      "INV-8 · Atlas · Lumen",
    ]);
    // Asked about, the agent hears the number the person sees and the key its tools take.
    expect(numbered.open.map((row) => row.askDraft.split(":")[0])).toEqual([
      "About AM/26-27/004 (INV-7) Retainer",
      "About INV-8 Invented INV-8",
    ]);
    expect(project.handled.map((row) => row.handled)).toEqual([
      expect.stringMatching(/^Arjun has it until /),
    ]);
    // A client's page keeps its own matters and lists its late and due tasks, no other task facts.
    const client = kinAttention(
      read([...facts, fact("client_cold", "C-1"), fact("task_stalled", "W-4")]),
      { scope: { type: "client", key: "C-1" }, names, now },
    );
    expect(client.open.map((row) => row.factKey)).toEqual([
      "task_late:W-2",
      "task_due_soon:W-1",
      "client_cold:C-1",
    ]);
    expect(client.open[0]!.open).toEqual({ type: "record", key: "W-2" });
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
    // "See all N" counts what the Tasks badge counts: Money's row is as many things as it says.
    const twoOwed = read([...facts.slice(0, 2), ...["INV-2", "INV-3"].map(owed)]);
    const owing = kinTasksAttention(
      kinAttention(twoOwed, { scope: { type: "all" }, names, now }).open,
    );
    const block = kinTasksBlock({
      ownerLevel: true,
      onMe: new Set(),
      attention: owing.rows,
      needs: owing.moneyRow === null ? [] : [owing.moneyRow],
      hidden: owing.hidden,
      handled: 0,
      expanded: false,
    });
    expect(block?.total).toBe(
      kinTasksBadgeCount({ ownerLevel: true, attention: twoOwed, mineDue: null }),
    );
    // Three rows fit, so no "See all" that would open nothing new.
    expect(block?.more).toBe(false);
    // A task under "On me" leaves the block's rows, not its count, which stays the badge's.
    const onMe = kinTasksBlock({
      ownerLevel: true,
      onMe: new Set(["W-2"]),
      attention: owing.rows,
      needs: owing.moneyRow === null ? [] : [owing.moneyRow],
      hidden: owing.hidden,
      handled: 0,
      expanded: false,
    });
    expect(onMe?.attention.map((row) => row.factKey)).toEqual(["task_due_soon:W-1"]);
    expect(onMe?.total).toBe(
      kinTasksBadgeCount({ ownerLevel: true, attention: twoOwed, mineDue: null }),
    );
    expect(onMe?.onMe).toBe(1);
    // A project or client fact does not repeat its own name after its key.
    const own = kinAttention(
      read([
        fact("project_no_plan", "P-1", {
          subject: {
            kind: "record",
            key: "P-1",
            title: "Atlas",
            recordId: KinRecordId.make("P-1"),
          },
        }),
        fact("client_cold", "C-1", {
          subject: {
            kind: "record",
            key: "C-1",
            title: "Lumen",
            recordId: KinRecordId.make("C-1"),
          },
          scope: { clientKey: "C-1", clientTitle: "Lumen" },
        }),
      ]),
      { scope: { type: "all" }, names, now },
    );
    expect(own.open.map((row) => row.about).toSorted()).toEqual(["C-1", "P-1 · Lumen"]);
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
    // Whole units of the goal's own currency: yen have no minor unit, the dinar has three.
    expect(
      kinGoalView({ ...goal, currency: "JPY", target: 2_000_000, current: 345_678 }, now).figure,
    ).toBe("¥345,678 of ¥2,000,000");
    expect(
      kinGoalView({ ...goal, currency: "KWD", target: 2_000_000, current: 1_234_567 }, now).figure,
    ).toBe("KWD\u00a01,235 of KWD\u00a02,000");
  });
});
