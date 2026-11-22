import type {
  KinChatId,
  KinChatSummary,
  KinListDefinition,
  KinMessageId,
  KinMoneySummary,
  KinRecord,
  KinRecordKey,
  KinWaitingItem,
} from "@t3tools/contracts";

import { kinTotalsText } from "./kinLists.ts";
import { kinInMoney, kinMoneyAgent, kinMoneyView, type KinListOpen } from "./kinMoney.ts";
import { kinSubscriptionsList } from "./kinSubscriptions.ts";
import { kinWaitingRowView } from "./kinScreenState.ts";
import { KIN_SCOPE_ALL, type KinViewerScope } from "./kinViewerScope.ts";
import {
  kinWorkName,
  kinWorkRow,
  kinWorkSamePrincipal,
  type KinWorkFilter,
  type KinWorkNames,
} from "./kinWork.ts";
import { kinCount } from "./kinCount.ts";

/** The places of Work, each a tab of the Kin home: its list first, then a record. */
export type KinWorkPlace = "tasks" | "money" | "clients" | "docs";

export const KIN_WORK_HOME = {
  seeAll: (count: number) => `See all ${count}`,
  /** Beside the Tasks block's count, the things it counts that the list below draws instead. */
  onMeBelow: (count: number) =>
    count === 1 ? "1 is on your list below" : `${count} are on your list below`,
  seeFewer: "Show fewer",
  search: "Search Work",
  add: "Add",
  addReceipt: "Receipt",
  addExpense: "Expense",
  elsewhere: "Clients, projects and docs",
  places: {
    tasks: "Tasks",
    money: "Money",
    clients: "Clients",
    docs: "Docs",
  } satisfies Record<KinWorkPlace, string>,
  filter: "Filter",
  show: "Show",
  byClient: "Client",
  byProject: "Project",
  owner: "Who has it",
  everyone: "Everyone",
  allClients: "All clients",
  allProjects: "All projects",
  clearFilter: "Clear filter",
  noClient: "No client",
};

/**
 * The pane with no chat open, in the words Tasks uses for this viewer: what needs attention for
 * the owner and a co-owner, what is on them for anyone else.
 */
export const kinNeedsPane = (ownerLevel: boolean) =>
  ownerLevel
    ? { title: "Needs attention", empty: "Nothing needs attention right now." }
    : { title: "On me", empty: "Nothing on you needs action today." };

/** Rows the pane shows before "See all", so the first tasks stay on the first screen. */
export const KIN_NEEDS_YOU_SHOWN = 4;

/** A `show` in a Work link: the place it opens, Tasks for a link from before places. */
export function kinWorkPlaceParam(show: string | undefined): {
  readonly place: KinWorkPlace;
  readonly projects: boolean;
} {
  if (show === "projects") return { place: "clients", projects: true };
  // A list is a structured doc, so Lists became part of Docs.
  if (show === "lists") return { place: "docs", projects: false };
  return show === "money" || show === "clients" || show === "docs"
    ? { place: show, projects: false }
    : { place: "tasks", projects: false };
}

export function kinMoneyLine(
  money: KinMoneySummary,
  scope: KinViewerScope = KIN_SCOPE_ALL,
): string {
  if (money.owed.total.length === 0)
    return scope.all ? "Nobody owes you anything" : "Nothing owed is shared with you";
  return [
    `${kinTotalsText(money.owed.total)} owed`,
    money.owed.overdue.length === 0 ? null : `${kinTotalsText(money.owed.overdue)} overdue`,
  ]
    .filter((part) => part !== null)
    .join(", ");
}

export const kinClientsLine = (clients: number, projects: number): string =>
  clients === 0 && projects === 0
    ? "No clients yet"
    : `${kinCount(clients, "client")}, ${kinCount(projects, "project")}`;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Where "changed this week" starts, moved on the hour so the count is read again hourly, not each minute. */
export const kinDocsWeekStart = (nowMs: number): string =>
  // @effect-diagnostics-next-line globalDate:off
  new Date(Math.floor((nowMs - WEEK_MS) / HOUR_MS) * HOUR_MS).toISOString();

/** `total` counts every doc; `changed`, those changed since `kinDocsWeekStart`. */
export function kinDocsLine(total: number, changed: number): string {
  if (total === 0) return "No docs yet";
  return changed === 0
    ? kinCount(total, "doc")
    : `${kinCount(total, "doc")}, ${changed} changed this week`;
}

/** The lists Docs shows beside the docs: the ones people made that Money doesn't already show. */
export const kinPlaceLists = (lists: ReadonlyArray<KinListDefinition>) => {
  const subscriptions = kinSubscriptionsList(lists);
  return lists.filter((def) => !kinInMoney(def) && def !== subscriptions);
};

// What needs you

export type KinNeedsYouOpen =
  | { readonly type: "task"; readonly key: KinRecordKey }
  | { readonly type: "list"; readonly open: KinListOpen }
  | { readonly type: "money" }
  | {
      readonly type: "chat";
      readonly chatId: KinChatId;
      /** The card's message, for the chat to open on; null for a row with none. */
      readonly messageId: KinMessageId | null;
    };

