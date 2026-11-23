import { KIN_CHECK_CONNECTION } from "./kinAnswers.ts";
import {
  KIN_ASKER_ONLY_REFUSAL,
  KinChatError,
  KinDeferralCard,
  kinAgentPausedRefusal,
  type KinWidget,
  type KinWidgetsActInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  KIN_CHANGE_SENT_TEXT,
  KIN_SEND_FAILED_TEXT,
  KIN_SENT_CARD_TEXT,
  KIN_STALE_CARD_TEXT,
  KIN_UNDO_TOO_LATE_TEXT,
  createKinCardActions,
  kinActionFailureNotice,
  kinDeferralActInput,
  formatKinDeferralClock,
  formatKinDeferralTime,
  kinCardStatusAfter,
  kinDeferralCardView,
  kinDeferralCountdown,
  visibleKinCardStatus,
  type KinDeferralActionId,
  kinDeferralIsBookkeeping,
} from "./kinDeferralPresentation.ts";

// The card as a phone build from before `actions` decodes it.
const { actions: _actions, ...olderFields } = KinDeferralCard.fields;
const decodeOlderCard = Schema.decodeUnknownSync(Schema.Struct(olderFields));

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
      text: "Deferred to Fri, Nov 13, 9:00 AM. I'll start then.",
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

const view = (w: KinWidget, ownerLevel?: boolean) => {
  const result = kinDeferralCardView(w, "UTC", ownerLevel);
  if (result === null) throw new Error("expected a deferral card");
  return result;
};
const actionIds = (w: KinWidget, ownerLevel?: boolean) =>
  view(w, ownerLevel).actions.map((action) => action.id);

