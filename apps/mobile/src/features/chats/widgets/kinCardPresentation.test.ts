import type { EnvironmentId, KinWidget } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { kinCardView } from "./kinCardPresentation";

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
