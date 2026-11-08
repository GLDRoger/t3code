import { KinChatError, type KinWidget, type KinWidgetsActInput } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  KIN_STALE_CARD_TEXT,
  createKinCardActions,
  formatKinDeferralTime,
  kinDeferralCardView,
  kinDeferralCountdown,
  type KinDeferralTap,
} from "./kinDeferralPresentation";

const DUE = "2026-11-13T09:00:00.000Z";
const deferral = (state: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) =>
  ({
    orgId: "org",
    chatId: "chat",
    widgetId: "deferral:org:def-1",
    messageId: "deferral:org:def-1",
    widgetClass: "native",
    type: "deferral",
    revision: 3,
    state: {
      itemId: "def-1",
      title: "Rate limiting",
      dueAt: DUE,
      onDue: "start",
      text: "Deferred to Fri 13 Nov, 9:00. I'll start then.",
      ...state,
    },
    source: null,
    feed: null,
    awaiting: [],
    pinnedAt: null,
    closedAt: null,
    updatedAt: "2026-11-08T09:00:00.000Z",
    ...overrides,
  }) as unknown as KinWidget;

const view = (w: KinWidget) => {
  const result = kinDeferralCardView(w, "UTC");
  if (result === null) throw new Error("expected a deferral card");
  return result;
};
const actionIds = (w: KinWidget) => view(w).actions.map((action) => action.id);

describe("kinDeferralCardView", () => {
  it("draws each phase with its own actions", () => {
    const confirmed = view(deferral());
    expect(confirmed.phase).toBe("confirmed");
    expect(confirmed.title).toBe("Rate limiting");
    expect(confirmed.lines).toEqual(["Deferred to Fri 13 Nov, 9:00. I'll start then."]);
    expect(actionIds(deferral())).toEqual(["change", "remind"]);
    expect(actionIds(deferral({ onDue: "remind" }))).toEqual(["change"]);
    expect(view(deferral({ onDue: "remind" })).lines).toEqual([
      "Deferred to Fri 13 Nov, 9:00. I'll remind you then.",
    ]);

    const headsUp = view(deferral({ phase: "heads_up", recheck: "Issue #88 is still open." }));
    expect(headsUp.title).toBe("Starting Rate limiting at 9:00");
    expect(headsUp.lines).toEqual(["Issue #88 is still open."]);
    expect(headsUp.countdownTo).toBe(Date.parse(DUE));
    expect(headsUp.actions.map((action) => action.id)).toEqual(["start", "monday", "cancel"]);
    expect(headsUp.actions.find((action) => action.id === "cancel")?.accessibilityLabel).toBe(
      "Cancel deferral",
    );

    const late = view(deferral({ phase: "heads_up", graceEndsAt: "2026-11-13T10:10:00.000Z" }));
    expect(late.title).toBe("Starting Rate limiting at 10:10");
    expect(late.lines).toEqual(["This was due at 9:00."]);
    expect(late.countdownTo).toBe(Date.parse("2026-11-13T10:10:00.000Z"));

    const closed = view(deferral({ phase: "heads_up" }, { closedAt: "2026-11-13T09:00:00.000Z" }));
    expect(closed.phase).toBe("closed");
    expect(closed.actions).toEqual([]);
    expect(closed.countdownTo).toBeNull();
  });

  it("refuses state that isn't a deferral card", () => {
    expect(kinDeferralCardView(deferral({ onDue: "explode" }), "UTC")).toBeNull();
    expect(kinDeferralCardView(deferral({ phase: "done" }), "UTC")).toBeNull();
    expect(kinDeferralCardView(deferral({ dueAt: "Friday" }), "UTC")).toBeNull();
  });

  it("writes times in the given timezone", () => {
    const due = Date.parse(DUE);
    expect(formatKinDeferralTime(due, "UTC")).toBe("Fri 13 Nov, 9:00");
    expect(formatKinDeferralTime(due, "Asia/Kolkata")).toBe("Fri 13 Nov, 14:30");
    expect(formatKinDeferralTime(due, "America/Los_Angeles")).toBe("Fri 13 Nov, 1:00");
    expect(formatKinDeferralTime(due, "Pacific/Auckland")).toBe("Fri 13 Nov, 22:00");
    expect(formatKinDeferralTime(Date.parse("2026-11-13T03:00:00.000Z"), "America/New_York")).toBe(
      "Thu 12 Nov, 22:00",
    );
  });
});

