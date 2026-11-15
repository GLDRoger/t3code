import { KinListId, KinRecordKey } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { kinPlaceOfWork, kinRecordOf, kinSearchOf, validateKinPlaceSearch } from "./kinPlaces";

const key = KinRecordKey.make("T-12");
const party = KinRecordKey.make("C-3");

describe("kinPlaceOfWork", () => {
  it.each([
    [{}, "tasks", {}],
    [{ show: "tasks" }, "tasks", {}],
    [{ show: "nonsense" }, "tasks", {}],
    [{ show: "clients" }, "clients", {}],
    [{ show: "projects" }, "clients", {}],
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
      { doc: party, version: 2, section: "s", changes: { to: 3, from: 1 }, history: true },
    ] as const;
    for (const record of records)
      expect(kinRecordOf(validateKinPlaceSearch({ ...kinSearchOf(record) }))).toEqual(record);
  });

  it("drops what isn't a record key or a version", () => {
    expect(
      validateKinPlaceSearch({ task: "", v: "0", changes: -1, dates: "yes", history: "1" }),
    ).toEqual({});
  });
});
