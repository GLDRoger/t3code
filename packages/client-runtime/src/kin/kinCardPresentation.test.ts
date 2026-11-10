import { KinChatError, type EnvironmentId, type KinWidget } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  kinCardView,
  kinQuietCardLine,
  kinReminderCardView,
  kinScheduledTaskCardView,
} from "./kinCardPresentation.ts";
import { kinChoiceAnswerText, kinChoicePhase } from "./kinChoicePresentation.ts";
import { kinCardStatusAfter, kinDeferralCountdown } from "./kinDeferralPresentation.ts";
import { kinMemoryUndoFailureText } from "./kinMemoryChangesPresentation.ts";

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

describe("choice cards", () => {
  const posted = Date.parse("2026-11-08T09:00:00.000Z");
  const choiceState = (answer: unknown = null) => ({
    question: "Ship   today?",
    detail: null,
    options: [
      { optionId: "option-1", label: "Ship it", kind: "yes" },
      { optionId: "option-2", label: "Wait", kind: "no" },
    ],
    answer,
  });
  const choice = (overrides: Record<string, unknown> = {}) => {
    const view = kinCardView(
      widget({ type: "choice", state: choiceState(), ...overrides }),
      HOST,
      known(),
    );
    if (view.kind !== "choice") throw new Error(`expected a choice card, got ${view.kind}`);
    return view.choice;
  };

  it("takes taps until it is answered, closed or a day old", () => {
    const open = choice();
    expect(open.question).toBe("Ship today?");
    expect(open.options.map((option) => option.label)).toEqual(["Ship it", "Wait"]);
    expect(kinChoicePhase(open, posted + 60_000)).toBe("open");
    expect(kinChoicePhase(open, posted + 24 * 60 * 60 * 1000)).toBe("expired");
    expect(kinChoicePhase(choice({ closedAt: "2026-11-08T10:00:00.000Z" }), posted)).toBe(
      "expired",
    );
    expect(
      kinCardView(
        widget({ type: "choice", state: { ...choiceState(), options: [] } }),
        HOST,
        known(),
      ).kind,
    ).toBe("unknown");
  });

  it("says who chose which option, and how", () => {
    const answer = (via: "tap" | "reaction", emoji: string | null) =>
      choice({
        revision: 2,
        state: choiceState({
          optionId: "option-1",
          personId: "owner",
          via,
          emoji,
          answeredAt: "2026-11-08T09:05:00.000Z",
        }),
      });
    const tapped = answer("tap", null);
    expect(kinChoicePhase(tapped, posted + 48 * 60 * 60 * 1000)).toBe("answered");
    expect(kinChoiceAnswerText(tapped.answer!, "owner" as never)).toBe("You chose “Ship it”");
    expect(kinChoiceAnswerText(tapped.answer!, null)).toBe("Chose “Ship it”");
    expect(kinChoiceAnswerText(answer("reaction", "👍").answer!, "owner" as never)).toBe(
      "You chose “Ship it” with 👍",
    );
  });
});