describe("kinDeferralCountdown", () => {
  const due = Date.parse(DUE);
  const at = (minutesBefore: number) => due - minutesBefore * 60_000;
  it.each([
    ["heads_up", 24, "Starts in 24 min unless you stop it"],
    ["heads_up", 1, "Starts in 1 min unless you stop it"],
    ["heads_up", 0.5, "Starts in 1 min unless you stop it"],
    ["heads_up", 0, "Starting now"],
    ["heads_up", -5, "Starting now"],
    ["heads_up", 59, "Starts in 59 min unless you stop it"],
    ["heads_up", 60, "Starts in 1 h unless you stop it"],
    ["heads_up", 65, "Starts in 1 h 5 min unless you stop it"],
    ["confirmed", 24 * 60 - 1, "Due in 23 h 59 min"],
    ["confirmed", 24 * 60, "Due in 1 day"],
    ["confirmed", 3 * 24 * 60 + 30, "Due in 3 days"],
    ["confirmed", 0, "Due now"],
  ] as const)("%s, %s min before due: %s", (phase, minutesBefore, text) => {
    expect(kinDeferralCountdown(phase, due, at(minutesBefore))).toBe(text);
  });
});

describe("createKinCardActions", () => {
  const setup = (respond: () => Promise<{ ok: true } | { ok: false; cause: unknown }>) => {
    const posted: KinWidgetsActInput[] = [];
    let id = 0;
    const act = createKinCardActions({
      newId: () => `client-${++id}`,
      post: (input) => {
        posted.push(input);
        return respond();
      },
    });
    return { posted, act };
  };
  const ok = () => Promise.resolve({ ok: true } as const);

  it.each<[KinDeferralTap, unknown]>([
    [
      { id: "change", dueAt: "2026-11-16T09:00:00.000Z" },
      { itemId: "def-1", dueAt: "2026-11-16T09:00:00.000Z" },
    ],
    [{ id: "remind" }, "def-1"],
    [{ id: "start" }, "def-1"],
    [{ id: "monday" }, "def-1"],
    [{ id: "cancel" }, "def-1"],
  ])("%o posts exactly one action", async (tap, value) => {
    const { posted, act } = setup(ok);
    expect(await act(view(deferral()), tap)).toEqual({ status: "sent" });
    expect(posted).toEqual([
      {
        widgetId: "deferral:org:def-1",
        revision: 3,
        actionId: tap.id,
        value,
        clientActionId: "client-1",
      },
    ]);
  });

  it("posts a double tap once, then takes the next tap with a new id", async () => {
    let release: (value: { ok: true }) => void = () => undefined;
    const { posted, act } = setup(() => new Promise((resolve) => (release = resolve)));
    const started: string[] = [];
    const first = act(view(deferral()), { id: "remind" }, () => started.push("first"));
    const second = await act(view(deferral()), { id: "remind" }, () => started.push("second"));
    expect(second).toEqual({ status: "ignored" });
    release({ ok: true });
    expect(await first).toEqual({ status: "sent" });
    expect(started).toEqual(["first"]);
    expect(posted).toHaveLength(1);

    const third = act(view(deferral()), { id: "remind" });
    release({ ok: true });
    await third;
    expect(posted.map((input) => input.clientActionId)).toEqual(["client-1", "client-2"]);
  });

  it("says the card changed when the host reports a stale revision", async () => {
    const { act } = setup(() =>
      Promise.resolve({
        ok: false,
        cause: new KinChatError({ reason: "widget_changed", message: "Widget revision changed." }),
      }),
    );
    expect(await act(view(deferral()), { id: "start" })).toEqual({
      status: "failed",
      notice: { kind: "stale", text: KIN_STALE_CARD_TEXT },
    });
  });

  it("shows a refusal or a dropped connection as an error, and frees the card", async () => {
    const refused = setup(() =>
      Promise.resolve({
        ok: false,
        cause: new KinChatError({ reason: "not_allowed", message: "Chat operation not allowed." }),
      }),
    );
    expect(await refused.act(view(deferral()), { id: "remind" })).toEqual({
      status: "failed",
      notice: {
        kind: "error",
        text: "Kin didn't take that answer. Tell your lead in the chat instead.",
      },
    });
    const dropped = setup(() => Promise.reject(new Error("Connection lost.")));
    expect(await dropped.act(view(deferral()), { id: "remind" })).toEqual({
      status: "failed",
      notice: { kind: "error", text: "Connection lost." },
    });
    expect((await dropped.act(view(deferral()), { id: "remind" })).status).toBe("failed");
    expect(dropped.posted).toHaveLength(2);
  });
});
