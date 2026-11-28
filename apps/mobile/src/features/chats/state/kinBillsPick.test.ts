import { describe, expect, it } from "vite-plus/test";

import {
  kinBillFixParamsOf,
  kinBillFixStartOf,
  kinExpenseParamsOfBill,
  kinExpenseStartOf,
} from "./kinBillsPick";

const target = { environmentId: "env-1", orgId: "ambermill" };

describe("a bill typed by hand on the phone", () => {
  it("reads back from the form's address what the bill started it with", () => {
    const params = kinExpenseParamsOfBill(
      target,
      {
        receipt: "kin-chat-7",
        title: "Sample Cloud",
        vendor: "Sample Cloud",
        paidOn: "2026-11-02",
        amount: "49",
        currency: "USD",
        category: "software",
      },
      "sample-cloud.jpg",
    );
    expect(kinExpenseStartOf(params)).toEqual({
      draft: {
        receipt: "kin-chat-7",
        title: "Sample Cloud",
        vendor: "Sample Cloud",
        paidOn: "2026-11-02",
        amount: "49",
        currency: "USD",
        category: "software",
      },
      receipt: { attachmentId: "kin-chat-7", name: "sample-cloud.jpg" },
    });
  });

  it("starts empty from a plain address, and drops a day it can't read", () => {
    expect(kinExpenseStartOf(target)).toEqual({ draft: {}, receipt: null });
    expect(kinExpenseStartOf({ ...target, paidOn: "2 Nov", vendor: "  " }).draft).toEqual({});
  });
});

describe("a bill fixed and kept on the phone", () => {
  it("reads back every figure the bill was read with, and the company's currency when none was", () => {
    const start = {
      vendor: "Harbor Cafe",
      date: "",
      amount: "1200",
      currency: "USD",
      tax: "60",
      category: "meals",
      number: "HC-12",
    };
    const params = kinBillFixParamsOf(target, { sha256: "a".repeat(64), name: "cafe.jpg" }, start);
    expect([params.bill, params.receiptName]).toEqual(["a".repeat(64), "cafe.jpg"]);
    expect(kinBillFixStartOf(params, "INR")).toEqual(start);
    expect(
      kinBillFixStartOf({ ...params, currency: "dollars", date: "6 Nov" }, "INR"),
    ).toMatchObject({ currency: "INR", date: "" });
  });
});
