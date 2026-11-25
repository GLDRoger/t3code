import { KinRecordKey } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  kinBilledName,
  kinBillToFieldPatch,
  kinBillToOffered,
  kinUseClientInstead,
} from "./kinBillTo.ts";

const cleared = {
  billToName: null,
  billToAddress: null,
  billToTaxNumber: null,
  billToPlace: null,
  billToEmail: null,
};

describe("an invoice or quote billed by name", () => {
  it("is offered by a host that says it takes a name, or whose invoices or quotes list has the field", () => {
    const field = (key: string) => ({ key }) as never;
    const withField = [{ list: "quotes", fields: [field("billToName")] }];
    const without = [{ list: "invoices", fields: [field("number"), field("file")] }];
    expect(kinBillToOffered({ lists: [], billToByName: true })).toBe(true);
    expect(kinBillToOffered({ lists: [] })).toBe(false);
    expect(kinBillToOffered({ lists: without })).toBe(false);
    expect(kinBillToOffered({ lists: without, billToByName: false })).toBe(false);
    expect(kinBillToOffered({ lists: withField })).toBe(true);
    expect(kinBillToOffered({ lists: [{ list: "expenses", fields: [field("billToName")] }] })).toBe(
      false,
    );
  });

  it("clears every detail with the name, and gives a client in the same update", () => {
    expect(kinBillToFieldPatch("billToName", "  ")).toEqual(cleared);
    expect(kinBillToFieldPatch("billToName", null)).toEqual(cleared);
    expect(kinBillToFieldPatch("billToName", "Asha Rao")).toEqual({ billToName: "Asha Rao" });
    expect(kinBillToFieldPatch("billToEmail", " ")).toEqual({ billToEmail: null });
    const lumen = KinRecordKey.make("C-2");
    expect(kinUseClientInstead(lumen)).toEqual({ party: lumen, fields: cleared });
  });

  it("names its client first, else the typed name", () => {
    expect(kinBilledName({ party: { title: "Lumen" }, fields: { billToName: "Asha" } })).toBe(
      "Lumen",
    );
    expect(kinBilledName({ fields: { billToName: " Asha Rao " } })).toBe("Asha Rao");
    expect(kinBilledName({ fields: { billToName: " " } })).toBeNull();
  });
});
