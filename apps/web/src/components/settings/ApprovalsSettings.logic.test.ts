import { KinApprovalError } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { approvalsProblem } from "./ApprovalsSettings.logic";

describe("approvalsProblem", () => {
  it.each([
    [
      new KinApprovalError({ reason: "not_owner", message: "Only the owner chooses the phones." }),
      { text: "Only the owner chooses the phones.", retry: false },
    ],
    [
      new KinApprovalError({ reason: "unavailable", message: "Host is busy." }),
      { text: "Kin didn't answer. Try again.", retry: true },
    ],
    [new Error("socket closed"), { text: "Kin didn't answer. Try again.", retry: true }],
  ])("offers a retry only when one can help (%#)", (cause, expected) => {
    expect(approvalsProblem(cause)).toEqual(expected);
  });
});
