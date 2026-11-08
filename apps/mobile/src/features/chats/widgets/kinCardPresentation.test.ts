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
