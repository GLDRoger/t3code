import { describe, expect, it } from "vite-plus/test";

import { kinExpenseParamsOfBill, kinExpenseStartOf } from "./kinBillsPick";

const target = { environmentId: "env-1", orgId: "ambermill" };

describe("a bill typed by hand on the phone", () => {
  it("reads back from the form's address what the bill started it with", () => {
    const params = kinExpenseParamsOfBill(
      target,
      { receipt: "kin-chat-7", vendor: "Sample Cloud", paidOn: "2026-11-02", category: "software" },
      "sample-cloud.jpg",
    );
    expect(kinExpenseStartOf(params)).toEqual({
      draft: {
        receipt: "kin-chat-7",
        vendor: "Sample Cloud",
        paidOn: "2026-11-02",
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
