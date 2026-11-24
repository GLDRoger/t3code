import { KinAgentId, KinBillBatchId, KinListId, KinRecordKey } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  KIN_PLACE_PATH,
  kinPlaceOfWork,
  kinRecordOf,
  kinRecordPlace,
  kinSearchDialogPlace,
  kinSearchHitPlace,
  kinSearchOf,
  kinTaskAddress,
  validateKinAgentSearch,
  validateKinPlaceSearch,
  withKinAgentPage,
} from "./kinPlaces";

const key = KinRecordKey.make("T-12");
const party = KinRecordKey.make("C-3");

describe("kinPlaceOfWork", () => {
  it.each([
    [{}, "tasks", {}],
    [{ show: "tasks" }, "tasks", {}],
    [{ show: "nonsense" }, "tasks", {}],
    [{ show: "clients" }, "clients", {}],
    [{ show: "projects" }, "clients", { tab: "projects" }],
    [{ show: "money" }, "money", {}],
    [{ show: "dates" }, "money", { dates: true }],
    [{ show: "docs" }, "docs", {}],
    [{ show: "lists" }, "docs", {}],
    [{ task: key }, "tasks", { task: key }],
    [{ show: "money", task: key }, "money", { task: key }],
    [{ client: party }, "clients", { client: party }],
    [{ project: party, show: "projects" }, "clients", { project: party }],
    [{ doc: party, section: "s" }, "docs", { doc: party, section: "s" }],
    [{ list: KinListId.make("invoices") }, "money", { list: "invoices" }],
    [{ list: KinListId.make("expenses") }, "money", { list: "expenses" }],
    [{ list: KinListId.make("renewals"), show: "lists" }, "docs", { list: "renewals" }],
    // A record named in the address wins over the part it was shown from.
    [{ show: "dates", client: party }, "clients", { client: party }],
  ] as const)("%j lands on %s", (search, place, kept) => {
    expect(kinPlaceOfWork(search)).toEqual({ place, search: kept });
  });
});

describe("kinRecordPlace", () => {
  it.each([
    ["task", "W-1", "tasks", { task: "W-1" }],
    ["client", "C-1", "clients", { client: "C-1" }],
    ["project", "P-1", "clients", { project: "P-1" }],
    ["doc", "D-1", "docs", { doc: "D-1" }],
    ["entry", "INV-1", "money", { task: "INV-1" }],
    // A deal lives on Clients' Deals tab, however a message, notice or search names it.
    ["entry", "DL-1", "clients", { tab: "deals", task: "DL-1" }],
    ["task", "DL-1", "clients", { tab: "deals", task: "DL-1" }],
  ] as const)("opens %s %s where it lives", (kind, key, place, search) => {
    expect(kinRecordPlace({ key, kind })).toEqual({
      to: KIN_PLACE_PATH[place],
      search,
    });
  });
});

describe("kinSearchHitPlace", () => {
  it.each([
    ["work", "W-1", null, "tasks", { task: "W-1" }],
    ["work", "DL-1", null, "clients", { tab: "deals", task: "DL-1" }],
    ["clients", "C-1", null, "clients", { client: "C-1" }],
    ["projects", "P-1", null, "clients", { project: "P-1" }],
    ["docs", "D-1", "s2", "docs", { doc: "D-1", section: "s2" }],
    ["docs", "D-1", null, "docs", { doc: "D-1" }],
    ["invoices", "INV-1", null, "money", { task: "INV-1" }],
    ["receipts", "RC-1", null, "money", { task: "RC-1" }],
    ["contacts", "CT-1", null, "tasks", { task: "CT-1" }],
  ] as const)(
    "opens a %s hit %s where a message link to it opens",
    (kind, key, section, place, search) => {
      expect(
        kinSearchHitPlace({
          kind,
          key,
          section: section === null ? null : { id: section },
          clientKey: null,
        }),
      ).toEqual({
        to: KIN_PLACE_PATH[place],
        search,
      });
    },
  );

  it("opens a contact on its client's page", () => {
    expect(
      kinSearchHitPlace({ kind: "contacts", key: "CT-2", section: null, clientKey: "C-1" }),
    ).toEqual({ to: KIN_PLACE_PATH.clients, search: { client: "C-1" } });
  });

  it("leaves memory to Settings", () => {
    expect(
      kinSearchHitPlace({ kind: "memory", key: "memory:1", section: null, clientKey: null }),
    ).toBeNull();
  });
});