describe("reminder and scheduled task cards", () => {
  const zone = "Asia/Kolkata";
  const reminder = (state: Record<string, unknown>, overrides: Record<string, unknown> = {}) =>
    widget({
      type: "reminder",
      widgetId: "reminder:org:def-1:1794555000000",
      state: {
        itemId: "def-1",
        title: "Send the invoice",
        dueAt: "2026-11-13T03:30:00.000Z",
        ...state,
      },
      ...overrides,
    });
  const scheduled = (state: Record<string, unknown>, overrides: Record<string, unknown> = {}) =>
    widget({
      type: "scheduled_task",
      widgetId: "scheduled:org:sch-1",
      state: {
        itemId: "sch-1",
        title: "Open PRs digest",
        every: { at: "08:00", days: [5, 1, 2, 3, 4] },
        timeZone: zone,
        status: "active",
        nextRunAt: "2026-11-10T02:30:00.000Z",
        lastRun: null,
        ...state,
      },
      ...overrides,
    });

  it("offers Done, three snoozes and Change until the reminder is done", () => {
    expect(kinCardView(reminder({ status: "due" }), HOST, known()).kind).toBe("deferral");
    const due = kinReminderCardView(reminder({ status: "due" }), zone)!;
    expect(due).toMatchObject({ eyebrow: "Reminder", title: "Send the invoice" });
    expect(due.lines).toEqual(["Due Fri 13 Nov, 9:00."]);
    expect(due.actions.map((action) => action.id)).toEqual([
      "done",
      "snooze_10m",
      "snooze_1h",
      "snooze_tomorrow",
      "change",
    ]);
    const snoozed = kinReminderCardView(
      reminder({ status: "snoozed", snoozedUntil: "2026-11-13T03:40:00.000Z" }),
      zone,
    )!;
    expect(snoozed.lines).toEqual(["Snoozed until Fri 13 Nov, 9:10."]);
    expect(snoozed.actions).toHaveLength(5);
    expect(kinReminderCardView(reminder({ status: "done" }), zone)!.actions).toEqual([]);
    expect(kinReminderCardView(reminder({ status: "bogus" }), zone)).toBeNull();
  });

  it("shows when a scheduled task runs, how the last run went, and its controls", () => {
    const active = kinScheduledTaskCardView(scheduled({}), zone)!;
    expect(active.lines).toEqual(["Weekdays at 8:00.", "Next run Tue 10 Nov, 8:00."]);
    expect(active.countdown).toEqual({ to: Date.parse("2026-11-10T02:30:00.000Z"), kind: "run" });
    expect(active.actions.map((action) => action.id)).toEqual([
      "run_now",
      "pause",
      "edit",
      "delete",
    ]);
    expect(kinScheduledTaskCardView(scheduled({}), "UTC")!.lines[0]).toBe(
      "Weekdays at 8:00 (Asia/Kolkata).",
    );

    const posted = kinScheduledTaskCardView(
      scheduled({
        lastRun: { at: "2026-11-10T02:30:00.000Z", status: "posted", note: "Three PRs are open." },
      }),
      zone,
    )!;
    expect(posted.lines.at(-1)).toBe("Last run Tue 10 Nov, 8:00: Three PRs are open.");
    const running = kinScheduledTaskCardView(
      scheduled({ lastRun: { at: "2026-11-10T02:30:00.000Z", status: "running" } }),
      zone,
    )!;
    expect(running.actions.map((action) => action.id)).toEqual(["pause", "edit", "delete"]);

    const paused = kinScheduledTaskCardView(
      scheduled({ status: "paused", nextRunAt: null }),
      zone,
    )!;
    expect(paused.lines).toEqual(["Weekdays at 8:00.", "Paused."]);
    expect(paused.countdown).toBeNull();
    expect(paused.actions.map((action) => action.id)).toEqual([
      "run_now",
      "resume",
      "edit",
      "delete",
    ]);
    const deleted = kinScheduledTaskCardView(
      scheduled({ status: "deleted", nextRunAt: null }),
      zone,
    )!;
    expect(deleted).toMatchObject({ lines: ["Deleted."], actions: [] });
  });

  it("counts down to the next run and says what Kin did after a tap", () => {
    expect(kinDeferralCountdown(3 * 60 * 60_000, 0, "run")).toBe("Next run in 3 h");
    expect(kinCardStatusAfter({ status: "sent" }, "snooze_1h", 2)).toEqual({
      revision: 2,
      notice: { kind: "sent", text: "Snoozed." },
      holding: true,
    });
    expect(kinCardStatusAfter({ status: "sent" }, "edit", 2).holding).toBe(false);
  });
});

describe("digest cards", () => {
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

  it("heads each routine section once, in the server's order", () => {
    const view = digest(
      routine([row(), row({ title: "Renew the cert" }), row({ section: "ci_red", title: "main" })]),
    );
    expect(view.eyebrow).toBe("Morning brief");
    expect(view.rows.map((r) => r.heading)).toEqual(["Overdue", null, "CI failing"]);
  });

  it("reads a raw timestamp in a note as a time", () => {
    const [noted] = digest(routine([row({ note: "review by 2026-11-09T16:09:12.531Z" })])).rows;
    expect(noted!.note).toMatch(/^review by \w{3} \d+ Nov, \d+:\d{2}$/);
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
    expect(kinCardView(routine([row({ section: "someday" })]), HOST, known()).kind).toBe("unknown");
  });
});

describe("memory change card", () => {
  it("lists each change in plain words with its Undo state", () => {
    const item = (itemId: string, change: string, undo: string | null) => ({
      itemId,
      path: `claims/${itemId}.md`,
      title: itemId === "short" ? "you prefer short replies" : "main repo is GLDRoger/t3code",
      change,
      undo,
    });
    const changes = widget({
      type: "memory_changes",
      state: {
        agentId: "lead",
        wakeupId: "wake-1",
        branch: "kin/shadow/lead",
        base: "a".repeat(40),
        commit: "b".repeat(40),
        items: [item("short", "created", null), item("repo", "updated", "stale")],
        more: 1,
      },
    });
    const view = kinCardView(changes, HOST, known());
    expect(kinQuietCardLine(changes)).toBe("Remembered: you prefer short replies and 1 more");
    expect(kinQuietCardLine(widget({ type: "task", state: taskState() }))).toBeNull();
    if (view.kind !== "memory_changes")
      throw new Error(`expected memory changes, got ${view.kind}`);
    expect(view.changes.items.map(({ line, undo }) => [line, undo])).toEqual([
      ["Remembered: you prefer short replies", "available"],
      ["Updated: main repo is GLDRoger/t3code", "stale"],
    ]);
    expect(view.changes.more).toBe("And 1 more change.");
    expect(
      kinCardView(widget({ type: "memory_changes", state: { items: [] } }), HOST, known()).kind,
    ).toBe("unknown");
    expect(
      kinMemoryUndoFailureText(
        new KinChatError({
          reason: "conflict",
          message: "This changed again since, so it wasn't undone.",
        }),
      ),
    ).toBe("This changed again since, so it wasn't undone.");
  });
});
