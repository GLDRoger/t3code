// @effect-diagnostics globalDate:off - Fixtures build ISO times relative to a fixed clock.
import {
  KinAgentId,
  KinChatId,
  KinOrgId,
  KinPersonId,
  KinRecordId,
  type KinOpenRead,
  type KinOpenRow,
  type KinPulseFact,
  type KinRecord,
  type KinWaitingItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { kinAttention, kinTasksAttention, kinTasksBlock } from "./kinAttention.ts";
import { kinOpenBadge, kinOpenNeeds, kinOpenWaiting } from "./kinOpenView.ts";
import type { KinWorkNames } from "./kinWork.ts";
import { kinNeedsYou } from "./kinWorkHome.ts";

// Ambermill, invented: Rhea owns it, Chief of staff is its agent.
const orgId = KinOrgId.make("ambermill");
const rhea = KinPersonId.make("rhea");
const names: KinWorkNames = {
  people: new Map([[rhea, "Rhea"]]),
  agents: new Map([["cos", "Chief of staff"]]),
  me: rhea,
  zone: "UTC",
};
const now = new Date("2026-11-18T08:00:00.000Z");
const asOf = DateTime.makeUnsafe(now.getTime());
const fact = (sense: KinPulseFact["sense"], key: string): KinPulseFact => ({
  sense,
  family: sense === "invoice_overdue" ? "money" : "work",
  key: `${sense}:${key}`,
  subject: { kind: "record", key, title: `Invented ${key}`, recordId: KinRecordId.make(key) },
  scope: { projectKey: "P-1", projectTitle: "Atlas" },
  since: asOf,
  consequence: `${key} needs someone`,
  actor: { _tag: "agent", agentId: KinAgentId.make("cos") },
  sensitive: false,
  wake: "sweep",
  handled: null,
});
const task = (key: string, dueAt: string, late: boolean): KinRecord => ({
  recordId: KinRecordId.make(`rec-${key}`),
  orgId,
  key,
  title: `Invented task ${key}`,
  state: "open",
  waitingOn: null,
  owner: { _tag: "person", personId: rhea },
  category: null,
  side: "ours",
  dueAt,
  dueAllDay: false,
  late,
  confirmed: true,
  sensitive: false,
  working: false,
  pullRequest: null,
  rev: 1,
  createdAt: "2026-11-10T08:00:00.000Z",
  updatedAt: "2026-11-10T08:00:00.000Z",
  closedAt: null,
});
const waiting: KinWaitingItem = {
  waitingId: "w-1" as KinWaitingItem["waitingId"],
  orgId,
  personId: rhea,
  chatId: KinChatId.make("chat-cos"),
  messageId: null,
  widgetId: null,
  reason: "question",
  createdAt: "2026-11-17T08:00:00.000Z",
  resolvedAt: null,
  resolution: null,
  question: "Send the Lumen invoice today?",
};
const facts = [
  fact("task_late", "W-2"),
  fact("task_due_soon", "W-3"),
  fact("invoice_overdue", "INV-1"),
];
const late = task("W-5", "2026-11-17T18:00:00.000Z", true);
const today = task("W-6", "2026-11-18T18:00:00.000Z", false);
const taskRow = (record: KinRecord): KinOpenRow => ({
  id: `task:${record.key}`,
  late: record.late,
  item: {
    _tag: "task",
    key: record.key,
    title: record.title,
    dueAt: DateTime.makeUnsafe(record.dueAt!),
  },
});
// In the host's order: facts, money facts, late tasks, the money row, waiting, today's tasks.
const rows: ReadonlyArray<KinOpenRow> = [
  ...facts.map((one) => ({
    id: `fact:${one.key}`,
    late: one.sense !== "task_due_soon",
    item: { _tag: "fact" as const, fact: one },
  })),
  taskRow(late),
  { id: "money:overdue", late: true, item: { _tag: "money", invoices: 2 } },
  { id: "waiting:w-1", late: false, item: { _tag: "waiting", waiting } },
  taskRow(today),
];
const open = (extra = 0): KinOpenRead => ({
  asOf,
  counts: { needsYou: rows.length + extra, waiting: 1 },
  rows,
});
const input = { names, chats: [], agentNames: names.agents, now };

describe("kinOpenNeeds", () => {
  it("draws fact, task and waiting rows as the old builders do, and counts what the host does", () => {
    const view = kinOpenNeeds(open(), input);
    const old = kinTasksAttention(
      kinAttention(
        { asOf, total: facts.length, facts },
        { scope: { type: "all" }, names: new Map([...names.agents, ...names.people]), now },
      ).open,
    );
    expect(view.attention).toEqual(old.rows);
    const before = kinNeedsYou({
      mine: [late, today],
      money: null,
      lists: [],
      waiting: [waiting],
      ...input,
    });
    expect(view.needs).toEqual([
      old.moneyRow,
      before[0],
      expect.objectContaining({ id: "money:overdue", kind: "money", late: true }),
      ...before.slice(1),
    ]);
    expect(kinOpenWaiting(open())).toEqual([waiting]);
    // The block's "See all N" is the badge's N, rows past the host's cap included.
    for (const extra of [0, 3]) {
      const read = open(extra);
      const cut = kinOpenNeeds(read, input);
      const block = kinTasksBlock({
        ownerLevel: true,
        onMe: new Set(["W-6"]),
        ...cut,
        handled: 0,
        expanded: false,
      });
      expect(block?.total).toBe(
        kinOpenBadge({ open: read, ownerLevel: true, attention: null, mineDue: null }),
      );
      expect(block?.onMe).toBe(1);
    }
  });

  it("keeps today's badge on a host without the open list", () => {
    const attention = { asOf, total: facts.length, facts };
    expect(kinOpenBadge({ open: null, ownerLevel: true, attention, mineDue: null })).toBe(3);
    expect(kinOpenBadge({ open: null, ownerLevel: false, attention, mineDue: [late] })).toBe(1);
    expect(kinOpenBadge({ open: open(), ownerLevel: false, attention, mineDue: [late] })).toBe(
      rows.length,
    );
  });
});
