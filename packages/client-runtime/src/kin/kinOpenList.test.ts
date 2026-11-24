import {
  KinOrgId,
  KinPersonId,
  KinRecordId,
  KinRecordKey,
  type KinOpenRead,
  type KinOpenRow,
  type KinPulseFact,
  type KinWaitingItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { kinAttention, kinTasksAttention, kinTasksBlock } from "./kinAttention.ts";
import { type KinInboxState, selectKinInboxView } from "./kinInboxModel.ts";
import {
  kinInboxWithOpen,
  kinOpenAttention,
  kinOpenNeeds,
  kinOpenShown,
  kinOpenTasksCount,
} from "./kinOpenList.ts";
import { kinWaitingBannerView } from "./kinScreenState.ts";
import type { KinWorkNames } from "./kinWork.ts";

// Ambermill, invented: Rhea owns it; Zoya is a teammate.
const orgId = KinOrgId.make("ambermill");
const rhea = KinPersonId.make("rhea");
const zoya = KinPersonId.make("zoya");
const asOf = DateTime.makeUnsafe(Date.UTC(2026, 10, 24, 9));
const now = new Date(Date.UTC(2026, 10, 24, 9));
const names: KinWorkNames = {
  people: new Map([
    [rhea, "Rhea"],
    [zoya, "Zoya Sheikh"],
  ]),
  agents: new Map([["chief", "Chief of staff"]]),
  me: rhea,
  owner: rhea,
  zone: "UTC",
};

const fact = (sense: KinPulseFact["sense"], key: string, family = "work"): KinPulseFact =>
  ({
    sense,
    family,
    key: `${sense}:${key}`,
    subject: { kind: "record", key, title: `Invented ${key}`, recordId: KinRecordId.make(key) },
    scope: {},
    since: asOf,
    consequence: `${key} needs someone`,
    actor: { _tag: "owner" },
    sensitive: false,
    wake: "sweep",
    handled: null,
  }) as KinPulseFact;

const card = (id: string, minute: number, extra: Partial<KinWaitingItem> = {}): KinWaitingItem =>
  ({
    waitingId: id,
    orgId,
    personId: rhea,
    chatId: "chat-chief",
    messageId: null,
    widgetId: `g-${id}`,
    reason: "decision",
    createdAt: `2026-11-24T08:${String(minute).padStart(2, "0")}:00.000Z`,
    resolvedAt: null,
    resolution: null,
    ...extra,
  }) as KinWaitingItem;

const factRow = (one: KinPulseFact, late = false): KinOpenRow => ({
  id: `fact:${one.key}`,
  late,
  item: { _tag: "fact", fact: one },
});
const taskRow = (key: string, late: boolean, dueAt?: number): KinOpenRow => ({
  id: `task:${key}`,
  late,
  item: {
    _tag: "task",
    key: KinRecordKey.make(key),
    title: `Invented ${key}`,
    ...(dueAt === undefined ? {} : { dueAt: DateTime.makeUnsafe(dueAt) }),
  },
});
const waitingRow = (item: KinWaitingItem): KinOpenRow => ({
  id: `waiting:${item.waitingId}`,
  late: false,
  item: { _tag: "waiting", waiting: item },
});

const confirm = card("wait-confirm", 1, { reason: "approval" });
const question = card("wait-question", 2, { reason: "question", question: "Send it Monday?" });
const draft = card("wait-draft", 3, { card: "draft" });
const hers = card("wait-hers", 4, { personId: zoya, waitsFor: { personId: zoya, name: "Zoya" } });
const urgent = fact("task_late", "W-1");
const deal = fact("deal_quiet", "D-1");
const owedFact = fact("invoice_overdue", "INV-1", "money");

/** As the host sends it: urgent facts, money facts, late tasks, waiting, due tasks, others'. */
const list: KinOpenRead = {
  asOf,
  counts: { needsYou: 9, waiting: 3, tasks: 4 },
  rows: [
    factRow(urgent, true),
    factRow(deal),
    factRow(owedFact, true),
    taskRow("W-2", true, Date.UTC(2026, 10, 22, 17)),
    waitingRow(confirm),
    waitingRow(question),
    waitingRow(draft),
    taskRow("W-3", false, Date.UTC(2026, 10, 24, 17)),
    taskRow("W-4", false),
    waitingRow(hers),
  ],
};

/** An inbox from the chats stream: a card settled elsewhere is still in it, the list's isn't. */
const inbox: KinInboxState = {
  chats: [],
  waiting: [confirm, card("wait-settled", 0, { reason: "approval" }), question],
};

describe("one list behind every Needs you", () => {
  it("gives each surface its filter, and the counts agree with each other", () => {
    // Waiting on you, its banner and the chats it marks: the list's own cards, oldest first.
    const view = selectKinInboxView(kinInboxWithOpen(inbox, orgId, list));
    expect(view.waiting.map((item) => item.waitingId)).toEqual([
      "wait-confirm",
      "wait-question",
      "wait-draft",
    ]);
    expect(view.waitingCount).toBe(list.counts.waiting);
    expect(kinWaitingBannerView(view.waiting, view.waitsFor)?.count).toBe(list.counts.waiting);
    expect(view.waitsFor.map((group) => [group.name, group.items.length])).toEqual([["Zoya", 1]]);

    // Needs attention: every row the list counts, in its order, money leading as one row.
    const listed = kinOpenNeeds(list, { owed: null, chats: [], agentNames: new Map(), names, now });
    const open = kinAttention(listed.facts, { scope: { type: "all" }, names: new Map(), now });
    const split = kinTasksAttention(open.open);
    const needs = [...(split.moneyRow === null ? [] : [split.moneyRow]), ...listed.needs];
    expect(split.rows.map((row) => row.id)).toEqual([urgent.key, deal.key]);
    expect(needs.map((row) => row.id)).toEqual([
      "attention:money",
      "task:W-2",
      "waiting:wait-confirm",
      "waiting:wait-question",
      "waiting:wait-draft",
      "task:W-3",
      "task:W-4",
    ]);
    const block = kinTasksBlock({
      ownerLevel: true,
      onMe: new Set(),
      attention: split.rows,
      needs,
      hidden: listed.hidden,
      handled: 0,
      expanded: false,
    });
    expect(block?.total).toBe(list.counts.needsYou);
    // What waits on the viewer is never cut from the first rows.
    expect(block?.needs.filter((row) => row.kind === "waiting")).toHaveLength(3);
    expect(needs.find((row) => row.id === "task:W-2")?.detail).toMatch(/^W-2 · Late · Due /);
    expect(needs.find((row) => row.id === "task:W-4")?.detail).toBe("W-4");

    // The Tasks badge and heading: Tasks' tasks, the late one its fact stands for included, and
    // the deal fact; never the cards or the invoice.
    expect(kinOpenTasksCount(list, { ownerLevel: true, me: rhea })).toBe(5);

    // Money's own section: only its money, from the same rows.
    const money = kinAttention(kinOpenAttention({ asOf, total: 0, facts: [] }, list), {
      scope: { type: "money" },
      names: new Map(),
      now,
    });
    expect(money.open.map((row) => row.id)).toEqual([owedFact.key]);

    // Each counted row is in exactly one of the parts.
    const facts = list.rows.filter((row) => row.item._tag === "fact").length;
    const tasks = list.rows.filter((row) => row.item._tag === "task").length;
    expect(facts + tasks + view.waitingCount).toBe(list.counts.needsYou);
  });

  it("an answer leaves every place at once, and an older host's surfaces stay their own", () => {
    const shown = kinOpenShown(list, new Set([urgent.key]));
    expect(shown.counts.needsYou).toBe(list.counts.needsYou - 1);
    expect(shown.rows.some((row) => row.id === `fact:${urgent.key}`)).toBe(false);
    const listed = kinOpenNeeds(shown, {
      owed: null,
      chats: [],
      agentNames: new Map(),
      names,
      now,
    });
    expect(listed.hidden).toBe(0);
    expect(kinOpenShown(list, new Set())).toBe(list);
    // No list from the host: Waiting on you is the inbox's, as before.
    expect(kinInboxWithOpen(inbox, orgId, undefined)).toBe(inbox);
    expect(kinInboxWithOpen(inbox, orgId, null)).toBe(inbox);
    expect(
      kinOpenTasksCount(
        { ...list, counts: { needsYou: 9, waiting: 3 } },
        {
          ownerLevel: true,
          me: rhea,
        },
      ),
    ).toBeNull();
  });

  it("counts what the host counted past the rows it sent, and says so", () => {
    const capped = { ...list, counts: { ...list.counts, needsYou: 250 } };
    const listed = kinOpenNeeds(capped, {
      owed: null,
      chats: [],
      agentNames: new Map(),
      names,
      now,
    });
    expect(listed.hidden).toBe(250 - 9);
  });
});
