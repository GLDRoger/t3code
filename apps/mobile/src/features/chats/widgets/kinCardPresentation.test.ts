import { KinChatError, type EnvironmentId, type KinWidget } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { kinCardView } from "./kinCardPresentation";
import { KIN_SEND_FAILED_TEXT } from "./kinDeferralPresentation";
import {
  kinLevelsFailureText,
  kinLevelsScreenView,
  kinShownVerdict,
} from "./kinLevelsPresentation";

const taskState = (overrides: Record<string, unknown> = {}) => ({
  taskId: "task-1",
  environmentId: "env-home",
  threadId: "thread-1",
  remoteEnvironmentId: null,
  title: "Fix the payments test",
  model: "GPT-6.1 Sol",
  status: "working",
  pullRequests: [],
  lastError: null,
  updatedAt: "2026-11-08T09:00:00.000Z",
  ...overrides,
});

const widget = (overrides: Record<string, unknown> = {}) =>
  ({
    orgId: "org",
    chatId: "chat",
    widgetId: "w1",
    messageId: "m1",
    widgetClass: "native",
    type: "task",
    revision: 1,
    state: taskState(),
    source: null,
    feed: null,
    awaiting: [],
    pinnedAt: null,
    closedAt: null,
    updatedAt: "2026-11-08T09:00:00.000Z",
    ...overrides,
  }) as unknown as KinWidget;

const known =
  (...ids: string[]) =>
  (id: EnvironmentId) =>
    ids.includes(id);
const HOST = "env-home" as EnvironmentId;
const task = (w: KinWidget, isKnown = known("env-home", "env-vps", "env-other")) => {
  const view = kinCardView(w, HOST, isKnown);
  if (view.kind !== "task") throw new Error(`expected a task card, got ${view.kind}`);
  return view.task;
};

describe("kinCardView", () => {
  it("falls back on a missing widget, an unknown type, a non-native class or bad state", () => {
    expect(kinCardView(undefined, HOST, known()).kind).toBe("missing");
    expect(kinCardView(widget({ type: "poll" }), HOST, known()).kind).toBe("unknown");
    expect(
      kinCardView(widget({ type: "deferral", state: { what: "Rate limiting" } }), HOST, known())
        .kind,
    ).toBe("unknown");
    expect(kinCardView(widget({ widgetClass: "generated" }), HOST, known()).kind).toBe("unknown");
    expect(
      kinCardView(widget({ state: taskState({ status: "paused" }) }), HOST, known()).kind,
    ).toBe("unknown");
    expect(kinCardView(widget({ state: { title: "no ids" } }), HOST, known()).kind).toBe("unknown");
    expect(kinCardView(widget({ type: "deferral" }), HOST, known()).kind).toBe("unknown");
    const deferral = {
      itemId: "def-1",
      title: "Rate limiting",
      dueAt: "2026-11-13T09:00:00.000Z",
      onDue: "start",
      text: "",
    };
    expect(kinCardView(widget({ type: "deferral", state: deferral }), HOST, known()).kind).toBe(
      "deferral",
    );
  });

  it("ignores fields this build doesn't know", () => {
    expect(task(widget({ state: taskState({ progressText: "<b>hi</b>" }) })).title).toBe(
      "Fix the payments test",
    );
  });

  it("labels every status", () => {
    const statuses = [
      "working",
      "waiting",
      "needs_decision",
      "blocked",
      "done",
      "failed",
      "cancelled",
    ];
    expect(
      statuses.map((status) => task(widget({ state: taskState({ status }) })).statusLabel),
    ).toEqual([
      "Working",
      "Waiting",
      "Needs your decision",
      "Blocked",
      "Done",
      "Failed",
      "Cancelled",
    ]);
    expect(task(widget()).working).toBe(true);
    expect(task(widget({ state: taskState({ status: "done" }) })).working).toBe(false);
  });

  it("shows the last error whenever there is one, whatever the status", () => {
    const error = { lastError: "Tests failed\n\n  3 of 120" };
    expect(task(widget({ state: taskState({ ...error, status: "failed" }) })).detail).toBe(
      "Tests failed 3 of 120",
    );
    expect(task(widget({ state: taskState({ ...error, status: "cancelled" }) })).detail).toBe(
      "Tests failed 3 of 120",
    );
    expect(task(widget({ state: taskState({ status: "failed" }) })).detail).toBeNull();
  });

  it.each([
    ["no error", {}, "Task: Fix the payments test. Working. GPT-6.1 Sol. Opens the thread."],
    [
      "an error that ends a sentence",
      { status: "failed", lastError: "Tests also fail." },
      "Task: Fix the payments test. Failed. Tests also fail. GPT-6.1 Sol. Opens the thread.",
    ],
    [
      "a title that ends a question",
      { title: "Why is CI red?", model: null },
      "Task: Why is CI red? Working. Opens the thread.",
    ],
    [
      "an error that trails off",
      { status: "blocked", lastError: "Waiting on review…", model: null },
      "Task: Fix the payments test. Blocked. Waiting on review… Opens the thread.",
    ],
  ])("reads one sentence per part with %s", (_name, overrides, label) => {
    expect(task(widget({ state: taskState(overrides) })).accessibilityLabel).toBe(label);
  });

  it("clamps without splitting an emoji", () => {
    const title = `${"a".repeat(198)}😀😀`;
    expect(task(widget({ state: taskState({ title }) })).title).toBe(`${"a".repeat(198)}😀😀`);
    expect(task(widget({ state: taskState({ title: `${title}x` }) })).title).toBe(
      `${"a".repeat(198)}😀…`,
    );
  });

  it("opens the thread on its environment, or the remote one, only when this phone knows it", () => {
    expect(task(widget()).open).toEqual({ environmentId: "env-home", threadId: "thread-1" });
    const remote = widget({ state: taskState({ remoteEnvironmentId: "env-vps" }) });
    expect(task(remote).open).toEqual({ environmentId: "env-vps", threadId: "thread-1" });

    const elsewhere = task(widget(), known("env-vps"));
    expect(elsewhere.open).toBeNull();
    expect(elsewhere.unknownEnvironment).toBe(true);

    // A card in this chat can only name a thread on the chat's own host, unless it says remote.
    const foreign = task(widget({ state: taskState({ environmentId: "env-other" }) }));
    expect(foreign.open).toBeNull();
    expect(foreign.unknownEnvironment).toBe(true);

    const noThread = task(widget({ state: taskState({ threadId: null }) }));
    expect(noThread.open).toBeNull();
    expect(noThread.unknownEnvironment).toBe(false);
  });

  it("keeps only web links for pull requests", () => {
    const view = task(
      widget({
        state: taskState({
          pullRequests: [
            { url: "https://github.com/acme/app/pull/212", number: 212 },
            { url: "https://github.com.evil.example/acme/app/pull/9", number: 9 },
            { url: "javascript:alert(1)", number: 213 },
            { url: "t3code://settings", number: 214 },
            { url: "not a url", number: 215 },
          ],
        }),
      }),
    );
    expect(view.pullRequests).toEqual([
      { url: "https://github.com/acme/app/pull/212", label: "PR 212" },
      {
        url: "https://github.com.evil.example/acme/app/pull/9",
        label: "PR 9 · github.com.evil.example",
      },
    ]);
    expect(view.accessibilityLabel).toBe(
      "Task: Fix the payments test. Working. GPT-6.1 Sol. PR 212. PR 9 · github.com.evil.example. Opens the thread.",
    );
  });
});

