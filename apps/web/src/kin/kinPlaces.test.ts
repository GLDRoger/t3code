import { KinAgentId, KinListId, KinRecordKey } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  kinPlaceOfWork,
  kinRecordOf,
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

describe("place addresses", () => {
  it("reads back every record it writes", () => {
    const records = [
      { party },
      { project: party },
      { list: KinListId.make("renewals") },
      { dates: true },
      { subscriptions: true },
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