describe("kinDeferralCardView", () => {
  it("draws the confirmed card and its closed state", () => {
    const confirmed = view(deferral());
    expect(confirmed.phase).toBe("confirmed");
    expect(confirmed.title).toBe("Rate limiting");
    // The host's own "Deferred to …" text repeats the local line, so it is dropped.
    expect(confirmed.lines).toEqual([
      "Set for Fri, Nov 13, 9:00 AM. I'll ask you to start it then.",
    ]);
    expect(confirmed.eyebrow).toBe("Scheduled");
    expect(view(deferral({ onDue: "remind" })).eyebrow).toBe("Reminder");
    expect(confirmed.countdown).toEqual({ to: Date.parse(DUE), kind: "due" });
    expect(view(deferral({ onDue: "remind", text: "" })).lines).toEqual([
      "Set for Fri, Nov 13, 9:00 AM. I'll remind you then.",
    ]);
    expect(
      view(deferral({ onDue: "remind", text: "", askedBy: { personId: "dev", name: "Dev" } }))
        .lines,
    ).toEqual(["Set for Fri, Nov 13, 9:00 AM. I'll remind this chat then.", "Asked by Dev."]);
    expect(view(deferral({ text: "Waiting on the API review." })).lines).toEqual([
      "Set for Fri, Nov 13, 9:00 AM. I'll ask you to start it then.",
      "Waiting on the API review.",
    ]);

    const closed = view(deferral({}, { closedAt: "2026-11-13T09:00:00.000Z" }));
    expect(closed.phase).toBe("closed");
    expect(closed.actions).toEqual([]);
    expect(closed.countdown).toBeNull();
    expect(view(deferral({ phase: "heads_up" }, { closedAt: DUE })).actions).toEqual([]);
  });

  const DECIDE = ["start_now", "monday", "cancel"];
  it.each([
    ["an older host's confirm", {}, undefined, ["undo"]],
    ["an older host's heads_up", { phase: "heads_up" }, undefined, []],
    ["an older host's asked", { phase: "asked" }, undefined, []],
    ["confirm", { actions: ["undo"] }, undefined, ["undo"]],
    ["confirm, to a teammate", { actions: ["undo"] }, false, ["undo"]],
    ["heads_up", { phase: "heads_up", actions: DECIDE }, undefined, DECIDE],
    ["asked", { phase: "asked", actions: DECIDE }, true, DECIDE],
    [
      "asked that can't start",
      { phase: "asked", actions: ["monday", "cancel"] },
      true,
      ["monday", "cancel"],
    ],
    ["asked, to a teammate", { phase: "asked", actions: DECIDE }, false, []],
    [
      "asked, with a tap this build doesn't know",
      { phase: "asked", actions: ["later", "cancel"] },
      true,
      ["cancel"],
    ],
    ["started", { phase: "started", actions: [] }, undefined, []],
  ])("offers the host's actions on %s card", (_name, state, ownerLevel, ids) => {
    expect(actionIds(deferral(state), ownerLevel)).toEqual(ids);
  });

  it("an older build's card schema still reads a card that lists its actions", () => {
    const state = deferral({ phase: "asked", actions: DECIDE }).state;
    expect(decodeOlderCard(state)).not.toHaveProperty("actions");
  });

  const GRACE = "2026-11-13T09:30:00.000Z";
  it.each([
    [
      "heads_up names the start time, not the host's owner-zone text",
      { phase: "heads_up", text: "Starting Rate limiting at 9:00." },
      ["Starting at 9:00 AM."],
      { to: Date.parse(DUE), kind: "start" },
    ],
    [
      "heads_up in the grace window says it was due, and when it starts",
      {
        phase: "heads_up",
        graceEndsAt: GRACE,
        text: "Starting Rate limiting at 9:30. This was due at 9:00 AM.",
      },
      ["This was due at 9:00 AM.", "Starting at 9:30 AM."],
      { to: Date.parse(GRACE), kind: "start" },
    ],
    [
      "asked shows the host's text, which names what changed",
      {
        phase: "asked",
        text: "Rate limiting is due at 9:00 AM. Start it, move it to Monday, or cancel it? I won't start it on my own: Kin is at L1, below L2.",
      },
      [
        "Rate limiting is due at 9:00 AM. Start it, move it to Monday, or cancel it? I won't start it on my own: Kin is at L1, below L2.",
      ],
      null,
    ],
    [
      "asked without text still asks",
      { phase: "asked", text: "" },
      ["Due at Fri, Nov 13, 9:00 AM. Start it, move it to Monday, or cancel it?"],
      null,
    ],
    ["started", { phase: "started", text: "" }, ["Asked your agent to start it."], null],
    [
      "started says who was asked, as the host wrote it",
      { phase: "started", text: "Asked Lead to start it.", agent: "Lead" },
      ["Asked Lead to start it."],
      null,
    ],
  ])("%s", (_name, state, lines, countdown) => {
    const card = view(deferral(state));
    expect(card.lines).toEqual(lines);
    expect(card.countdown).toEqual(countdown);
    expect(card.phase).toBe(state.phase);
  });

  it("titles a decision card, and reads each line once", () => {
    const asked = view(deferral({ phase: "asked", text: "Due at 9:00. Start it?" }));
    expect(asked.eyebrow).toBe("Needs your decision");
    expect(asked.accessibilityLabel).toBe("Scheduled: Rate limiting. Due at 9:00. Start it?");
    expect(view(deferral({ text: "Waiting on lane A…" })).accessibilityLabel).toBe(
      "Scheduled: Rate limiting. Set for Fri, Nov 13, 9:00 AM. I'll ask you to start it then. Waiting on lane A…",
    );
  });

  it("treats Kin's own note as bookkeeping, but not a card that needs a decision", () => {
    expect(kinDeferralIsBookkeeping(deferral({ onDue: "remind" }))).toBe(true);
    expect(kinDeferralIsBookkeeping(deferral({ phase: "started" }))).toBe(true);
    expect(kinDeferralIsBookkeeping(deferral({ phase: "asked" }))).toBe(false);
    expect(kinDeferralIsBookkeeping(deferral({ phase: "heads_up" }))).toBe(false);
    expect(kinDeferralIsBookkeeping(deferral({ phase: "asked" }, { closedAt: DUE }))).toBe(true);
  });

  it("refuses state that isn't a deferral card", () => {
    expect(kinDeferralCardView(deferral({ onDue: "explode" }), "UTC")).toBeNull();
    expect(kinDeferralCardView(deferral({ dueAt: "Friday" }), "UTC")).toBeNull();
    expect(kinDeferralCardView(deferral({ text: undefined }), "UTC")).toBeNull();
  });

  it("writes times in the given timezone", () => {
    const due = Date.parse(DUE);
    expect(formatKinDeferralTime(due, "UTC")).toBe("Fri, Nov 13, 9:00 AM");
    expect(formatKinDeferralTime(due, "Asia/Kolkata")).toBe("Fri, Nov 13, 2:30 PM");
    expect(formatKinDeferralTime(due, "America/Los_Angeles")).toBe("Fri, Nov 13, 1:00 AM");
    expect(formatKinDeferralTime(due, "Pacific/Auckland")).toBe("Fri, Nov 13, 10:00 PM");
    expect(formatKinDeferralTime(Date.parse("2026-11-13T03:00:00.000Z"), "America/New_York")).toBe(
      "Thu, Nov 12, 10:00 PM",
    );
  });

  it("never reads formatToParts, which Hermes returns without hour and minute", () => {
    using _parts = vi
      .spyOn(Intl.DateTimeFormat.prototype, "formatToParts")
      .mockReturnValue([{ type: "literal", value: "?" }]);
    expect(formatKinDeferralTime(Date.parse(DUE), "Europe/Lisbon")).toBe("Fri, Nov 13, 9:00 AM");
    expect(formatKinDeferralClock(Date.parse("2026-11-13T23:05:00.000Z"), "UTC")).toBe("11:05 PM");
  });

  it("follows the device when its timezone changes", () => {
    const due = Date.parse(DUE);
    const original = process.env.TZ;
    try {
      process.env.TZ = "UTC";
      expect(formatKinDeferralTime(due)).toBe("Fri, Nov 13, 9:00 AM");
      process.env.TZ = "Asia/Kolkata";
      expect(formatKinDeferralTime(due)).toBe("Fri, Nov 13, 2:30 PM");
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
});

describe("kinDeferralCountdown", () => {
  const due = Date.parse(DUE);
  const at = (minutesBefore: number) => due - minutesBefore * 60_000;
  it.each([
    [24, "Due in 24 min"],
    [0.5, "Due in 1 min"],
    [59, "Due in 59 min"],
    [60, "Due in 1 h"],
    [65, "Due in 1 h 5 min"],
    [24 * 60 - 1, "Due in 23 h 59 min"],
    [24 * 60, "Due in 1 day"],
    [3 * 24 * 60 + 30, "Due in 3 days"],
    [0, "Due now"],
    [-5, "Due now"],
  ] as const)("%s min before due: %s", (minutesBefore, text) => {
    expect(kinDeferralCountdown(due, at(minutesBefore))).toBe(text);
  });

  it.each([
    [12, "Starting in 12 min"],
    [0, "Starting now"],
  ] as const)("%s min before a heads-up start: %s", (minutesBefore, text) => {
    expect(kinDeferralCountdown(due, at(minutesBefore), "start")).toBe(text);
  });
});

describe("createKinCardActions", () => {
  type Reply = { ok: true } | { ok: false; cause: unknown };
  const setup = (respond: (call: number) => Promise<Reply>) => {
    const posted: KinWidgetsActInput[] = [];
    let id = 0;
    const act = createKinCardActions({
      toInput: kinDeferralActInput,
      failureNotice: kinActionFailureNotice,
      newId: () => `client-${++id}`,
      post: (input) => {
        posted.push(input);
        return respond(posted.length);
      },
    });
    return { posted, act };
  };
  const ok = () => Promise.resolve({ ok: true } as const);
  const refused = (
    reason: "widget_changed" | "not_allowed" | "invalid_state",
    message = "Refused.",
  ) =>
    Promise.resolve({
      ok: false,
      cause: new KinChatError({ reason, message }),
    } as const);
  const dropped = () => Promise.reject(new Error("socket hang up ECONNRESET"));

  it.each<[KinDeferralActionId, Record<string, unknown>]>([
    ["undo", {}],
    ["change", {}],
    ["remind", {}],
    ["start_now", { phase: "heads_up" }],
    ["monday", { phase: "asked" }],
    ["cancel", { phase: "asked" }],
  ])("%s posts exactly one action with the item id", async (actionId, state) => {
    const { posted, act } = setup(ok);
    expect(await act(view(deferral(state)), actionId)).toEqual({ status: "sent" });
    expect(posted).toEqual([
      {
        widgetId: "deferral:org:def-1",
        revision: 3,
        actionId,
        value: "def-1",
        clientActionId: "client-1",
      },
    ]);
  });

  it("posts a double tap once, then takes the next tap with a new id", async () => {
    let release: (value: { ok: true }) => void = () => undefined;
    const { posted, act } = setup(() => new Promise((resolve) => (release = resolve)));
    const started: string[] = [];
    const first = act(view(deferral()), "remind", () => started.push("first"));
    const second = await act(view(deferral()), "remind", () => started.push("second"));
    expect(second).toEqual({ status: "ignored" });
    release({ ok: true });
    expect(await first).toEqual({ status: "sent" });
    expect(started).toEqual(["first"]);
    expect(posted).toHaveLength(1);

    const third = act(view(deferral()), "remind");
    release({ ok: true });
    await third;
    expect(posted.map((input) => input.clientActionId)).toEqual(["client-1", "client-2"]);
  });

  it.each<[string, ReadonlyArray<(call: number) => Promise<Reply>>, KinWidget[], string[]]>([
    [
      "a retry after a dropped send reuses its id",
      [dropped, ok],
      [deferral(), deferral()],
      ["client-1", "client-1"],
    ],
    [
      "a host failure without a Kin reason counts as dropped",
      [() => Promise.resolve({ ok: false, cause: new Error("x") }), ok],
      [deferral(), deferral()],
      ["client-1", "client-1"],
    ],
    [
      "a retry after a refusal gets a new id",
      [() => refused("not_allowed"), ok],
      [deferral(), deferral()],
      ["client-1", "client-2"],
    ],
    [
      "a retry on a newer revision gets a new id",
      [dropped, ok],
      [deferral(), deferral({}, { revision: 4 })],
      ["client-1", "client-2"],
    ],
  ])("%s", async (_name, replies, cards, ids) => {
    const { posted, act } = setup((call) => replies[call - 1]!(call));
    for (const card of cards) await act(view(card), "remind");
    expect(posted.map((input) => input.clientActionId)).toEqual(ids);
  });

  it("gives a different action its own id after a dropped send", async () => {
    const { posted, act } = setup((call) => (call === 1 ? dropped() : ok()));
    await act(view(deferral()), "remind");
    await act(view(deferral()), "change");
    expect(posted.map((input) => input.clientActionId)).toEqual(["client-1", "client-2"]);
  });

  it("says the card changed when the host reports a stale revision, and marks it behind", async () => {
    const { act } = setup(() => refused("widget_changed"));
    expect(await act(view(deferral()), "remind")).toEqual({
      status: "failed",
      notice: { kind: "stale", text: KIN_STALE_CARD_TEXT },
      behind: true,
    });
    const late = setup(() => refused("invalid_state"));
    expect(await late.act(view(deferral()), "undo")).toEqual({
      status: "failed",
      notice: { kind: "stale", text: KIN_UNDO_TOO_LATE_TEXT },
    });
  });

  it("shows a refusal or a dropped connection as an error, never the raw cause", async () => {
    const refusal = setup(() => refused("not_allowed"));
    expect(await refusal.act(view(deferral()), "remind")).toEqual({
      status: "failed",
      notice: {
        kind: "error",
        text: "Kin didn't take that answer. Tell your agent in the chat instead.",
      },
    });
    // A shared chat's own, tapped by someone who didn't ask: the host's words, as they are.
    const notAsker = setup(() => refused("not_allowed", KIN_ASKER_ONLY_REFUSAL));
    expect(await notAsker.act(view(deferral()), "undo")).toEqual({
      status: "failed",
      notice: { kind: "error", text: KIN_ASKER_ONLY_REFUSAL },
    });
    const lost = setup(dropped);
    expect(await lost.act(view(deferral()), "remind")).toEqual({
      status: "failed",
      notice: { kind: "error", text: `${KIN_SEND_FAILED_TEXT} ${KIN_CHECK_CONNECTION}` },
    });
    expect((await lost.act(view(deferral()), "remind")).status).toBe("failed");
    expect(lost.posted).toHaveLength(2);
  });
});

describe("kinCardStatusAfter", () => {
  it("keeps the card usable after Change and holds it after remind", () => {
    expect(kinCardStatusAfter({ status: "sent" }, "change", 3)).toEqual({
      revision: 3,
      notice: { kind: "sent", text: KIN_CHANGE_SENT_TEXT },
      holding: false,
    });
    expect(kinCardStatusAfter({ status: "sent" }, "remind", 3)).toEqual({
      revision: 3,
      notice: { kind: "sent", text: KIN_SENT_CARD_TEXT },
      holding: true,
    });
    const notice = { kind: "error", text: KIN_SEND_FAILED_TEXT } as const;
    expect(kinCardStatusAfter({ status: "failed", notice }, "remind", 3).holding).toBe(false);
  });

  // Kin finishes these itself: no agent will update the card. A start's turn may still wait.
  it.each<[KinDeferralActionId, string | null, string]>([
    ["start_now", "Lead", "Asked Lead to start it."],
    ["start_now", null, "Asked your agent to start it."],
    ["monday", null, "Moved to Monday."],
    ["cancel", null, "Cancelled."],
  ])("holds the card after %s (%s) until the host rewrites it", (actionId, agent, text) => {
    expect(kinCardStatusAfter({ status: "sent" }, actionId, 3, agent)).toEqual({
      revision: 3,
      notice: { kind: "sent", text },
      holding: true,
    });
  });

  // Another screen moved the card before this tap's refusal came back: the person still hears it.
  it("keeps a refusal past a new revision, and hides what was sent once the card moves", () => {
    const status = kinCardStatusAfter(
      { status: "failed", notice: { kind: "stale", text: KIN_STALE_CARD_TEXT } },
      "remind",
      3,
    );
    expect(visibleKinCardStatus(status, 3)).toBe(status);
    expect(visibleKinCardStatus(status, 4)).toBe(status);
    const held = kinCardStatusAfter({ status: "sent" }, "remind", 3);
    expect(visibleKinCardStatus(held, 4)).toBeNull();
  });

  it("says a paused agent's refusal in its own words", () => {
    const cause = new KinChatError({
      reason: "invalid_state",
      message: kinAgentPausedRefusal("Lead"),
    });
    expect(kinActionFailureNotice(cause).text).toBe("Lead is paused. Resume it, then start this.");
    expect(
      kinActionFailureNotice(new KinChatError({ reason: "invalid_state", message: "Nope." })).text,
    ).toBe("This card can't take that answer any more.");
  });
});