describe("digest cards", () => {
  const entry = (overrides: Record<string, unknown> = {}) => ({
    entryId: "e1",
    tool: "kin_chat_post",
    level: "L0",
    unlocksLevel: "L1",
    wouldTarget: "#payments",
    preview: "Payments test fixed, PR 212 ready.",
    createdAt: "2026-11-09T09:00:00.000Z",
    ...overrides,
  });
  const shadow = (overrides: Record<string, unknown> = {}) =>
    widget({
      type: "shadow_summary",
      state: {
        agentId: "agent-1",
        title: "What tech-lead would have done today",
        day: "2026-11-09",
        total: 4,
        entries: [entry(), entry({ entryId: "e2", preview: "  ", wouldTarget: "" })],
        ...overrides,
      },
    });
  const row = (overrides: Record<string, unknown> = {}) => ({
    section: "overdue",
    title: "Rotate the staging key",
    ...overrides,
  });
  const routine = (rows: ReadonlyArray<Record<string, unknown>>) =>
    widget({ type: "routine", state: { routine: "morning_brief", day: "2026-11-09", rows } });
  const digest = (w: KinWidget) => {
    const view = kinCardView(w, HOST, known());
    if (view.kind !== "digest") throw new Error(`expected a digest card, got ${view.kind}`);
    return view.digest;
  };

  it("shows the shadow summary as plain rows, counting the entries it leaves out", () => {
    const view = digest(shadow());
    expect(view.title).toBe("What tech-lead would have done today");
    expect(view.rows.map((r) => [r.text, r.note])).toEqual([
      ["Payments test fixed, PR 212 ready.", "#payments"],
      ["kin_chat_post", null],
    ]);
    expect(view.more).toBe("2 more today");
    expect(view.accessibilityLabel).toBe(
      "Shadow week. What tech-lead would have done today. Payments test fixed, PR 212 ready. #payments. kin_chat_post. 2 more today.",
    );
    expect(digest(shadow({ total: 2 })).more).toBeNull();
  });

  it("heads each routine section once, in the server's order", () => {
    const view = digest(
      routine([row(), row({ title: "Renew the cert" }), row({ section: "ci_red", title: "main" })]),
    );
    expect(view.eyebrow).toBe("Morning brief");
    expect(view.rows.map((r) => r.heading)).toEqual(["Overdue", null, "CI failing"]);
  });

  it.each([
    ["a GitHub link", "https://github.com/o/r/pull/7", "Open"],
    ["another host, named", "https://ci.example/run/1", "Open · ci.example"],
    ["a phone number, dropped", "tel:+15551234", null],
    ["a T3 deep link, dropped", "t3code://threads/1", null],
    ["a script, dropped", "javascript:alert(1)", null],
  ])("opens only web links from routine rows: %s", (_name, link, chip) => {
    expect(digest(routine([row({ link })])).rows[0]!.link?.chipLabel ?? null).toBe(chip);
  });

  it("falls back on a digest whose state doesn't decode", () => {
    expect(kinCardView(shadow({ total: -1 }), HOST, known()).kind).toBe("unknown");
    expect(kinCardView(routine([row({ section: "someday" })]), HOST, known()).kind).toBe("unknown");
    expect(kinCardView(widget({ type: "shadow_review" }), HOST, known()).kind).toBe("unknown");
  });
});

