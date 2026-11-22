// @effect-diagnostics globalDate:off - Fixtures read a thread date against a fixed now.
import {
  formatKinWhen,
  KinChatError,
  KinPersonId,
  type EnvironmentId,
  type KinWidget,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  kinCardDraws,
  kinCardView,
  kinIsBookkeeping,
  kinReminderCardView,
  kinScheduledTaskCardView,
} from "./kinCardPresentation.ts";
import {
  kinChoiceAccessibilityLabel,
  kinChoiceActInput,
  kinChoiceCardActions,
  kinChoiceCardTaps,
  kinChoiceOutcomeSentence,
  kinChoiceAnswered,
  kinChoiceFailureNotice,
  kinChoicePhase,
  kinChoiceDecidedLine,
  kinChoiceDismissedLine,
  kinChoiceDismissible,
  kinChoiceDismissInput,
  kinChoiceUndoneLine,
  createKinHeldPress,
  kinMailCancels,
  kinQuotedInZone,
  kinAddressPieces,
  kinSendEditFailure,
  kinSendEditBound,
  kinSendEditHeld,
  kinSendEditHeldKey,
  kinSendEditControls,
  kinSendEditDiscardInput,
  kinSendEditedLine,
  kinSendEditInput,
  KIN_SEND_COPY,
  kinSendEditKept,
  kinSendEditLeaveSaves,
  kinSendEditOffered,
  kinSendEditRefused,
  kinSendEditSaveInput,
  kinSendEditShown,
  kinSendEditStart,
  kinMayHaveGoneLine,
  kinSendCheckPending,
  kinSendTicked,
  kinSendTry,
  kinSendEditWarned,
  kinThreadDate,
  type KinChoiceCardStatus,
  type KinSendEditing,
} from "./kinChoicePresentation.ts";
import { kinListedModelName } from "./kinLeadPresentation.ts";
import { formatKinTime } from "./kinScreenState.ts";
import { kinCardStatusAfter, kinDeferralCountdown } from "./kinDeferralPresentation.ts";
import { kinMemoryUndoFailureText } from "./kinMemoryChangesPresentation.ts";