describe("kinSearchDialogPlace", () => {
  const hit = (kind: "work" | "invoices", key: string) => ({
    kind,
    key: KinRecordKey.make(key),
    section: null,
    clientKey: null,
  });
  const deal = { to: KIN_PLACE_PATH.clients, search: { tab: "deals", task: "DL-1" } };

  it.each([
    // A deal lands on Clients' Deals tab, as the palette and a message link land it.
    ["tasks", "clients", hit("work", "DL-1"), deal],
    ["clients", "clients", hit("work", "DL-1"), deal],
    ["clients", "projects", hit("work", "DL-1"), deal],
    ["money", "clients", hit("invoices", "DL-1"), deal],
    // Already on the Deals tab, it opens there over what is open.
    ["clients", "deals", hit("work", "DL-1"), null],
    // A task or a money entry opens over the place searched from.
    ["tasks", "clients", hit("work", "W-1"), null],
    ["clients", "clients", hit("work", "W-1"), null],
    ["tasks", "clients", hit("invoices", "INV-1"), null],
  ] as const)("from %s (%s tab) a hit %j leaves for %j", (place, tab, found, to) => {
    expect(kinSearchDialogPlace({ place, tab }, found)).toEqual(to);
  });
});

describe("place addresses", () => {
  it("reads back every record it writes", () => {
    const records = [
      { party },
      { project: party },
      { list: KinListId.make("renewals") },
      { dates: true },
      { subscriptions: true },
      { bills: null },
      { bills: KinBillBatchId.make("b-3f9a") },
      { doc: party, version: 2, section: "s", changes: { to: 3, from: 1 }, history: true },
    ] as const;
    for (const record of records)
      expect(kinRecordOf(validateKinPlaceSearch({ ...kinSearchOf(record) }))).toEqual(record);
  });

  it.each([
    ["tasks", {}, "/kin/$environmentId/$orgId/tasks", {}],
    [
      "money",
      { list: KinListId.make("invoices") },
      "/kin/$environmentId/$orgId/money",
      {
        list: "invoices",
      },
    ],
    [
      "clients",
      { client: party, tab: "projects" },
      "/kin/$environmentId/$orgId/clients",
      {
        client: party,
        tab: "projects",
      },
    ],
    // A deal opens over the Deals tab, which stays in the address.
    ["clients", { tab: "deals" }, "/kin/$environmentId/$orgId/clients", { tab: "deals" }],
    ["docs", { doc: party, v: 2 }, "/kin/$environmentId/$orgId/docs", { doc: party, v: 2 }],
    // The Projects tab is the Clients place's alone, and a dialog closes as a task opens.
    [
      "tasks",
      { project: party, tab: "projects", open: "search" },
      "/kin/$environmentId/$orgId/tasks",
      {
        project: party,
      },
    ],
  ] as const)(
    "opens a task over %s %j, and closing it removes only the task",
    (place, search, to, under) => {
      const other = KinRecordKey.make("T-13");
      expect(kinTaskAddress(place, search, key)).toEqual({ to, search: { ...under, task: key } });
      expect(kinTaskAddress(place, { ...search, task: other }, key)).toEqual({
        to,
        search: { ...under, task: key },
      });
      expect(kinTaskAddress(place, { ...search, task: key }, null)).toEqual({ to, search: under });
    },
  );

  it("drops what isn't a record key or a version", () => {
    expect(
      validateKinPlaceSearch({
        task: "",
        v: "0",
        changes: -1,
        dates: "yes",
        history: "1",
        open: "sheet",
        tab: "clients",
      }),
    ).toEqual({});
  });

  it("reads bills with no value as every batch, and a value that is no batch as no place", () => {
    // The router hands a route its validated search over the raw one, so both reach `kinRecordOf`.
    const placeOf = (raw: Record<string, unknown>) =>
      kinRecordOf(Object.assign({}, raw, validateKinPlaceSearch(raw)));
    expect(placeOf({ bills: "" })).toEqual({ bills: null });
    expect(placeOf({ bills: true })).toEqual({ bills: null });
    expect(placeOf({ bills: "b-3f9a" })).toEqual({ bills: "b-3f9a" });
    expect(placeOf({ bills: 5 })).toBeNull();
    expect(placeOf({ bills: "x".repeat(81) })).toBeNull();
  });

  it("opens an agent's page over the place and closes Settings", () => {
    const agent = KinAgentId.make("lead-finance");
    expect(validateKinAgentSearch({ agent: "lead-finance" })).toEqual({ agent });
    expect(validateKinAgentSearch({ agent: "" })).toEqual({});
    expect(withKinAgentPage({ task: key, settings: "agents" }, agent)).toEqual({
      task: key,
      agent,
    });
  });
});
