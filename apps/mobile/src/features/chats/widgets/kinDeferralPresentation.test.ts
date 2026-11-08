import { KinChatError, type KinWidget, type KinWidgetsActInput } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  KIN_CHANGE_SENT_TEXT,
  KIN_SEND_FAILED_TEXT,
  KIN_SENT_CARD_TEXT,
  KIN_STALE_CARD_TEXT,
  createKinCardActions,
  formatKinDeferralTime,
  kinCardStatusAfter,
  kinDeferralCardView,
  kinDeferralCountdown,
  visibleKinCardStatus,
  type KinDeferralActionId,
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
  it("draws the confirmed card and its closed state", () => {
    const confirmed = view(deferral());
    expect(confirmed.phase).toBe("confirmed");
    expect(confirmed.title).toBe("Rate limiting");
    expect(confirmed.lines).toEqual(["Deferred to Fri 13 Nov, 9:00. I'll start then."]);
    expect(confirmed.countdownTo).toBe(Date.parse(DUE));
    expect(actionIds(deferral())).toEqual(["change", "remind"]);
    expect(actionIds(deferral({ onDue: "remind" }))).toEqual(["change"]);
    expect(view(deferral({ onDue: "remind", text: "" })).lines).toEqual([
      "Deferred to Fri 13 Nov, 9:00. I'll remind you then.",
    ]);
    expect(view(deferral({ text: "Waiting on the API review." })).lines).toEqual([
      "Deferred to Fri 13 Nov, 9:00. I'll start then.",
      "Waiting on the API review.",
    ]);

    const closed = view(deferral({}, { closedAt: "2026-11-13T09:00:00.000Z" }));
    expect(closed.phase).toBe("closed");
    expect(closed.actions).toEqual([]);
    expect(closed.countdownTo).toBeNull();
  });

  it("refuses state that isn't a deferral card", () => {
    expect(kinDeferralCardView(deferral({ onDue: "explode" }), "UTC")).toBeNull();
    expect(kinDeferralCardView(deferral({ dueAt: "Friday" }), "UTC")).toBeNull();
    expect(kinDeferralCardView(deferral({ text: undefined }), "UTC")).toBeNull();
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

  it("follows the device when its timezone changes", () => {
    const due = Date.parse(DUE);
    const original = process.env.TZ;
    try {
      process.env.TZ = "UTC";
      expect(formatKinDeferralTime(due)).toBe("Fri 13 Nov, 9:00");
      process.env.TZ = "Asia/Kolkata";
      expect(formatKinDeferralTime(due)).toBe("Fri 13 Nov, 14:30");
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
});

describe("createKinCardActions", () => {
  type Reply = { ok: true } | { ok: false; cause: unknown };
  const setup = (respond: (call: number) => Promise<Reply>) => {
    const posted: KinWidgetsActInput[] = [];
    let id = 0;
    const act = createKinCardActions({
      newId: () => `client-${++id}`,
      post: (input) => {
        posted.push(input);
        return respond(posted.length);
      },
    });
    return { posted, act };
  };
  const ok = () => Promise.resolve({ ok: true } as const);
  const refused = (reason: "widget_changed" | "not_allowed") =>
    Promise.resolve({
      ok: false,
      cause: new KinChatError({ reason, message: "Refused." }),
    } as const);
  const dropped = () => Promise.reject(new Error("socket hang up ECONNRESET"));

  it.each<KinDeferralActionId>(["change", "remind"])(
    "%s posts exactly one action with the item id",
    async (actionId) => {
      const { posted, act } = setup(ok);
      expect(await act(view(deferral()), actionId)).toEqual({ status: "sent" });
      expect(posted).toEqual([
        {
          widgetId: "deferral:org:def-1",
          revision: 3,
          actionId,
          value: "def-1",
          clientActionId: "client-1",
        },
      ]);
    },
  );

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

  it("says the card changed when the host reports a stale revision", async () => {
    const { act } = setup(() => refused("widget_changed"));
    expect(await act(view(deferral()), "remind")).toEqual({
      status: "failed",
      notice: { kind: "stale", text: KIN_STALE_CARD_TEXT },
    });
  });

  it("shows a refusal or a dropped connection as an error, never the raw cause", async () => {
    const refusal = setup(() => refused("not_allowed"));
    expect(await refusal.act(view(deferral()), "remind")).toEqual({
      status: "failed",
      notice: {
        kind: "error",
        text: "Kin didn't take that answer. Tell your lead in the chat instead.",
      },
    });
    const lost = setup(dropped);
    expect(await lost.act(view(deferral()), "remind")).toEqual({
      status: "failed",
      notice: { kind: "error", text: KIN_SEND_FAILED_TEXT },
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

  it("hides a notice once the card moves to a new revision", () => {
    const status = kinCardStatusAfter(
      { status: "failed", notice: { kind: "stale", text: KIN_STALE_CARD_TEXT } },
      "remind",
      3,
    );
    expect(visibleKinCardStatus(status, 3)).toBe(status);
    expect(visibleKinCardStatus(status, 4)).toBeNull();
    const held = kinCardStatusAfter({ status: "sent" }, "remind", 3);
    expect(visibleKinCardStatus(held, 4)).toBeNull();
  });
});