const taskState = (overrides: Record<string, unknown> = {}) => ({
  taskId: "task-1",
  environmentId: "env-home",
  threadId: "thread-1",
  remoteEnvironmentId: null,
  title: "Fix the payments test",
  model: "gpt-6.1-sol",
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
// The name Settings shows for a model; an id no provider lists has none.
const PROVIDERS = [{ models: [{ slug: "gpt-6.1-sol", name: "GPT-6.1 Sol" }] }];
const modelName = (model: string) => kinListedModelName(model, PROVIDERS);
const task = (w: KinWidget, isKnown = known("env-home", "env-vps", "env-other")) => {
  const view = kinCardView(w, HOST, isKnown, null, undefined, modelName);
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
    // A card this build can't draw says what it would have, never something about the app.
    const poll = widget({ type: "poll", state: { title: "  Lunch on\nFriday? ", options: [] } });
    expect(kinCardView(poll, HOST, known())).toEqual({ kind: "unknown", text: "Lunch on Friday?" });
    expect(kinCardView(widget({ type: "poll", state: { options: [] } }), HOST, known())).toEqual({
      kind: "unknown",
      text: null,
    });
    // A chart from a newer host, of a kind this build can't draw, still says its title.
    const pie = widget({ type: "chart", state: { chart: "pie", title: "Spend by team" } });
    expect(kinCardView(pie, HOST, known())).toEqual({ kind: "unknown", text: "Spend by team" });
    // A visual holds no markup, only where its page is; one this build can't read says its title.
    const visual = { title: "Signup funnel", attachmentId: "kin-chat-1-html", height: 360 };
    expect(kinCardView(widget({ type: "visual", state: visual }), HOST, known())).toMatchObject({
      kind: "visual",
      visual,
    });
    expect(
      kinCardView(
        widget({ type: "visual", state: { ...visual, attachmentId: "", html: "<b>x</b>" } }),
        HOST,
        known(),
      ),
    ).toEqual({ kind: "unknown", text: "Signup funnel" });
    // Beside the message's own text the card adds nothing; with no words at all it isn't drawn.
    expect(kinCardDraws(poll, HOST, false)).toBe(true);
    expect(kinCardDraws(poll, HOST, true)).toBe(false);
    expect(kinCardDraws(widget({ type: "poll", state: {} }), HOST, false)).toBe(false);
    expect(kinCardDraws(widget(), HOST, true)).toBe(true);
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

  it("says why a failed task stopped in plain words, and shows any other error as it is", () => {
    const error = { lastError: "Tests failed\n\n  3 of 120" };
    const lines = (overrides: Record<string, unknown>) => {
      const view = task(widget({ state: taskState(overrides) }));
      return [view.detail, view.detailNote];
    };
    expect(lines({ ...error, status: "failed" })).toEqual([
      "The helper stopped with an error.",
      "Tests failed 3 of 120",
    ]);
    expect(lines({ ...error, status: "failed", failure: null })).toEqual([
      "The helper stopped with an error.",
      "Tests failed 3 of 120",
    ]);
    expect(lines({ status: "failed" })).toEqual(["The helper stopped with an error.", null]);
    expect(lines({ ...error, status: "cancelled" })).toEqual(["Tests failed 3 of 120", null]);
    const stopped = { status: "failed", lastError: "API Error: 400 no route for invented-model" };
    expect(lines({ ...stopped, failure: "model_not_offered" })).toEqual([
      "This server's AI provider doesn't offer the model this task asked for. Ask the agent to start it again on its own model.",
      null,
    ]);
    expect(lines({ ...stopped, failure: "signed_out" })).toEqual([
      "This server's AI provider is signed out. Sign it in again in Settings, then ask the agent to start the task again.",
      null,
    ]);
    expect(lines({ ...stopped, failure: "unreachable" })).toEqual([
      "This server couldn't reach its AI provider. Ask the agent to start the task again in a few minutes.",
      null,
    ]);
    expect(lines({ ...stopped, failure: "usage_limit" })).toEqual([
      "The AI provider's usage limit is reached. Ask the agent to start the task again once it resets.",
      null,
    ]);
  });

  it.each([
    ["no error", {}, "Task: Fix the payments test. Working. GPT-6.1 Sol. Opens the thread."],
    [
      "an error that ends a sentence",
      { status: "failed", lastError: "Tests also fail." },
      "Task: Fix the payments test. Failed. The helper stopped with an error. Tests also fail. GPT-6.1 Sol. Opens the thread.",
    ],
    [
      "a title that ends a question",
      { title: "Why is CI red?", model: null },
      "Task: Why is CI red? Working. Opens the thread.",
    ],
    [
      "a model Settings has no name for, shown as nothing rather than its raw id",
      { model: "claude-sonnet-5-5" },
      "Task: Fix the payments test. Working. Opens the thread.",
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
  it("shows a reply's thread date in the reader's zone, and none the provider didn't give", () => {
    const now = new Date("2026-11-16T12:00:00Z");
    const gmail = kinThreadDate("Mon, 9 Nov 2026 10:22:00 +0530", now);
    expect(gmail).toBe(formatKinTime(new Date("2026-11-09T04:52:00Z"), now));
    expect(gmail).not.toContain("+0530");
    expect(kinThreadDate("2026-11-09T04:52:00.000Z", now)).toBe(gmail);
    expect(kinThreadDate("1970-01-01T00:00:00.001Z", now)).toBeNull();
    expect(kinThreadDate("sometime last week", now)).toBeNull();
    expect(kinThreadDate(null, now)).toBeNull();
    // The quote under a reply names the same date the way a person reads it, not the header.
    const raw = "Mon, 16 Nov 2026 06:49:41 +0000";
    const quoted = kinQuotedInZone(
      `On ${raw}, Anita <anita@orbitdental.example> wrote:\n> Paid`,
      raw,
    );
    expect(quoted).not.toContain("+0000");
    expect(quoted).toMatch(/^On .*2026 at .*, Anita <anita@orbitdental\.example> wrote:\n> Paid$/);
    expect(kinQuotedInZone("On someday, Anita wrote:", "someday")).toBe("On someday, Anita wrote:");
    // A long address may break after "@" or a dot, never mid-word; other words stay whole.
    const line = "Rhea <accounts.payable@orbitdental.example>, Ambermill Ltd.";
    expect(kinAddressPieces(line)).toEqual([
      "Rhea",
      " ",
      "<accounts.",
      "payable@",
      "orbitdental.",
      "example>,",
      " ",
      "Ambermill",
      " ",
      "Ltd.",
    ]);
    expect(kinAddressPieces(line).join("")).toBe(line);
  });

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
    // An option that runs an action is labelled by the server and shows its line under it; the
    // card's text no longer repeats the line it carries for older clients.
    const acts = choice({
      state: {
        ...choiceState(),
        detail: "Dev says it is live.\n\nMark W-4 done: Mark W-4 “Ship the API” done",
        options: [
          {
            optionId: "option-1",
            label: "Mark W-4 done",
            action: { line: "Mark W-4 “Ship the API” done" },
          },
          { optionId: "option-2", label: "Wait" },
        ],
      },
    });
    expect(acts.options).toEqual([
      {
        id: "option-1",
        label: "Mark W-4 done",
        action: "Mark W-4 “Ship the API” done",
        kind: null,
      },
      { id: "option-2", label: "Wait", action: null, kind: null },
    ]);
    expect(acts.detail).toBe("Dev says it is live.");
    expect(open.askedBy).toBeNull();
    // Asked for someone else, who asks comes first; the line `detail` repeats is shown once.
    const askedFor = (detail: string) =>
      choice({
        state: { ...choiceState(), askedBy: "Zoya Sheikh asks, through Chief of staff.", detail },
      });
    const forZoya = askedFor(
      "Zoya Sheikh asks, through Chief of staff.\n\nThe pilot clinics wait on it.",
    );
    expect([forZoya.askedBy, forZoya.question, forZoya.detail]).toEqual([
      "Zoya Sheikh asks, through Chief of staff.",
      "Ship today?",
      "The pilot clinics wait on it.",
    ]);
    expect(askedFor("Zoya Sheikh asks, through Chief of staff.").detail).toBeNull();
    expect(kinChoiceAccessibilityLabel(forZoya, null)).toMatch(
      /^Question\. Zoya Sheikh asks, through Chief of staff\. Ship today\?/,
    );
    // What holds only while nobody has chosen shows while open, on no settled copy.
    const waiting = "Until someone chooses, they stay in Zoya's name and can still be found.";
    const handOver = (change: Record<string, unknown>, state: Record<string, unknown> = {}) =>
      choice({
        ...change,
        state: { ...choiceState(), detail: waiting, whileOpen: waiting, ...state },
      }).detail;
    const given = { title: "Given to Meera", text: "Meera now looks after 2 clients." };
    const tapped = {
      optionId: "option-1",
      personId: "rhea",
      via: "tap",
      emoji: null,
      answeredAt: "2026-11-08T09:01:00.000Z",
    };
    expect(handOver({})).toBe(waiting);
    expect(handOver({}, { answer: tapped, outcome: given })).toBeNull();
    expect(handOver({ closedAt: "2026-11-08T09:01:00.000Z" }, { outcome: given })).toBeNull();
    expect(kinChoicePhase(open, posted + 60_000)).toBe("open");
    expect(kinChoicePhase(open, posted + 24 * 60 * 60 * 1000)).toBe("expired");
    expect(kinChoicePhase(choice({ closedAt: "2026-11-08T10:00:00.000Z" }), posted)).toBe(
      "expired",
    );
    expect(choice().closedText).toBe("This question expired. Answer in the chat instead.");
    const replaced = choice({
      closedAt: "2026-11-08T10:00:00.000Z",
      state: { ...choiceState(), replaced: true },
    });
    expect([kinChoicePhase(replaced, posted), replaced.closedText]).toEqual([
      "expired",
      "Replaced by a newer one.",
    ]);
    // Dismissed by the person it asked: "Dismissed" with Undo for them, who did it for others.
    const rhea = KinPersonId.make("rhea");
    const meera = KinPersonId.make("meera");
    const dismissed = choice({
      closedAt: "2026-11-08T10:00:00.000Z",
      state: {
        ...choiceState(),
        dismissed: { personId: "rhea", name: "Rhea Rao", at: "2026-11-08T10:00:00.000Z" },
      },
    });
    expect(kinChoicePhase(dismissed, posted)).toBe("dismissed");
    expect(kinChoiceDismissedLine(dismissed, rhea)).toEqual({ text: "Dismissed", undo: true });
    expect(kinChoiceDismissedLine(dismissed, meera)).toEqual({
      text: "Dismissed by Rhea Rao",
      undo: false,
    });
    expect(kinChoiceDismissedLine(open, rhea)).toBeNull();
    // Offered only on an open card that asks the viewer; a Confirm card keeps its own Cancel.
    const asks = choice({ awaiting: [rhea] });
    const confirm = choice({
      awaiting: [rhea],
      state: {
        ...choiceState(),
        send: {
          service: "Gmail",
          action: "email",
          from: "rhea@ambermill.example",
          to: ["anita@orbitdental.example"],
          cc: [],
          subject: "Invoice",
          body: "Attached.",
          attachments: [],
          outcome: null,
        },
      },
    });
    expect([
      kinChoiceDismissible(asks, "open", rhea),
      kinChoiceDismissible(asks, "open", meera),
      kinChoiceDismissible(asks, "expired", rhea),
      kinChoiceDismissible(confirm, "open", rhea),
    ]).toEqual([true, false, false, false]);
    expect(kinChoiceDismissInput(asks, true, "undo-1")).toEqual({
      widgetId: asks.widgetId,
      revision: asks.revision,
      actionId: "undismiss",
      clientActionId: "undo-1",
    });
    // Once the newer card is answered, the one it replaced says who chose what on it.
    const told = choice({
      closedAt: "2026-11-08T10:00:00.000Z",
      state: {
        ...choiceState(),
        replaced: true,
        replacedBy: { widgetId: "choice:newer", decided: { name: "Meera Shah", label: "Cancel" } },
      },
    });
    expect(told.closedText).toBe("Replaced by a newer one, where Meera Shah chose “Cancel”.");
    // An agent's open question takes taps until the host closes it, then says what became of it.
    const asked = choice({ state: { ...choiceState(), untilAnswered: true } });
    expect(kinChoicePhase(asked, posted + 30 * 24 * 60 * 60 * 1000)).toBe("open");
    const taken = choice({
      closedAt: "2026-11-10T14:00:00.000Z",
      state: {
        ...choiceState(),
        untilAnswered: true,
        outcome: {
          title: "Went with “Wait”",
          text: "No answer by Tuesday, so Finance went with “Wait”.",
        },
      },
    });
    expect([kinChoicePhase(taken, posted), taken.closedText]).toEqual([
      "expired",
      "No answer by Tuesday, so Finance went with “Wait”.",
    ]);
    expect(kinChoiceUndoneLine(taken, null)).toBeNull();
    // A taken default's note, undone from Settings: who and when, said to each reader.
    const at = new Date(2026, 10, 10, 9, 52);
    const undone = choice({
      closedAt: at.toISOString(),
      state: {
        ...choiceState(),
        untilAnswered: true,
        outcome: {
          title: "Undone",
          text: "Put W-3 “Clinic deck” back as it was.",
          undone: { personId: "owner", name: "Rhea Rao", at: at.toISOString() },
        },
      },
    });
    const later = new Date(2026, 10, 10, 18, 0);
    expect(kinChoiceUndoneLine(undone, "owner" as never, later)).toBe(
      `Undone by you at ${formatKinWhen(at, "time")}.`,
    );
    expect(kinChoiceUndoneLine(undone, "zoya" as never, new Date(2026, 10, 12))).toBe(
      `Undone by Rhea Rao on ${formatKinWhen(at, "dayTime")}.`,
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
    // An agent's card says what the choice means, in the chooser's words, not which button.
    expect(kinChoiceAnswered(tapped, "owner" as never, null)).toEqual({ text: "Shipping it." });
    expect(kinChoiceAnswered(answer("reaction", "👍"), null, null)).toEqual({
      text: "Shipping it.",
    });
    const open = answer("tap", null);
    expect(kinChoiceAnswered({ ...open, answer: null }, null, "Go ahead")).toEqual({
      text: "Going ahead.",
    });
    expect(kinChoiceAnswered({ ...open, answer: null }, null, null)).toBeNull();
    for (const [label, mine, theirs] of [
      ["Go ahead", "Going ahead.", "Going ahead."],
      ["Let me change it", "You'll change it.", "They'll change it."],
      ["Not now", "Not now.", "Not now."],
      ["yes!", "Yes.", "Yes."],
      ["Send it to Anita", "Sending it to Anita.", "Sending it to Anita."],
    ] as const) {
      expect(kinChoiceOutcomeSentence(label, true)).toBe(mine);
      expect(kinChoiceOutcomeSentence(label, false)).toBe(theirs);
    }
    const sent = { ...tapped, send: { outcome: { tone: "ok", text: "Sent" } } } as never;
    expect(kinChoiceAnswered(sent, "owner" as never, null)).toEqual({ text: null });
    // Who decided, under the card: by name to others, nothing more to the one who chose.
    const decided = choice({
      revision: 2,
      state: {
        ...choiceState({
          optionId: "option-2",
          personId: "rhea",
          via: "tap",
          emoji: null,
          answeredAt: "2026-11-08T09:05:00.000Z",
        }),
        decidedBy: { personId: "rhea", name: "Rhea Rao" },
      },
    });
    expect(kinChoiceDecidedLine(decided, "meera" as never)).toBe("Rhea Rao chose “Wait”.");
    expect(kinChoiceDecidedLine(decided, "rhea" as never)).toBeNull();
    expect(kinChoiceDecidedLine(tapped, "meera" as never)).toBeNull();
    expect(kinChoiceDecidedLine({ ...decided, answer: null }, "meera" as never)).toBeNull();
  });

  it("says what an answered card of Kin's own did, in a past-tense title, not the button", () => {
    const answered = {
      optionId: "option-1",
      personId: "owner",
      via: "tap",
      emoji: null,
      answeredAt: "2026-11-08T09:05:00.000Z",
    };
    const made = choice({
      revision: 2,
      state: {
        ...choiceState(answered),
        outcome: { title: "Money recorded", text: "₹25,000.00 from Lumen is recorded." },
      },
    });
    expect([made.question, kinChoiceAnswered(made, "owner" as never, null)]).toEqual([
      "Money recorded",
      { text: "₹25,000.00 from Lumen is recorded." },
    ]);
    const send = (state: "sent" | "failed", action: "email" | "reply") =>
      choice({
        revision: 3,
        state: {
          ...choiceState(answered),
          question: "Send this email from Outlook?",
          send: {
            service: "Outlook",
            action,
            from: "rhea@ambermill.example",
            to: ["anita@orbitdental.example"],
            cc: [],
            subject: "Invoice",
            body: "Hi",
            attachments: [],
            outcome: { state, reason: null, at: "2026-11-08T09:06:00.000Z" },
          },
        },
      }).question;
    expect([send("sent", "email"), send("sent", "reply"), send("failed", "email")]).toEqual([
      "Email sent",
      "Reply sent",
      "Not sent",
    ]);
  });

  it("offers a mail's own words to edit before it goes, and hands them over as typed", () => {
    const mail = (send: Record<string, unknown>, answer: unknown = null) =>
      choice({
        state: {
          ...choiceState(answer),
          send: {
            service: "Gmail",
            action: "email",
            from: "rhea@ambermill.example",
            to: ["anita@orbitdental.example", "dev@orbitdental.example"],
            cc: [],
            subject: "Invoice",
            body: "Hi Anita,\n\nAttached.",
            attachments: [],
            outcome: null,
            ...send,
          },
        },
      });
    const open = mail({});
    // Cancel on a mail asks first and waits for Undo; Confirm, and other cards' answers, don't.
    expect([kinMailCancels(open, "option-2"), kinMailCancels(open, "option-1")]).toEqual([
      true,
      false,
    ]);
    expect(kinMailCancels(choice(), "option-2")).toBe(false);
    // Settled, it says who confirmed it, sent it once it went, or chose not to, to everyone.
    const by = (optionId: string, send: Record<string, unknown> = {}) =>
      mail(send, {
        optionId,
        personId: "meera",
        via: "tap",
        emoji: null,
        answeredAt: "2026-11-08T09:05:00.000Z",
      });
    const withDecider = (view: ReturnType<typeof by>) => ({
      ...view,
      decidedBy: { personId: "meera" as never, name: "Meera Shah" },
    });
    const went = (state: string, action = "email") => ({
      action,
      outcome: { state, reason: null, at: "2026-11-08T09:06:00.000Z" },
    });
    expect(
      [
        by("option-1"),
        by("option-1", went("sending")),
        by("option-1", went("sent")),
        by("option-1", went("failed")),
        by("option-1", went("sending", "event")),
        by("option-1", went("sent", "event")),
        by("option-1", went("failed", "event")),
      ].map((view) => kinChoiceDecidedLine(withDecider(view), "rhea" as never)),
    ).toEqual([
      "Meera Shah confirmed it.",
      "Meera Shah confirmed it.",
      "Meera Shah sent it.",
      "Meera Shah confirmed it.",
      "Meera Shah confirmed it.",
      "Meera Shah confirmed it.",
      "Meera Shah confirmed it.",
    ]);
    expect(kinChoiceDecidedLine(withDecider(by("option-2")), "meera" as never)).toBe(
      "You chose not to send it.",
    );
    expect(open.send?.edit).toEqual({
      to: "anita@orbitdental.example, dev@orbitdental.example",
      cc: "",
      subject: "Invoice",
      body: "Hi Anita,\n\nAttached.",
    });
    expect(kinSendEditOffered(open, "open", true)).toBe(true);
    expect(kinSendEditOffered(open, "open", false)).toBe(false);
    expect(kinSendEditOffered(open, "expired", true)).toBe(false);
    const sending = mail({
      outcome: { state: "sending", reason: null, at: "2026-11-08T09:06:00.000Z" },
    });
    expect(kinSendEditOffered(sending, "open", true)).toBe(false);
    const answered = mail(
      {},
      {
        optionId: "option-1",
        personId: "owner",
        via: "tap",
        emoji: null,
        answeredAt: "2026-11-08T09:05:00.000Z",
      },
    );
    expect(kinSendEditOffered(answered, "answered", true)).toBe(false);
    // An event or a plain call keeps Confirm and Cancel only.
    expect(mail({ action: "event" }).send?.edit).toBeNull();
    expect(mail({ action: "call" }).send?.edit).toBeNull();
    // A mail's words fold under Read the whole email; an event's time and a call's tool don't.
    expect(open.send?.folds).toBe(true);
    expect(mail({ action: "event" }).send?.folds).toBe(false);
    // An invoice attached while the company has no bank details says what is missing and where.
    const file = { name: "INV-26-27-005.pdf", label: "Invoice INV/26-27/005", bytes: 2048 };
    expect(mail({ attachments: [file] }).send?.noBank).toBeNull();
    expect(mail({ attachments: [{ ...file, bankMissing: true }] }).send?.noBank).toBe(
      KIN_SEND_COPY.noBank,
    );

    const started = kinSendEditStart(open)!;
    expect(started).toEqual({
      revision: 1,
      opened: open.send?.edit,
      draft: open.send?.edit,
      problem: null,
    });
    const typed = {
      ...started,
      draft: {
        to: " anita@orbitdental.example,dev@orbitdental.example; ",
        cc: "rhea@ambermill.example",
        subject: "Invoice for November",
        body: "Hi Anita,\n\nAttached, with the GST line.\n",
      },
    };
    // Someone changed From on another device: the editor still sends the card it opened on.
    const moved = mail({
      account: "billing@ambermill.example",
      from: "billing@ambermill.example",
    });
    const sent = { ...moved, revision: 2 };
    expect(kinSendEditInput(sent, typed, "press-1")).toEqual({
      orgId: "org",
      widgetId: "w1",
      revision: 1,
      clientActionId: "press-1",
      to: ["anita@orbitdental.example", "dev@orbitdental.example"],
      cc: ["rhea@ambermill.example"],
      subject: "Invoice for November",
      body: "Hi Anita,\n\nAttached, with the GST line.\n",
    });
    // The host's refusal is the line under the fields, in its own words, and the words stay.
    const said = "anita at orbit in To isn't a plain address such as ana@example.com.";
    expect(kinSendEditFailure(new KinChatError({ reason: "invalid_state", message: said }))).toBe(
      said,
    );
    expect(kinSendEditFailure(new Error("socket closed"))).not.toBe("");
    const invalid = new KinChatError({ reason: "invalid_state", message: said });
    expect(kinSendEditRefused(typed, sent, invalid)).toEqual({ ...typed, problem: said });
    // "This card changed" kills the card that press carried. Send then waits for a newer card and
    // carries the one on screen, whose From the editor shows again beside it.
    const changed = new KinChatError({
      reason: "widget_changed",
      message: "This card changed or was answered. Look at it again.",
    });
    expect(kinSendEditBound(typed, sent)).toEqual({ revision: 1, ready: true, review: false });
    // The refusal can arrive before the card's update does: nothing newer to send yet.
    const early = kinSendEditRefused(typed, open, changed);
    expect(early).toEqual({ ...typed, problem: changed.message, stale: true });
    expect(kinSendEditBound(early, open)).toEqual({ revision: 1, ready: false, review: true });
    expect(kinSendEditBound(early, sent)).toEqual({ revision: 2, ready: true, review: true });
    expect(kinSendEditInput(sent, early, "press-2").revision).toBe(2);
    // That one changed too before the second press landed: it is dead in its turn.
    const again = kinSendEditRefused(early, sent, changed);
    expect(again.revision).toBe(2);
    expect(kinSendEditBound(again, sent).ready).toBe(false);
    expect(kinSendEditBound(again, { revision: 3 })).toEqual({
      revision: 3,
      ready: true,
      review: true,
    });
    // Another refusal after that keeps Send waiting on the card, not on the words.
    expect(kinSendEditRefused(again, { revision: 3 }, invalid)).toEqual({
      ...again,
      problem: said,
    });

    // What the editor shows besides the fields: who it goes from, and the quote that goes too.
    expect(sent.send?.from).toEqual([{ label: "From", value: "billing@ambermill.example" }]);
    const reply = mail({
      action: "reply",
      account: "rhea@ambermill.example",
      from: "billing@ambermill.example",
      fromName: "Ambermill Billing",
      quoted: "On Mon, Anita wrote:\n> Could you resend it?",
    });
    expect([reply.send?.from, reply.send?.quoted]).toEqual([
      [
        { label: "From", value: "Ambermill Billing <billing@ambermill.example>" },
        { label: "Account", value: "rhea@ambermill.example" },
      ],
      "On Mon, Anita wrote:\n> Could you resend it?",
    ]);
    // The phone's card is one spoken group: it says the words that go, and the quote under them.
    const spoken = kinChoiceAccessibilityLabel(reply, null, null, { message: true });
    expect(spoken).toContain(
      "Subject: Invoice. Message: Hi Anita,\n\nAttached. On Mon, Anita wrote:",
    );
    expect(spoken).toContain("> Could you resend it?");
    expect(kinChoiceAccessibilityLabel(reply, null)).not.toContain("Message:");
    expect(mail({ action: "event" }).send?.from).toEqual([]);
  });

  it("keeps a person's unsent words on the card, and offers Save, Send and Discard by state", () => {
    const send = {
      service: "Gmail",
      action: "email",
      from: "rhea@ambermill.example",
      to: ["anita@orbitdental.example"],
      cc: [],
      subject: "Invoice",
      body: "Hi Anita,\n\nAttached.",
      attachments: [],
      outcome: null,
    };
    const drafted = choice({ state: { ...choiceState(null), send } });
    expect(drafted.send?.edited).toBeNull();
    expect(kinSendEditedLine(drafted, KinPersonId.make("rhea"))).toBeNull();
    const started = kinSendEditStart(drafted)!;
    expect(kinSendEditDiscardInput(drafted, started, true)).toBeNull();
    // Nothing typed: leaving keeps nothing, and a closed card takes the editor with it.
    expect(kinSendEditLeaveSaves(started, null, true)).toBe(false);
    expect(kinSendEditShown(started, false)).toBe(false);
    const typed = {
      ...started,
      draft: { ...started.draft, body: "Hi Anita,\n\nAttached, with GST." },
    };
    expect(kinSendEditSaveInput(drafted, typed)).toEqual({
      orgId: "org",
      widgetId: "w1",
      revision: 1,
      edit: {
        to: ["anita@orbitdental.example"],
        cc: [],
        subject: "Invoice",
        body: "Hi Anita,\n\nAttached, with GST.",
      },
    });
    expect(kinSendEditLeaveSaves(typed, null, true)).toBe(true);
    // Not while a press is on its way, nor once the card stopped taking edits.
    expect(kinSendEditLeaveSaves(typed, "sending", true)).toBe(false);
    expect(kinSendEditLeaveSaves(typed, null, false)).toBe(false);
    // Saved on leaving, the editor stays over the saved card, with nothing left unsaved.
    const kept = kinSendEditKept(typed, 2);
    expect(kept).toEqual({
      revision: 2,
      opened: typed.draft,
      draft: typed.draft,
      problem: null,
      saved: true,
    });
    expect(kinSendEditLeaveSaves(kept, null, true)).toBe(false);
    // The save's answer came before the card's update: Discard still puts the draft back, bound
    // to the revision the host acknowledged, never only closing the editor.
    expect(kinSendEditDiscardInput(drafted, kept, true)).toEqual({
      orgId: "org",
      widgetId: "w1",
      revision: 2,
      edit: null,
    });
    // Save closed the editor and the card's update is late: Edit opens over the saved words, and
    // its Discard is the reset bound to the revision the host acknowledged.
    const acked = { revision: 2, saved: typed.draft };
    const late = kinSendEditStart(drafted, acked)!;
    expect(late).toEqual(kept);
    expect(kinSendEditDiscardInput(drafted, late, true)).toEqual({
      orgId: "org",
      widgetId: "w1",
      revision: 2,
      edit: null,
    });

    const label = (controls: ReturnType<typeof kinSendEditControls>) => ({
      save: [controls.save.label, controls.save.disabled],
      send: [controls.send.label, controls.send.disabled],
      discard: [controls.discard.label, controls.discard.disabled],
      notice: controls.notice,
    });
    expect(label(kinSendEditControls(typed, drafted, null, true))).toEqual({
      save: ["Save", false],
      send: ["Send edited mail", false],
      discard: ["Discard edits", false],
      notice: null,
    });
    expect(label(kinSendEditControls(typed, drafted, "saving", true))).toEqual({
      save: ["Saving…", true],
      send: ["Send edited mail", true],
      discard: ["Discard edits", true],
      notice: null,
    });
    expect(label(kinSendEditControls(typed, drafted, "discarding", true)).discard).toEqual([
      "Discarding…",
      true,
    ]);
    // The host said the card changed: Save and Send wait for the newer card, then carry it.
    const changed = new KinChatError({
      reason: "widget_changed",
      message: "This card changed or was answered. Look at it again.",
    });
    const stale = kinSendEditRefused(typed, drafted, changed);
    expect(label(kinSendEditControls(stale, drafted, null, true)).save).toEqual(["Save", true]);
    expect(kinSendEditSaveInput({ ...drafted, revision: 2 }, stale).revision).toBe(2);
    // Leaving never puts the words over a card the host said changed: the person chooses.
    expect(kinSendEditLeaveSaves(stale, null, true)).toBe(false);
    // The agent's newer card closed this one: the words stay, with only Discard.
    expect(kinSendEditShown(typed, false)).toBe(true);
    expect(label(kinSendEditControls(typed, drafted, null, false))).toEqual({
      save: ["Save", true],
      send: ["Send edited mail", true],
      discard: ["Discard edits", false],
      notice:
        "This card closed while you were editing, so your words weren't saved. They stay here until you discard them.",
    });

    // Saved, the card shows the person's words as theirs, and Discard puts the draft back.
    const saved = choice({
      revision: 2,
      state: {
        ...choiceState(null),
        send: { ...send, body: typed.draft.body, edited: { personId: "rhea", name: "Rhea" } },
      },
    });
    expect(saved.send?.body).toBe(typed.draft.body);
    expect(kinSendEditStart(saved)?.draft.body).toBe(typed.draft.body);
    expect(kinSendEditedLine(saved, KinPersonId.make("rhea"))).toBe("Edited by you");
    expect(kinSendEditedLine(saved, KinPersonId.make("meera"))).toBe("Edited by Rhea");
    const reopened = kinSendEditStart(saved)!;
    expect(kinSendEditDiscardInput(saved, reopened, true)).toEqual({
      orgId: "org",
      widgetId: "w1",
      revision: 2,
      edit: null,
    });
    expect(kinSendEditDiscardInput(saved, reopened, false)).toBeNull();
    // That Discard was taken and the update is late: Edit binds to the reset card, whose Discard
    // only closes the editor, though the card on screen still shows the saved words.
    const reset = kinSendEditStart(saved, { revision: 3, saved: null })!;
    expect(reset.revision).toBe(3);
    expect(kinSendEditDiscardInput(saved, reset, true)).toBeNull();
    // Once the card has caught up, or moved past, the card itself is what Edit opens.
    expect(kinSendEditStart(saved, { revision: 2, saved: null })).toEqual(reopened);
  });

  it("warns while an earlier try at the mail may have gone, and holds Confirm and Send edited for the tick", () => {
    const at = "2026-11-08T09:05:00.000Z";
    const tried = new Date(at);
    const tick = { tryId: "ask-a", at };
    const send = {
      service: "Gmail",
      action: "reply",
      from: "rhea@ambermill.example",
      to: ["anita@orbitdental.example"],
      cc: [],
      subject: "Re: Invoice",
      body: "Attached.",
      attachments: [],
      outcome: null,
      mayHaveGone: tick,
    };
    const open = choice({ state: { ...choiceState(null), send } });
    const line = kinMayHaveGoneLine(at);
    expect(open.send?.mayHaveGone).toEqual({ line, ...tick, confirmId: "option-1" });
    expect(kinSendTry(open)).toEqual(tick);
    expect(kinMayHaveGoneLine(at, tried)).toBe(
      `An earlier try at this mail at ${formatKinWhen(tried, "time")} may already have gone. Check the account's sent mail before you confirm.`,
    );
    expect(kinMayHaveGoneLine(at, new Date(tried.getTime() + 3 * 86_400_000))).toContain(
      `on ${formatKinWhen(tried, "dayTime")}`,
    );
    expect(kinChoiceAccessibilityLabel(open, null)).toContain("may already have gone");
    // Confirm and Send edited wait for the tick; Cancel never does.
    expect(kinSendCheckPending(open, null, "option-1")).toBe(true);
    expect(kinSendCheckPending(open, null, "option-2")).toBe(false);
    expect(kinSendCheckPending(open, null)).toBe(true);
    expect(kinSendCheckPending(open, tick, "option-1")).toBe(false);
    // A tick is for one try: once the warning names a later one, it no longer counts, nor does a
    // tick for another try that ended at the same time.
    const later = { tryId: "ask-b", at: "2026-11-08T09:40:00.000Z" };
    const moved = choice({
      state: { ...choiceState(null), send: { ...send, mayHaveGone: later } },
    });
    expect(kinSendTicked(open, tick)).toBe(tick);
    expect(kinSendTicked(open, { tryId: "ask-b", at })).toBeNull();
    expect(kinSendTicked(moved, tick)).toBeNull();
    expect(kinSendCheckPending(moved, tick, "option-1")).toBe(true);
    expect(kinSendCheckPending(moved, tick)).toBe(true);
    expect(kinSendCheckPending(moved, later, "option-1")).toBe(false);
    const editing = kinSendEditStart(open)!;
    expect(kinSendEditControls(editing, open, null, true, true).send.disabled).toBe(true);
    expect(kinSendEditControls(editing, open, null, true, false).send.disabled).toBe(false);
    // Ticked, both presses carry the try it is for; unticked, they carry nothing new.
    expect(kinChoiceActInput(open, "option-1", "tap-1", tick)).toMatchObject({ checkedSent: tick });
    expect(kinChoiceActInput(open, "option-1", "tap-1")).not.toHaveProperty("checkedSent");
    expect(kinSendEditInput(open, editing, "press-1", tick)).toMatchObject({ checkedSent: tick });
    expect(kinSendEditInput(open, editing, "press-1")).not.toHaveProperty("checkedSent");
    // Once that card's own try is on its way, the outcome line takes over.
    const sending = choice({
      state: {
        ...choiceState(null),
        send: { ...send, outcome: { state: "sending", reason: null, at } },
      },
    });
    expect(sending.send?.mayHaveGone).toBeNull();
    const { mayHaveGone: _gone, ...settled } = send;
    const plain = choice({ state: { ...choiceState(null), send: settled } });
    expect(plain.send?.mayHaveGone).toBeNull();
    expect(kinSendCheckPending(plain, null)).toBe(false);
    expect(kinSendTicked(plain, tick)).toBeNull();
    // Send edited refused for words an earlier try reached: the refusal names that try, the
    // editor's tick is for it, and the shared card keeps its own (no) warning.
    const typing = kinSendEditStart(plain)!;
    expect(kinSendEditWarned(plain, typing)).toBe(plain);
    const refused = kinSendEditRefused(
      typing,
      plain,
      new KinChatError({ reason: "conflict", message: "Tick first.", mayHaveGone: later }),
    );
    expect(refused).toEqual({ ...typing, problem: "Tick first.", mayHaveGone: later });
    const warned = kinSendEditWarned(plain, refused, tried);
    expect(warned.send?.mayHaveGone).toEqual({
      line: kinMayHaveGoneLine(later.at, tried),
      ...later,
      confirmId: null,
    });
    expect(kinSendCheckPending(warned, null)).toBe(true);
    expect(kinSendCheckPending(warned, later)).toBe(false);
    expect(kinSendEditInput(plain, refused, "press-2", kinSendTicked(warned, later))).toMatchObject(
      { revision: refused.revision, checkedSent: later },
    );
    expect(kinSendCheckPending(plain, null, "option-1")).toBe(false);
  });

  it("posts one tap at a time, and binds a late refusal to the card the press carried", async () => {
    const mailCard = (revision: number) =>
      choice({
        revision,
        state: {
          ...choiceState(),
          send: {
            service: "Gmail",
            action: "email",
            from: "rhea@ambermill.example",
            to: ["anita@orbitdental.example"],
            cc: [],
            subject: "Invoice",
            body: "Hi Anita,",
            attachments: [],
            outcome: null,
          },
        },
      });
    const first = mailCard(1);
    const changed = new KinChatError({
      reason: "widget_changed",
      message: "This card changed or was answered. Look at it again.",
    });
    const sent: Array<string> = [];
    const replies: Array<() => void> = [];
    const later = <A>(name: string, result: AsyncResult.Failure<A, unknown>) =>
      new Promise<AsyncResult.Success<A, unknown> | AsyncResult.Failure<A, unknown>>((resolve) => {
        sent.push(name);
        replies.push(() => resolve(result));
      });
    const refused = <A>() => AsyncResult.failure<A, unknown>(Cause.fail(changed));
    const taps = kinChoiceCardTaps();
    const heldKey = kinSendEditHeldKey("env", null, first.widgetId);
    const typed: KinSendEditing = {
      ...kinSendEditStart(first)!,
      draft: {
        to: "anita@orbitdental.example",
        cc: "",
        subject: "Invoice",
        body: "Hi Anita, paid",
      },
    };
    const seen = {
      pending: [] as Array<string | null>,
      status: [] as Array<KinChoiceCardStatus>,
      editing: [] as Array<KinSendEditing | null>,
    };
    const actions = (card: typeof first, pending: string | null, editing: KinSendEditing | null) =>
      kinChoiceCardActions({
        choice: card,
        environmentId: "env" as EnvironmentId,
        newId: () => `id-${sent.length}`,
        taps,
        heldKey,
        state: {
          pending,
          switching: false,
          editing,
          editBusy: null,
          editable: true,
          ticked: null,
          nowMs: posted,
        },
        commands: {
          post: () => later("post", refused()),
          setSendFrom: () => later("from", refused()),
          sendEdited: () => later("send", refused()),
          saveEdited: () => later("save", refused()),
        },
        set: {
          pending: (pending) => seen.pending.push(pending),
          lastStatus: (status) => seen.status.push(status),
          switching: () => {},
          switchProblem: () => {},
          editBusy: () => {},
          editing: (editing) => seen.editing.push(editing),
          ack: () => {},
          ticked: () => {},
        },
      });

    // A second tap in the same render, and one drawn while the first is pending, post nothing.
    const tap = actions(first, null, null);
    const pressed = tap.press("option-1");
    await tap.press("option-2");
    await actions(first, "option-1", null).press("option-2");
    await actions(first, "option-1", null).pickFrom("billing");
    expect(sent).toEqual(["post"]);
    // The newer card arrives before the refusal: the notice is tied to the card the tap was on.
    const newer = mailCard(2);
    replies.shift()!();
    await pressed;
    expect(seen.pending).toEqual(["option-1", null]);
    expect(seen.status).toEqual([
      null,
      {
        revision: 1,
        optionId: "option-1",
        notice: kinChoiceFailureNotice(changed),
        holding: false,
      },
    ]);

    // Send edited, refused as changed after the card moved on: every typed word stays, and the
    // next Send goes against the card now on screen.
    const sending = actions(first, null, typed).sendEdit();
    replies.shift()!();
    await sending;
    const kept = seen.editing.at(-1)!;
    expect(kept).toEqual({ ...typed, problem: changed.message, stale: true });
    expect(kinSendEditHeld(heldKey)).toEqual(kept);
    expect(kinSendEditBound(kept, newer)).toEqual({ revision: 2, ready: true, review: true });
    expect(sent).toEqual(["post", "send"]);
  });

  it("says a refused answer in the host's words when its figures changed", () => {
    const refusal = (
      reason: "conflict" | "widget_changed" | "not_allowed" | "unavailable",
      message: string,
    ) => kinChoiceFailureNotice(new KinChatError({ reason, message }));
    expect(refusal("conflict", "The figures changed since this card was made.")).toEqual({
      kind: "error",
      text: "The figures changed since this card was made.",
    });
    // A mail whose account needs signing in: which one, that nothing went, where to sign in.
    const signedOut =
      "hello@ambermill.example needs signing in again in Settings › Connections. Nothing was sent; send it again once it's back.";
    expect(refusal("unavailable", signedOut)).toEqual({ kind: "error", text: signedOut });
    expect(
      kinSendEditFailure(new KinChatError({ reason: "unavailable", message: signedOut })),
    ).toBe(signedOut);
    expect(refusal("unavailable", "Kin couldn't read mail_send's definition.").text).not.toContain(
      "mail_send",
    );
    expect(refusal("widget_changed", "This receipt was already answered.").kind).toBe("stale");
    expect(refusal("not_allowed", "Chat operation not allowed.").text).not.toContain("Chat");
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
    expect(due.lines).toEqual(["Due Fri, Nov 13, 9:00 AM."]);
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
    expect(snoozed.lines).toEqual(["Snoozed until Fri, Nov 13, 9:10 AM."]);
    expect(snoozed.actions).toHaveLength(5);
    expect(kinReminderCardView(reminder({ status: "done" }), zone)!.actions).toEqual([]);
    expect(kinReminderCardView(reminder({ status: "bogus" }), zone)).toBeNull();
    // A teammate gets only the taps the host takes from them.
    const teammate = (state: Record<string, unknown>) =>
      kinReminderCardView(reminder({ status: "due", ...state }), zone, false)!.actions.map(
        (action) => action.id,
      );
    expect(teammate({ theirs: true })).toHaveLength(5);
    expect(teammate({ theirs: false })).not.toContain("change");
    expect(teammate({ theirs: false })).toContain("done");
    expect(teammate({})).toEqual([]);
    expect(kinReminderCardView(reminder({ status: "due" }), zone, true)!.actions).toHaveLength(5);
  });

  it("shows when a scheduled task runs, how the last run went, and its controls", () => {
    const active = kinScheduledTaskCardView(scheduled({}), zone)!;
    expect(active.lines).toEqual(["Weekdays at 8:00.", "Next run Tue, Nov 10, 8:00 AM."]);
    expect(active.countdown).toEqual({ to: Date.parse("2026-11-10T02:30:00.000Z"), kind: "run" });
    expect(active.actions.map((action) => action.id)).toEqual([
      "run_now",
      "pause",
      "edit",
      "delete",
    ]);
    expect(kinScheduledTaskCardView(scheduled({}), "UTC")!.lines[0]).toBe(
      "Weekdays at 8:00 (India Standard Time).",
    );
    expect(kinScheduledTaskCardView(scheduled({}), "Asia/Calcutta")!.lines[0]).toBe(
      "Weekdays at 8:00.",
    );
    // A loose one's stored next run is its window's start (7:55): never shown as a minute.
    const around = kinScheduledTaskCardView(
      scheduled({ around: true, nextRunAt: "2026-11-10T02:25:00.000Z" }),
      zone,
    )!;
    expect(around.lines).toEqual(["Weekdays around 8:00."]);
    expect(around.countdown).toBeNull();

    const posted = kinScheduledTaskCardView(
      scheduled({
        lastRun: { at: "2026-11-10T02:30:00.000Z", status: "posted", note: "Three PRs are open." },
      }),
      zone,
    )!;
    expect(posted.lines.at(-1)).toBe("Last run Tue, Nov 10, 8:00 AM: Three PRs are open.");
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

  it("puts a retired agent's reminder and schedule on hold, with nothing to tap", () => {
    const held = (card: ReturnType<typeof scheduled>) => {
      const view = kinCardView(card, "env" as EnvironmentId, () => true, "Finance");
      return view.kind === "deferral" ? view.deferral : null;
    };
    // The schedule stays; "Next run" and "Paused" give way to the one line that is true.
    const active = held(scheduled({}));
    expect(active).toMatchObject({ countdown: null, actions: [] });
    expect(active?.lines.slice(1)).toEqual(["On hold while Finance is retired."]);
    expect(held(scheduled({ status: "paused", nextRunAt: null }))?.lines.slice(1)).toEqual([
      "On hold while Finance is retired.",
    ]);
    expect(held(reminder({ status: "due" }))).toMatchObject({ countdown: null, actions: [] });
    // What is already over says so, as before.
    expect(held(scheduled({ status: "deleted", nextRunAt: null }))?.lines).toEqual(["Deleted."]);
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
    expect(noted!.note).toMatch(/^review by \w{3}, Nov \d+, \d+:\d{2} [AP]M$/);
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
    const note = (body: string, widgetId: string | null, tag = "system") =>
      ({ author: { _tag: tag }, status: "posted", widgetId, body }) as never;
    expect(kinIsBookkeeping(note("", changes.widgetId), changes)).toBe(true);
    expect(kinIsBookkeeping(note("Forgot: the old office address", null), undefined)).toBe(true);
    // What the owner must know, and what a lead wrote, always shows.
    expect(kinIsBookkeeping(note("Tech lead stopped partway.", null), undefined)).toBe(false);
    expect(kinIsBookkeeping(note("Forgot: to say hi", null, "agent"), undefined)).toBe(false);
    const task = widget({ type: "task", state: taskState() });
    expect(kinIsBookkeeping(note("", task.widgetId), task)).toBe(false);
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

describe("a held press", () => {
  // Timers the test runs by hand: what is set, and what is still waiting.
  const timers = () => {
    const set = new Map<number, () => void>();
    let next = 0;
    return {
      set: (run: () => void, _ms: number) => {
        next += 1;
        set.set(next, run);
        return next;
      },
      clear: (handle: number) => void set.delete(handle),
      elapse: () => [...set.values()].forEach((run) => run()),
      size: () => set.size,
    };
  };

  it("sends once when its time runs out, never after Undo, and at once when flushed", () => {
    const sent: Array<string> = [];
    const clock = timers();
    const press = createKinHeldPress({
      delayMs: 5_000,
      send: () => sent.push("cancel"),
      timers: clock,
    });
    press.hold();
    press.hold();
    expect([press.waiting(), clock.size()]).toEqual([true, 1]);
    press.undo();
    clock.elapse();
    expect([sent, press.waiting()]).toEqual([[], false]);
    press.hold();
    clock.elapse();
    clock.elapse();
    expect(sent).toEqual(["cancel"]);
    // Leaving the screen sends a waiting press now, and only once.
    press.hold();
    press.flush();
    press.flush();
    clock.elapse();
    expect([sent, clock.size()]).toEqual([["cancel", "cancel"], 0]);
  });
});
