// @effect-diagnostics globalDate:off - Fixtures build ISO times relative to a fixed clock.
import {
  KinChatId,
  KinListId,
  KinMessageId,
  KinOrgId,
  KinPersonId,
  KinRecordId,
  type KinListDefinition,
  type KinMoneySummary,
  type KinRecord,
  type KinWaitingItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { KIN_WORK_DEFAULT_FILTER, type KinWorkNames } from "./kinWork.ts";
import {
  kinPlaceLists,
  kinNeedsYou,
  kinWorkFilterLabel,
  kinWorkPlaceParam,
} from "./kinWorkHome.ts";

// Invented people, clients and figures only.
const orgId = KinOrgId.make("invented-org");
const me = { _tag: "person", personId: KinPersonId.make("invented-owner") } as const;
const names: KinWorkNames = {
  people: new Map([[me.personId, "Invented Owner"]]),
  agents: new Map(),
  me: me.personId,
  zone: "UTC",
};
const now = new Date("2026-11-15T08:00:00.000Z");
const task = (key: string, patch: Partial<KinRecord> = {}): KinRecord => ({
  recordId: KinRecordId.make(`rec-${key}`),
  orgId,
  key,
  title: `Invented task ${key}`,
  state: "open",
  waitingOn: null,
  owner: me,
  category: null,
  side: "ours",
  dueAt: "2026-11-15T18:00:00.000Z",
  dueAllDay: false,
  late: false,
  confirmed: true,
  sensitive: false,
  working: false,
  pullRequest: null,
  rev: 1,
  createdAt: "2026-11-10T08:00:00.000Z",
  updatedAt: "2026-11-10T08:00:00.000Z",
  closedAt: null,
  ...patch,
});
const list = (id: string, patch: Partial<KinListDefinition> = {}): KinListDefinition => ({
  list: KinListId.make(id),
  name: id as KinListDefinition["name"],
  prefix: "X",
  builtIn: false,
  states: ["open", "waiting", "done", "dropped"],
  stateLabels: {},
  defaultState: "open",
  categories: [],
  fields: [],
  sensitive: true,
  amount: true,
  currency: "INR",
  archivedAt: null,
  rev: 0,
  open: 0,
  ...patch,
});
const inr = (minor: number) => [{ minor, currency: "INR" }];
const money: KinMoneySummary = {
  asOf: now.toISOString(),
  timeZone: "UTC",
  thisMonth: "2026-11",
  lastMonth: "2026-10",
  financialYear: "FY2026-27",
  owed: {
    total: inr(6_000_000),
    overdue: inr(6_000_000),
    invoices: 1,
    overdueInvoices: 1,
    byClient: [
      {
        party: { recordId: KinRecordId.make("rec-c"), key: "C-1", title: "Acme Foods" as never },
        owed: inr(6_000_000),
        overdue: inr(6_000_000),
        invoices: 1,
        oldestOverdueDays: 45,
      },
    ],
  },
  received: { thisMonth: [], lastMonth: [] },
  receivedThisFinancialYear: [],
  spent: { thisMonth: { total: [], byCategory: [] }, lastMonth: { total: [], byCategory: [] } },
  spentThisFinancialYear: [],
  upcoming: [],
  upcomingTotal: 0,
  series: [],
};
const waiting = (
  id: string,
  createdAt: string,
  messageId: KinWaitingItem["messageId"] = null,
): KinWaitingItem => ({
  waitingId: id as KinWaitingItem["waitingId"],
  orgId,
  personId: me.personId,
  chatId: KinChatId.make("chat-cos"),
  messageId,
  widgetId: null,
  reason: "question",
  createdAt,
  resolvedAt: null,
  resolution: null,
});
describe("Needs you", () => {
  const input = {
    mine: [task("W-2"), task("W-1", { late: true, dueAt: "2026-11-12T18:00:00.000Z" })],
    lists: [list("invoices", { builtIn: true })],
    waiting: [
      waiting("w-new", "2026-11-14T08:00:00.000Z"),
      waiting("w-old", "2026-11-13T08:00:00.000Z", KinMessageId.make("msg-post-card")),
    ],
    chats: [],
    agentNames: new Map(),
    names,
    now,
  };
  it("puts late work first, then what is owed past due, then the oldest wait, then today", () => {
    expect(kinNeedsYou({ ...input, money }).map((row) => row.id)).toEqual([
      "task:W-1",
      "money:overdue",
      "waiting:w-old",
      "waiting:w-new",
      "task:W-2",
    ]);
    // Two waits in one chat: each opens the chat on its own card, not on the newest.
    expect(
      kinNeedsYou({ ...input, money })
        .filter((row) => row.kind === "waiting")
        .map((row) => row.open),
    ).toEqual([
      { type: "chat", chatId: "chat-cos", messageId: "msg-post-card" },
      { type: "chat", chatId: "chat-cos", messageId: null },
    ]);
  });
  it("shows a viewer kept from money nothing about money", () => {
    expect(kinNeedsYou({ ...input, money: null }).some((row) => row.kind === "money")).toBe(false);
  });
});

describe("the places", () => {
  it("opens old Work links where their things now live", () => {
    expect(kinWorkPlaceParam("projects")).toEqual({ place: "clients", projects: true });
    expect(kinWorkPlaceParam("money")).toEqual({ place: "money", projects: false });
    expect(kinWorkPlaceParam("lists")).toEqual({ place: "docs", projects: false });
    expect(kinWorkPlaceParam(undefined)).toEqual({ place: "tasks", projects: false });
  });
  it("puts beside the docs only the lists Money doesn't already show", () => {
    const leads = list("leads", { archivedAt: "2026-11-01T00:00:00.000Z" });
    expect(
      kinPlaceLists([
        list("invoices"),
        list("expenses"),
        list("subscriptions"),
        list("work", { builtIn: true }),
        leads,
      ]),
    ).toEqual([list("work", { builtIn: true }), leads]);
  });
});

describe("Tasks' one filter", () => {
  it("says nothing on open tasks and names everything else in one chip", () => {
    expect(kinWorkFilterLabel(KIN_WORK_DEFAULT_FILTER, names)).toBeNull();
    expect(
      kinWorkFilterLabel(
        {
          ...KIN_WORK_DEFAULT_FILTER,
          view: "late",
          party: { key: "C-1" as never, title: "Acme Foods" },
          owner: me,
        },
        names,
      ),
    ).toBe("Late · Acme Foods · You");
  });
});
