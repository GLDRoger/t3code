import {
  EnvironmentId,
  KinListId,
  KinOrgId,
  KinPersonId,
  KinRecordKey,
  type KinListDefinition,
  type KinMoneySummary,
  type KinRecord,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

// Every filter the Expenses list was opened with.
const host = vi.hoisted(() => ({ opened: [] as Array<unknown> }));

vi.mock(import("./useKinMoney"), async (importOriginal) => {
  const { useState } = await import("react");
  const ready = (value: unknown) => ({
    state: { _tag: "ready", value, stale: false },
    refresh: () => {},
  });
  return {
    ...(await importOriginal()),
    useKinMoneySummary: (() => ready(summary)) as never,
    useKinLists: (() => ready({ lists: [expenses] })) as never,
    useKinListContext: (() => ({ names: names(), refs: new Map(), now: new Date(0) })) as never,
    useKinListEntries: ((_target: unknown, _list: unknown, initial: unknown) => {
      const [filter] = useState(() => {
        host.opened.push(initial);
        return initial;
      });
      return {
        state: {
          filter,
          records,
          total: records.length,
          more: false,
          seq: 1,
          loading: false,
          failed: null,
          refreshing: false,
          loadingMore: false,
          moreFailed: false,
          stale: false,
        },
        entries: { setFilter: () => {}, refresh: () => {}, loadMore: async () => {} },
        totals: null,
      };
    }) as never,
    useKinRates: () => null,
    useKinAskAgent: () => null,
    useKinCountryNeeded: () => false,
  };
});
vi.mock(import("./useKinWork"), async (importOriginal) => ({
  ...(await importOriginal()),
  useKinWork: (() => ({
    _tag: "ready",
    live: { seq: 1, summary: { parties: {} } },
    stale: false,
  })) as never,
  useKinWorkDirectory: (() => ({ names: names() })) as never,
}));
vi.mock(import("./useKinPlaces"), () => ({
  useKinDestinations: (() => ({
    destinations: ["chats", "tasks", "money", "clients", "docs"],
    known: true,
  })) as never,
}));
vi.mock(import("./useKinOwnerLevel"), async (importOriginal) => ({
  ...(await importOriginal()),
  useKinOwnerLevel: () => true,
  useKinSeesClients: () => true,
}));
// Money's other sections read the host for themselves; their own tests cover them.
vi.mock(import("./KinMoneyAnswers"), async (importOriginal) => ({
  ...(await importOriginal()),
  KinOutlookSection: () => null,
  KinCashSection: () => null,
  KinQuotesSection: () => null,
  KinBudgetsSection: () => null,
}));
vi.mock(import("./KinSubscriptions"), async (importOriginal) => ({
  ...(await importOriginal()),
  KinSubscriptionsSection: () => null,
}));
vi.mock(import("./KinReceipts"), async (importOriginal) => ({
  ...(await importOriginal()),
  KinReceiptsSection: () => null,
}));
vi.mock(import("./KinGoals"), async (importOriginal) => ({
  ...(await importOriginal()),
  KinGoals: () => null,
}));
vi.mock(import("./KinAttention"), async (importOriginal) => ({
  ...(await importOriginal()),
  KinAttentionSection: () => null,
}));
vi.mock(import("./useKinAttention"), async (importOriginal) => ({
  ...(await importOriginal()),
  useKinGoals: (() => ({
    state: { _tag: "ready", value: { goals: [] } },
    canSave: false,
  })) as never,
}));

import { KIN_LIST_DEFAULT_FILTER } from "@t3tools/client-runtime/kin/kinLists";
import { useState } from "react";

import "~/index.css";
import { render } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import type { KinRecordWhere } from "./kinPlaces";
import { KinPlaceView } from "./KinPlaceView";

// Tidewater Freight, invented: owner Rhea.
const rhea = KinPersonId.make("tidewater-rhea");
const target = { environmentId: EnvironmentId.make("env-1"), orgId: KinOrgId.make("tidewater") };
const names = () => ({
  people: new Map([[rhea, "Rhea"]]),
  agents: new Map(),
  me: rhea,
  zone: "UTC",
});
const inr = (minor: number) => [{ minor, currency: "INR" }];
const expenses = {
  list: KinListId.make("expenses"),
  name: "Expenses",
  prefix: "EXP",
  builtIn: true,
  states: ["open", "waiting", "done", "dropped"],
  stateLabels: {},
  defaultState: "open",
  categories: [],
  fields: [],
  sensitive: true,
  amount: true,
  currency: "INR",
  archivedAt: null,
  rev: 1,
  open: 1,
} as unknown as KinListDefinition;
const summary = {
  asOf: "2026-11-27T06:00:00.000Z",
  timeZone: "UTC",
  thisMonth: "2026-11",
  lastMonth: "2026-10",
  financialYear: "FY2026-27",
  owed: { total: [], overdue: [], invoices: 0, overdueInvoices: 0, byClient: [] },
  received: { thisMonth: [], lastMonth: [] },
  receivedThisFinancialYear: [],
  spent: {
    thisMonth: { total: inr(3_259_000), byCategory: [] },
    lastMonth: { total: [], byCategory: [] },
  },
  spentThisFinancialYear: inr(3_259_000),
  upcoming: [],
  upcomingTotal: 0,
  series: [],
} as unknown as KinMoneySummary;
const entry = (n: number, title: string, state: string, dateAt: string) =>
  ({
    key: KinRecordKey.make(`EXP-${n}`),
    title,
    state,
    list: "expenses",
    dateAt,
    amount: { minor: 120_000, currency: "INR" },
    rev: 1,
  }) as unknown as KinRecord;
// Paid in September, and a bill not paid yet: neither is in November's Spent.
const records = [
  entry(7, "Diesel for the Pune run", "done", "2026-09-14"),
  entry(12, "Warehouse rent", "open", "2026-11-20"),
];

function Money() {
  const [record, setRecord] = useState<KinRecordWhere | null>(null);
  return (
    <KinPlaceView
      {...target}
      place="money"
      tab="clients"
      onTab={() => {}}
      record={record}
      onGo={(place, next) => {
        host.opened.push({ place, next });
        setRecord(next);
      }}
      openKey={null}
      onOpenKey={() => {}}
      dialog={null}
      onDialog={() => {}}
      docLink={() => ""}
      onLeave={() => {}}
    />
  );
}

describe("Money's Expenses row", () => {
  it("opens every expense, paid or not and from any month, and closes back to Money", async () => {
    host.opened = [];
    await page.viewport(390, 844);
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <Money />
      </AppAtomRegistryProvider>,
    );
    const row = page.getByRole("button", { name: /^Expenses ₹32,590 spent this month/ });
    await userEvent.click(row);
    // The address carries the list, and the list opens with nothing narrowed.
    expect(host.opened).toEqual([
      { place: "money", next: { list: "expenses" } },
      KIN_LIST_DEFAULT_FILTER,
    ]);
    await expect.element(page.getByText("Diesel for the Pune run")).toBeVisible();
    await expect.element(page.getByText("Warehouse rent")).toBeVisible();
    // Each row says which entry it is, in the rows layout too.
    await expect.element(page.getByText(/^EXP-7 · /)).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Back to Money" }));
    expect(host.opened.at(-1)).toEqual({ place: "money", next: null });
    await expect.element(row).toBeVisible();
  });
});