describe("levels cards", () => {
  const stats = (overrides: Record<string, unknown> = {}) => ({
    from: "L0",
    to: "L1",
    daysAtLevel: 3,
    reviewed: 12,
    fine: 10,
    harmful: 0,
    unreviewed: 2,
    eligible: false,
    rule: { minDays: 7, minReviewed: 20, minFineShare: 0.8 },
    ...overrides,
  });
  const entry = (overrides: Record<string, unknown> = {}) => ({
    entryId: "e1",
    tool: "kin_chat_post",
    level: "L0",
    unlocksLevel: "L1",
    wouldTarget: "#payments",
    preview: "Payments test fixed.\n\n**PR 212** ready.",
    truncated: false,
    createdAt: "2026-11-09T09:00:00.000Z",
    verdict: null,
    ...overrides,
  });
  const reviewWidget = (overrides: Record<string, unknown> = {}) =>
    widget({
      type: "shadow_review",
      revision: 3,
      state: {
        agentId: "agent-1",
        title: "Review tech-lead's trial day",
        day: "2026-11-09",
        total: 5,
        unreviewed: 2,
        entries: [entry(), entry({ entryId: "e2", tool: "kin_delegate", truncated: true })],
        promotion: stats(),
        ...overrides,
      },
    });
  const review = (w: KinWidget) => {
    const view = kinCardView(w, HOST, known());
    if (view.kind !== "shadow_review") throw new Error(`expected a review card, got ${view.kind}`);
    return view.review;
  };
  const promotionWidget = (overrides: Record<string, unknown> = {}) =>
    widget({
      type: "promotion",
      state: {
        agentId: "agent-1",
        title:
          "tech-lead is ready for L1: 17 of 20 reviewed would have gone out unchanged, none harmful, none unreviewed.",
        stats: stats({ eligible: true }),
        status: "ready",
        actionId: null,
        deferredUntil: null,
        shadowMemory: null,
        shadowChanges: null,
        ...overrides,
      },
    });
  const promotion = (w: KinWidget) => {
    const view = kinCardView(w, HOST, known());
    if (view.kind !== "promotion") throw new Error(`expected a promotion card, got ${view.kind}`);
    return view.promotion;
  };

  it("shows review entries as plain text, with the trial's counts", () => {
    const view = review(reviewWidget());
    expect(view.summary).toBe("2 of 5 still need a verdict.");
    expect(view.more).toBe("3 more after these.");
    expect(view.entries.map((e) => [e.heading, e.target, e.truncated])).toEqual([
      ["Post at L0", "#payments", false],
      ["Delegation at L0", "#payments", true],
    ]);
    expect(view.entries[0]!.preview).toBe("Payments test fixed.\n\n**PR 212** ready.");
    expect(view.trial).toEqual([
      "Day 3 of 7 at L0.",
      "12 of 20 reviewed, 10 fine as is, none harmful, 2 unreviewed.",
      "L1 needs 7 days, 20 reviewed, 80% fine as is, none harmful and none unreviewed.",
    ]);
    expect(
      kinCardView(reviewWidget({ entries: [entry({ verdict: "maybe" })] }), HOST, known()).kind,
    ).toBe("unknown");
  });

  it("keeps the owner's verdict until the server's next revision", () => {
    const local = { revision: 3, verdicts: new Map([["e1", "fine" as const]]) };
    expect(kinShownVerdict({ entryId: "e1", verdict: null }, 3, local)).toBe("fine");
    expect(kinShownVerdict({ entryId: "e1", verdict: "wrong" }, 4, local)).toBe("wrong");
    expect(kinShownVerdict({ entryId: "e2", verdict: null }, 3, local)).toBeNull();
  });

  it.each([
    [
      "ready",
      {},
      [
        ["raise", "Raise to L1", false],
        ["defer", "Another week", false],
      ],
    ],
    ["deferred", { status: "deferred" }, [["raise", "Raise to L1", false]]],
    ["awaiting approval", { status: "awaiting_approval", actionId: "act-1" }, []],
    ["raised, nothing pending", { status: "raised" }, []],
    ["raised, kept", { status: "raised", shadowMemory: "kept" }, []],
    [
      "raised, Kin's own folders",
      {
        status: "raised",
        shadowMemory: "pending",
        shadowChanges: { paths: ["deferrals/a.md"], truncated: false, ownerReviewed: [] },
      },
      [
        ["keep", "Keep shadow memory", false],
        ["discard", "Start clean", false],
      ],
    ],
    [
      "raised, owner-reviewed paths",
      {
        status: "raised",
        shadowMemory: "pending",
        shadowChanges: {
          paths: ["decisions/x.md"],
          truncated: false,
          ownerReviewed: ["decisions/x.md"],
        },
      },
      [
        ["keep", "Keep shadow memory", true],
        ["discard", "Start clean", false],
      ],
    ],
    [
      "raised, not listed yet",
      { status: "raised", shadowMemory: "pending" },
      [
        ["keep", "Keep shadow memory", true],
        ["discard", "Start clean", false],
      ],
    ],
    ["closed", { status: "closed" }, []],
    ["top level", { stats: stats({ from: "L3", to: null }), status: "deferred" }, []],
  ])("offers the promotion buttons for %s", (_name, overrides, actions) => {
    expect(
      promotion(promotionWidget(overrides)).actions.map((a) => [a.id, a.label, a.disabled]),
    ).toEqual(actions);
  });

  it("says where a raise stands", () => {
    expect(promotion(promotionWidget({ status: "awaiting_approval" })).lines).toEqual([
      "Raise to L1 is waiting for your signed approval. It applies once you sign it.",
    ]);
    expect(
      promotion(
        promotionWidget({
          status: "raised",
          shadowMemory: "pending",
          shadowChanges: {
            paths: ["deferrals/a.md", "claims/b.md"],
            truncated: true,
            ownerReviewed: [],
          },
        }),
      ).lines,
    ).toEqual(["Raised to L1.", "Keep commits 2 files from the shadow week (list cut short):"]);
    expect(
      promotion(promotionWidget({ status: "raised", shadowMemory: "discarded" })).lines,
    ).toEqual(["Raised to L1.", "Started clean."]);
  });

  it("offers the owner one level down, one signed raise up, and a chat back to the lead's level", () => {
    const view = kinLevelsScreenView(
      {
        orgId: "org",
        agentId: "agent-1",
        level: "L1",
        levelSince: "2026-11-02T09:00:00.000Z",
        chats: [
          { chatId: "c0", level: "L0", levelSince: "2026-11-03T09:00:00.000Z" },
          { chatId: "c1", level: "L1", levelSince: "2026-11-03T09:00:00.000Z" },
        ],
        promotion: stats({ from: "L1", to: "L2", eligible: true }),
        pendingRaises: [
          { actionId: "act-1", chatId: "c0", level: "L1", state: "awaiting_approval" },
        ],
      } as never,
      (chatId) => `Chat ${chatId}`,
    );
    const changes = (row: { changes: ReadonlyArray<{ label: string; blocked: string | null }> }) =>
      row.changes.map((c) => [c.label, c.blocked]);
    expect(changes(view.lead)).toEqual([
      ["Raise to L2", null],
      ["Lower to L0", null],
    ]);
    expect(view.chats.map(changes)).toEqual([
      [["Raise to L1", "A raise is already waiting."]],
      [["Lower to L0", null]],
    ]);
    expect(view.pending.map((p) => p.text)).toEqual([
      "Chat c0 to L1: waiting for your signed approval.",
    ]);
  });

  it("shows the server's refusal and hides transport details", () => {
    const refusal = new KinChatError({
      reason: "invalid_state",
      message: "The lead isn't eligible for the next level yet.",
    });
    expect(kinLevelsFailureText(refusal)).toBe("The lead isn't eligible for the next level yet.");
    expect(kinLevelsFailureText(new KinChatError({ reason: "conflict", message: "row 7" }))).toBe(
      KIN_SEND_FAILED_TEXT,
    );
    expect(kinLevelsFailureText(new Error("socket closed"))).toBe(KIN_SEND_FAILED_TEXT);
  });
});