export interface KinNeedsYouRow {
  readonly id: string;
  readonly kind: "task" | "money" | "waiting";
  readonly title: string;
  readonly detail: string;
  readonly late: boolean;
  readonly open: KinNeedsYouOpen;
  /** How many things the row stands for, when it gathers several (Money's "2 things"). */
  readonly count?: number;
}

/**
 * Most urgent first: your late tasks, what clients owe past due, what an agent is waiting on you
 * for (oldest first), then your tasks due today. Each row opens the thing itself.
 */
export function kinNeedsYou(input: {
  /** Your open tasks due by the end of today, late ones included. */
  readonly mine: ReadonlyArray<KinRecord>;
  /** Null where this viewer may not see money. */
  readonly money: KinMoneySummary | null;
  readonly lists: ReadonlyArray<KinListDefinition>;
  readonly waiting: ReadonlyArray<KinWaitingItem>;
  readonly chats: ReadonlyArray<KinChatSummary>;
  readonly agentNames: ReadonlyMap<string, string>;
  readonly names: KinWorkNames;
  readonly now: Date;
}): ReadonlyArray<KinNeedsYouRow> {
  const task = (record: KinRecord): KinNeedsYouRow => {
    const row = kinWorkRow(record, input.names, input.now);
    return {
      id: `task:${record.key}`,
      kind: "task",
      title: record.title,
      detail: [record.key, row.about, row.late ? "Late" : null, row.due]
        .filter((part) => part !== null)
        .join(" · "),
      late: row.late,
      open: { type: "task", key: record.key },
    };
  };
  const late = input.mine.filter((record) => record.late).map(task);
  const today = input.mine.filter((record) => !record.late).map(task);
  const overdue = input.money === null ? null : kinMoneyView(input.money, input.lists).overdue;
  // Every overdue invoice is one row, which opens them all; Money splits them by client.
  const owed: ReadonlyArray<KinNeedsYouRow> =
    overdue === null || !overdue.late
      ? []
      : [
          {
            id: "money:overdue",
            kind: "money",
            title: `${overdue.note ?? "Invoices"} overdue`,
            detail: overdue.lines.join(" and "),
            late: true,
            open: overdue.open === null ? { type: "money" } : { type: "list", open: overdue.open },
          },
        ];
  const waiting = [...input.waiting]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((item): KinNeedsYouRow => {
      const row = kinWaitingRowView(item, input.chats, input.agentNames);
      return {
        id: `waiting:${item.waitingId}`,
        kind: "waiting",
        title: `${row.label} · ${row.chatTitle}`,
        detail: row.text ?? `Open the chat with ${row.chatTitle}`,
        late: false,
        open: { type: "chat", chatId: item.chatId, messageId: item.messageId },
      };
    });
  return [...late, ...owed, ...waiting, ...today];
}

// Tasks' one filter

/** What a narrowed task list is narrowed to, as one chip; null on the default, open tasks. */
export function kinWorkFilterLabel(filter: KinWorkFilter, names: KinWorkNames): string | null {
  const parts = [
    filter.view === "open" ? null : VIEW_LABELS[filter.view],
    filter.party?.title ?? null,
    filter.project?.title ?? null,
    filter.owner === null ? null : kinWorkName(filter.owner, names),
  ].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}

const VIEW_LABELS: Record<KinWorkFilter["view"], string> = {
  open: "Open",
  doing: "In progress",
  waiting: "Waiting",
  late: "Late",
  week: "Due this week",
  closed: "Closed",
};

export const kinWorkFilterCleared = (filter: KinWorkFilter): KinWorkFilter => ({
  ...filter,
  view: "open",
  owner: null,
  party: null,
  project: null,
});

export const kinWorkOwnerSelected = (filter: KinWorkFilter, owner: KinWorkFilter["owner"]) =>
  owner === null ? filter.owner === null : kinWorkSamePrincipal(filter.owner, owner);

// Handing over to an agent

/** The agent each place hands over to: money to whoever keeps the books, else the front door. */
export function kinWorkAgent<
  Lead extends { readonly name: string; readonly domain: string; readonly retired?: unknown },
>(leads: ReadonlyArray<Lead>, place: KinWorkPlace | null): Lead | null {
  if (place === "money") return kinMoneyAgent(leads);
  const live = leads.filter((lead) => lead.retired === undefined);
  return live.find((lead) => /chief/i.test(`${lead.name} ${lead.domain}`)) ?? live[0] ?? null;
}

/** What the chat opens holding, so the agent knows where the person was. */
export function kinWorkAskDraft(place: KinWorkPlace | null, narrowed?: string | null): string {
  if (place === null) return "";
  const about = {
    tasks: "our tasks",
    money: "our money",
    clients: "our clients",
    docs: "our docs and lists",
  }[place];
  return narrowed == null || narrowed === ""
    ? `About ${about}: `
    : `About ${about} (${narrowed}): `;
}
