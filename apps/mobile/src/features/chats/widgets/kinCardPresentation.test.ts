import type { EnvironmentId, KinWidget } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { emptyKinChat } from "../state/kinInboxModel";
import { mergeKinFeed } from "../state/kinChatFeed";
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
const task = (w: KinWidget, isKnown = known("env-home", "env-vps")) => {
  const view = kinCardView(w, isKnown);
  if (view.kind !== "task") throw new Error(`expected a task card, got ${view.kind}`);
  return view.task;
};

describe("kinCardView", () => {
  it("falls back on a missing widget, an unknown type, a non-native class or bad state", () => {
    expect(kinCardView(undefined, known()).kind).toBe("missing");
    expect(kinCardView(widget({ type: "poll" }), known()).kind).toBe("unknown");
    expect(kinCardView(widget({ widgetClass: "generated" }), known()).kind).toBe("unknown");
    expect(kinCardView(widget({ state: taskState({ status: "paused" }) }), known()).kind).toBe(
      "unknown",
    );
    expect(kinCardView(widget({ state: { title: "no ids" } }), known()).kind).toBe("unknown");
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

  it("shows the last error only when the task failed or is blocked", () => {
    const error = { lastError: "Tests failed\n\n  3 of 120" };
    expect(task(widget({ state: taskState({ ...error, status: "failed" }) })).detail).toBe(
      "Tests failed 3 of 120",
    );
    expect(task(widget({ state: taskState({ ...error, status: "working" }) })).detail).toBeNull();
  });

  it("opens the thread on its environment, or the remote one, only when this phone knows it", () => {
    expect(task(widget()).open).toEqual({ environmentId: "env-home", threadId: "thread-1" });
    const remote = widget({ state: taskState({ remoteEnvironmentId: "env-vps" }) });
    expect(task(remote).open).toEqual({ environmentId: "env-vps", threadId: "thread-1" });

    const elsewhere = task(widget(), known("env-vps"));
    expect(elsewhere.open).toBeNull();
    expect(elsewhere.unknownEnvironment).toBe(true);

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
            { url: "javascript:alert(1)", number: 213 },
            { url: "t3code://settings", number: 214 },
            { url: "not a url", number: 215 },
          ],
        }),
      }),
    );
    expect(view.pullRequests).toEqual([
      { url: "https://github.com/acme/app/pull/212", label: "PR 212" },
    ]);
    expect(view.accessibilityLabel).toBe(
      "Task: Fix the payments test. Working. GPT-6.1 Sol. PR 212. Opens the thread.",
    );
  });
});

// The stream merge keeps the highest revision too: `kinInboxModel.test.ts`.
describe("in-place updates", () => {
  const atRevision = (revision: number, status: string) =>
    widget({ revision, state: taskState({ status }) });
  const status = (widgets: ReadonlyArray<KinWidget>) => {
    expect(widgets).toHaveLength(1);
    return task(widgets[0]!).statusLabel;
  };

  it("an earlier page's older copy never overwrites the stream's, and a newer one wins", () => {
    const live = { ...emptyKinChat, widgets: [atRevision(3, "done")] };
    expect(
      status(mergeKinFeed(live, { ...emptyKinChat, widgets: [atRevision(2, "working")] }).widgets),
    ).toBe("Done");
    expect(
      status(mergeKinFeed(live, { ...emptyKinChat, widgets: [atRevision(4, "failed")] }).widgets),
    ).toBe("Failed");
  });
});
