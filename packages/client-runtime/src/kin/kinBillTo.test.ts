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
  it("is offered only by a host whose invoices or quotes list has the name field", () => {
    const field = (key: string) => ({ key }) as never;
    expect(kinBillToOffered([])).toBe(false);
    expect(kinBillToOffered([{ list: "invoices", fields: [field("number"), field("file")] }])).toBe(
      false,
    );
    expect(kinBillToOffered([{ list: "quotes", fields: [field("billToName")] }])).toBe(true);
    expect(kinBillToOffered([{ list: "expenses", fields: [field("billToName")] }])).toBe(false);
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
