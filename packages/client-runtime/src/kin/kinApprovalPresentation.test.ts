import {
  KinApprovalError,
  type EnvironmentId,
  type KinApprovalView,
  type KinPendingAction,
  type KinWidget,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { kinApprovalCardView, kinApprovalFailure } from "./kinApprovalPresentation.ts";
import { kinCardView } from "./kinCardPresentation.ts";

const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

const merge = (overrides: Partial<KinPendingAction> = {}) =>
  ({
    id: "act_1",
    orgId: "kin-default",
    idempotencyKey: "0".repeat(64),
    kind: "merge_pull_request",
    target: {
      _tag: "pull_request",
      host: "github.com",
      repo: "GLDRoger/t3code",
      number: 212,
      mergeMethod: "squash",
      deleteBranchAfter: true,
    },
    resolved: {
      _tag: "pull_request",
      headSha: SHA,
      base: "main",
      head: "kin/fix-212",
      title: "Fix the payments test",
      additions: 120,
      deletions: 30,
      files: 4,
      checks: [
        { name: "ci", required: true, status: "passed" },
        { name: "lint", required: false, status: "pending" },
      ],
    },
    targetDigest: "f".repeat(64),
    nonce: "n".repeat(43),
    revision: 0,
    reason: "CI is green and Priya asked for it.",
    requestedBy: { agentId: "lead", threadId: "thread-lead" },
    provenance: {
      startedBy: { humanId: "priya" },
      startedByRole: "member",
      chain: [],
      ceilingBelowOwner: true,
      afterNonOwnerMessage: { humanId: "priya", messageId: "msg-1" },
    },
    requiredApprovers: [{ role: "owner" }],
    state: "awaiting_approval",
    createdAt: "2026-11-10T09:00:00.000Z",
    updatedAt: "2026-11-10T09:00:00.000Z",
    expiresAt: "2026-11-17T09:00:00.000Z",
    ...overrides,
  }) as unknown as KinPendingAction;

const full = (
  action: KinPendingAction,
  names: { leadName?: string; afterNonOwnerName?: string } = {
    leadName: "Tech lead",
    afterNonOwnerName: "Priya",
  },
) => ({ _tag: "full", action, canApprove: true, ...names }) as KinApprovalView;

const prFacts = merge().resolved as Extract<KinPendingAction["resolved"], { _tag: "pull_request" }>;

describe("kinApprovalCardView", () => {
  it("draws a merge from the host's facts, full SHA and who asked", () => {
    const card = kinApprovalCardView(full(merge()));
    expect(card).toMatchObject({
      eyebrow: "Approval needed",
      title: "Merge #212 into main",
      subtitle: "Fix the payments test",
      asked: { text: "Asked for after Priya's message.", warning: true },
      reason: { label: "Tech lead says", text: "CI is green and Priya asked for it." },
      status: null,
      settled: false,
      decidable: true,
      approveBlocked: null,
    });
    expect(card.facts.map((fact) => [fact.label, fact.value])).toEqual([
      ["Repository", "GLDRoger/t3code"],
      ["Commit", SHA],
      ["Branches", "main ← kin/fix-212"],
      ["Method", "Squash, then delete the branch"],
      ["Changes", "4 files, +120 −30"],
      ["Checks", "1 passed, 1 pending"],
    ]);
    // Only required checks are listed; an optional one pending doesn't hold Approve.
    expect(card.checks.map((check) => [check.name, check.label])).toEqual([["ci", "Passed"]]);
  });

  it("names who asked from the provenance the host recorded", () => {
    const asked = (
      provenance: Partial<KinPendingAction["provenance"]>,
      names: { leadName?: string; afterNonOwnerName?: string } = { leadName: "Tech lead" },
    ) =>
      kinApprovalCardView(
        full(
          merge({
            provenance: {
              startedBy: { humanId: "kin-default-owner" },
              startedByRole: "owner",
              chain: [],
              ceilingBelowOwner: false,
              ...provenance,
            } as KinPendingAction["provenance"],
          }),
          names,
        ),
      ).asked;
    expect(asked({})).toEqual({ text: "Asked by Tech lead.", warning: false });
    expect(asked({ ceilingBelowOwner: true, startedBy: "github" })).toEqual({
      text: "Asked for after activity on GitHub.",
      warning: true,
    });
    expect(
      asked({
        ceilingBelowOwner: true,
        afterNonOwnerMessage: { humanId: "priya", messageId: "m" },
      } as Partial<KinPendingAction["provenance"]>),
    ).toEqual({ text: "Asked for after someone else's message.", warning: true });
  });

  it("holds Approve while a required check is pending or failed, never Decline", () => {
    const withCheck = (status: "pending" | "failed") =>
      kinApprovalCardView(
        full(merge({ resolved: { ...prFacts, checks: [{ name: "ci", required: true, status }] } })),
      );
    expect(withCheck("pending")).toMatchObject({
      decidable: true,
      approveBlocked: "Waiting for checks.",
    });
    expect(withCheck("failed")).toMatchObject({
      decidable: true,
      approveBlocked: "A required check failed.",
    });
  });

  it("a settled card offers nothing, including one this phone just decided", () => {
    const waiting = full(merge());
    expect(kinApprovalCardView(waiting, { busy: "approving" })).toMatchObject({
      decidable: false,
      status: "Waiting for Face ID…",
    });
    // The submit's answer shows at once, before the host redraws.
    expect(kinApprovalCardView(waiting, { decided: "approved" })).toMatchObject({
      settled: true,
      decidable: false,
      status: "Approved. Merging soon.",
    });
    // Once the host moves on, its state wins over the local one.
    expect(
      kinApprovalCardView(full(merge({ state: "succeeded" })), { decided: "approved" }).status,
    ).toBe("Merged.");
    expect(
      kinApprovalCardView(full(merge({ state: "failed", stateReason: "head_moved: HTTP 409" })))
        .status,
    ).toBe(
      "A new commit landed after you approved, so it didn't merge. Approve the new request instead.",
    );
    expect(kinApprovalCardView(waiting, { decided: "rejected" })).toMatchObject({
      decidable: false,
      status: "Declined.",
    });
  });

  it("a level raise names the lead and says the owner asked", () => {
    const raise = merge({
      kind: "set_level",
      target: { _tag: "level", agentId: "lead", level: "L1" },
      resolved: { _tag: "none" },
      reason: "Raise Tech lead to L1, from the owner's promotion card.",
      requestedBy: { agentId: "kin-promotion", threadId: "kin-promotion" },
      provenance: {
        startedBy: { humanId: "kin-default-owner" },
        startedByRole: "owner",
        chain: [],
        ceilingBelowOwner: false,
      },
    } as unknown as Partial<KinPendingAction>);
    expect(kinApprovalCardView(full(raise, { leadName: "Tech lead" }))).toMatchObject({
      title: "Raise Tech lead to L1",
      asked: { text: "You asked for this.", warning: false },
      reason: null,
      decidable: true,
    });
  });

  it("anyone else sees who it waits on and never a button", () => {
    const card = kinApprovalCardView({
      _tag: "redacted",
      actionId: "act_1",
      orgId: "kin-default",
      kind: "merge_pull_request",
      repo: "GLDRoger/t3code",
      number: 212,
      title: "Fix the payments test",
      state: "awaiting_approval",
      waitingOn: "Nishchay",
      canApprove: false,
    } as KinApprovalView);
    expect(card).toMatchObject({
      eyebrow: "Waiting on Nishchay",
      title: "Merge #212 in GLDRoger/t3code",
      facts: [],
      decidable: false,
    });
  });
});

describe("kinCardView approval", () => {
  const widget = (overrides: Record<string, unknown>) =>
    ({
      orgId: "kin-default",
      chatId: "chat",
      widgetId: "kin-approval:act_1",
      messageId: "kin-approval:act_1",
      widgetClass: "native",
      type: "approval",
      revision: 2,
      state: { actionId: "act_1", revision: 0, state: "awaiting_approval" },
      source: null,
      feed: null,
      awaiting: [],
      pinnedAt: null,
      closedAt: null,
      updatedAt: "2026-11-10T09:00:00.000Z",
      ...overrides,
    }) as unknown as KinWidget;
  const view = (w: KinWidget) => kinCardView(w, "env" as EnvironmentId, () => true);

  it("reads only a server card whose id names its action", () => {
    expect(view(widget({}))).toEqual({
      kind: "approval",
      approval: { actionId: "act_1", state: "awaiting_approval", closed: false, revision: 2 },
    });
    expect(view(widget({ state: { actionId: "act_2" } })).kind).toBe("unknown");
    expect(view(widget({ widgetId: "w1" })).kind).toBe("unknown");
  });
});

describe("kinApprovalFailure", () => {
  it("says what to do next, and nothing when the owner canceled", () => {
    expect(kinApprovalFailure(null, "E_USER_CANCELED")).toBeNull();
    expect(kinApprovalFailure(null, "E_KEY_INVALIDATED")).toMatchObject({ reenrol: true });
    const host = (reason: KinApprovalError["reason"]) =>
      kinApprovalFailure(new KinApprovalError({ reason, message: "x" }));
    expect(host("head_moved")).toMatchObject({ refresh: true, reenrol: false });
    expect(host("unknown_key")).toMatchObject({ refresh: false, reenrol: true });
    expect(host("replayed")).toMatchObject({ text: "This was already decided.", refresh: true });
    expect(kinApprovalFailure(new Error("socket closed"))).toMatchObject({
      text: "Kin didn't answer. Try again.",
    });
  });
});
