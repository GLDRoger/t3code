import { describe, expect, it } from "@effect/vitest";
import {
  KIN_COMPANY_CHAT_TEAM_ID,
  KIN_TEAM_ROOM_TEAM_ID,
  KinAgentId,
  KinChatError,
  KinChatId,
  KinChatPinId,
  KinMemberId,
  KinOrgId,
  KinPersonId,
  type KinChatMember,
  type KinChatPin,
  type KinChatSummary,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { selectKinInboxView } from "./kinInboxModel.ts";
import {
  KIN_PINS_COPY,
  kinChatMayWritePins,
  kinGoalPinnable,
  kinNextDayStart,
  kinPinFailureText,
  kinPinnableChats,
  kinPinStrip,
  kinPinView,
} from "./kinPins.ts";
import type { KinDirectory } from "./kinScreenState.ts";

const names = { zone: "Asia/Kolkata", readerZone: "America/Los_Angeles" };
const at = (iso: string) => DateTime.toDateUtc(DateTime.makeUnsafe(iso));
const now = at("2026-11-27T02:00:00.000Z");
const meta = {
  pinId: KinChatPinId.make("kin-chat-pin-89fc7a33"),
  pinnedBy: "Rhea",
  pinnedAt: "2026-11-20T00:00:00.000Z",
};
const task = {
  ...meta,
  _tag: "task",
  key: "W-142",
  title: "Check the cold room",
  state: "open",
  dueAt: "2026-11-27T15:00:00.000Z",
  dueAllDay: true,
  late: false,
} satisfies KinChatPin;
const project = {
  ...meta,
  _tag: "project",
  key: "P-73",
  name: "Tidewater Freight",
  state: "doing",
  targetAt: "2026-12-27T15:00:00.000Z",
  targetAllDay: true,
  done: 7,
  total: 12,
  late: 2,
} satisfies KinChatPin;
const goal = {
  ...meta,
  _tag: "goal",
  key: "G-22",
  title: "Juniper Cold Chain hires",
  state: "open",
  measure: "manual",
  unit: "hires",
  current: 62,
  target: 100,
  dueOn: null,
  behind: true,
} satisfies KinChatPin;

describe("pinned cards", () => {
  it.each([
    ["all-day", true, "Due today"],
    ["timed", false, "Due tomorrow"],
  ] as const)("counts a %s date in the same zone as Work", (_name, dueAllDay, line) => {
    expect(kinPinView({ ...task, dueAllDay }, now, names).line).toBe(line);
  });

  const { unit: _unit, ...unitlessGoal } = goal;
  it.each([
    ["task date", task, "Check the cold room", "Due today", "normal", "task"],
    [
      "later task",
      { ...task, dueAt: "2026-12-09T15:00:00.000Z" },
      "Check the cold room",
      "Due in 12 days",
      "normal",
      "task",
    ],
    [
      "late task",
      { ...task, dueAt: "2026-11-24T15:00:00.000Z", late: true },
      "Check the cold room",
      "3 days late",
      "late",
      "task",
    ],
    [
      "task without date",
      { ...task, dueAt: null },
      "Check the cold room",
      "Open",
      "normal",
      "task",
    ],
    [
      "waiting",
      { ...task, state: "waiting", dueAt: null },
      "Check the cold room",
      "Waiting",
      "normal",
      "task",
    ],
    [
      "doing",
      { ...task, state: "doing", dueAt: null },
      "Check the cold room",
      "In progress",
      "normal",
      "task",
    ],
    [
      "steps",
      { ...task, steps: { done: 2, total: 5 }, dueAt: "2026-12-04T15:00:00.000Z" },
      "Check the cold room",
      "2 of 5 steps · due Fri",
      "normal",
      "task",
    ],
    ["done", { ...task, state: "done" }, "Check the cold room", "Done", "muted", "task"],
    ["dropped", { ...task, state: "dropped" }, "Check the cold room", "Dropped", "muted", "task"],
    [
      "project",
      project,
      "Tidewater Freight",
      "7 of 12 done · 2 late · ends in 30 days",
      "late",
      "project",
    ],
    [
      "project without date",
      { ...project, targetAt: null, late: 0 },
      "Tidewater Freight",
      "7 of 12 done",
      "normal",
      "project",
    ],
    ["goal", goal, "Juniper Cold Chain hires", "62 of 100 hires · behind", "late", "goal"],
    [
      "goal without unit",
      { ...unitlessGoal, behind: false },
      "Juniper Cold Chain hires",
      "62 of 100",
      "normal",
      "goal",
    ],
    ["gone", { ...meta, _tag: "gone" }, "No longer in Kin", null, "muted", null],
    ["hidden", { _tag: "hidden", pinId: meta.pinId }, "A pin you can't open", null, "muted", null],
  ] as const)("presents %s", (_name, pin, title, line, tone, kind) => {
    expect(kinPinView(pin, now, names)).toEqual({
      title,
      line,
      tone,
      opens: kind === null || !("key" in pin) ? null : { kind, key: pin.key },
    });
  });

  it.each([
    ["2026-03-08T08:00:00.000Z", "2026-03-09T07:00:00.000Z"],
    ["2026-11-01T07:00:00.000Z", "2026-11-02T08:00:00.000Z"],
  ])("finds the next Los Angeles day start across DST from %s", (start, next) => {
    expect(kinNextDayStart(at(start), ["America/Los_Angeles"])).toEqual(at(next));
  });

  it("uses the earliest of the company's and reader's next day starts", () => {
    expect(kinNextDayStart(now, [names.readerZone, names.zone])).toEqual(
      at("2026-11-27T08:00:00.000Z"),
    );
    expect(kinNextDayStart(now, [])).toBeNull();
  });

  it("shapes strip state, hides unpin on hidden pins and read-only chats, and keeps gone unpinnable", () => {
    const gone: KinChatPin = { ...meta, pinId: KinChatPinId.make("pin-gone"), _tag: "gone" };
    const hidden: KinChatPin = { _tag: "hidden", pinId: KinChatPinId.make("pin-hidden") };
    const pins: ReadonlyArray<KinChatPin> = [task, gone, hidden];
    const views = pins.map((pin) => kinPinView(pin, now, names));

    const writer = kinPinStrip(pins, views, { canUnpin: true, writable: true });
    expect(writer.count).toBe(3);
    expect(writer.rest).toBe(2);
    expect(writer.more).toBe("+2");
    expect(writer.largeLabel).toBe("3 pinned");
    expect(writer.canUnpinAny).toBe(true);
    expect(writer.hasActions).toBe(true);
    expect(writer.items.map((item) => item.canUnpin)).toEqual([true, true, false]);

    const guest = kinPinStrip(pins, views, { canUnpin: true, writable: false });
    expect(guest.canUnpinAny).toBe(false);
    expect(guest.items.map((item) => item.canUnpin)).toEqual([false, false, false]);

    const onlyHidden = kinPinStrip([hidden], [kinPinView(hidden, now, names)], {
      canUnpin: true,
      writable: true,
    });
    expect(onlyHidden.count).toBe(1);
    expect(onlyHidden.more).toBeNull();
    expect(onlyHidden.canUnpinAny).toBe(false);
    expect(onlyHidden.hasActions).toBe(false);
  });

  it("turns a goal pin into a plain glance when the reader has no Money place", () => {
    const goalView = kinPinView(goal, now, names);
    const taskView = kinPinView(task, now, names);

    const guestNoMoney = kinPinStrip([goal], [goalView], {
      canUnpin: true,
      writable: false,
      hasMoney: false,
    });
    expect(guestNoMoney.first?.view.opens).toBeNull();
    expect(guestNoMoney.hasActions).toBe(false);

    const teammateNoMoney = kinPinStrip([goal, task], [goalView, taskView], {
      canUnpin: true,
      writable: true,
      hasMoney: false,
    });
    expect(teammateNoMoney.items[0]?.view.opens).toBeNull();
    expect(teammateNoMoney.items[0]?.canUnpin).toBe(true);
    expect(teammateNoMoney.items[1]?.view.opens).toEqual({ kind: "task", key: "W-142" });
    expect(teammateNoMoney.hasActions).toBe(true);

    const withMoney = kinPinStrip([goal], [goalView], {
      canUnpin: true,
      writable: false,
      hasMoney: true,
    });
    expect(withMoney.first?.view.opens).toEqual({ kind: "goal", key: "G-22" });
    expect(withMoney.hasActions).toBe(true);
  });

  it("checks active non-guest membership for writing pins", () => {
    const orgId = KinOrgId.make("org-tidewater");
    const personId = KinPersonId.make("person-rhea");
    const member = (role: KinChatMember["role"], leftAt: string | null = null): KinChatMember => ({
      orgId,
      memberId: KinMemberId.make("mem-1"),
      chatId: KinChatId.make("chat-1"),
      principal: { _tag: "person", personId },
      role,
      joinedAt: "2026-11-20T00:00:00.000Z",
      leftAt,
      mutedUntil: null,
    });

    expect(kinChatMayWritePins([member("owner")], personId)).toBe(true);
    expect(kinChatMayWritePins([member("member")], personId)).toBe(true);
    expect(kinChatMayWritePins([member("guest")], personId)).toBe(false);
    expect(kinChatMayWritePins([member("owner", "2026-11-21T00:00:00.000Z")], personId)).toBe(
      false,
    );
    expect(kinChatMayWritePins([member("owner")], null)).toBe(false);
  });

  it("excludes money goals from pin actions", () => {
    expect(kinGoalPinnable({ measure: "tasks_done" })).toBe(true);
    expect(kinGoalPinnable({ measure: "clients_won" })).toBe(true);
    expect(kinGoalPinnable({ measure: "manual" })).toBe(true);
    expect(kinGoalPinnable({ measure: "revenue_received" })).toBe(false);
    expect(kinGoalPinnable({ measure: "manual", currency: "USD" })).toBe(false);
  });

  it("lists only active writable chats in this org in chat-list order", () => {
    const orgId = KinOrgId.make("org-tidewater");
    const otherOrg = KinOrgId.make("org-other");
    const me = KinPersonId.make("person-rhea");
    const retiredAgent = KinAgentId.make("agent-retired");
    const activeAgent = KinAgentId.make("agent-chief");
    const member = (
      chatId: KinChatId,
      role: KinChatMember["role"] = "owner",
      leftAt: string | null = null,
      memberOrgId: KinOrgId = orgId,
    ): KinChatMember => ({
      orgId: memberOrgId,
      memberId: KinMemberId.make(`mem-${chatId}`),
      chatId,
      principal: { _tag: "person", personId: me },
      role,
      joinedAt: "2026-11-20T00:00:00.000Z",
      leftAt,
      mutedUntil: null,
    });
    const chat = (id: string, patch: Partial<KinChatSummary> = {}): KinChatSummary => {
      const chatId = KinChatId.make(id);
      return {
        chatId,
        orgId,
        kind: "team_group",
        title: id,
        teamId: null,
        createdAt: "2026-11-20T00:00:00.000Z",
        archivedAt: null,
        members: [member(chatId, "owner", null, patch.orgId ?? orgId)],
        lastSeq: 0,
        lastMessageAt: null,
        lastMessage: null,
        unread: 0,
        ...patch,
      };
    };
    const chats: ReadonlyArray<KinChatSummary> = [
      chat("chat-guest", {
        title: "Read-only group",
        members: [member(KinChatId.make("chat-guest"), "guest")],
      }),
      chat("chat-archived", {
        title: "Old group",
        archivedAt: "2026-11-22T00:00:00.000Z",
      }),
      chat("chat-other-org", { orgId: otherOrg, title: "Other org" }),
      chat("chat-retired", {
        kind: "direct",
        title: null,
        members: [
          member(KinChatId.make("chat-retired")),
          {
            orgId,
            memberId: KinMemberId.make("mem-ret-agent"),
            chatId: KinChatId.make("chat-retired"),
            principal: { _tag: "agent", agentId: retiredAgent },
            role: "member",
            joinedAt: "2026-11-20T00:00:00.000Z",
            leftAt: null,
            mutedUntil: null,
          },
        ],
      }),
      chat("chat-direct", {
        kind: "direct",
        title: null,
        members: [
          member(KinChatId.make("chat-direct")),
          {
            orgId,
            memberId: KinMemberId.make("mem-active-agent"),
            chatId: KinChatId.make("chat-direct"),
            principal: { _tag: "agent", agentId: activeAgent },
            role: "member",
            joinedAt: "2026-11-20T00:00:00.000Z",
            leftAt: null,
            mutedUntil: null,
          },
        ],
      }),
      chat("chat-company", {
        title: "Tidewater Freight",
        teamId: KIN_COMPANY_CHAT_TEAM_ID,
      }),
      chat("chat-room", {
        title: "Team room",
        teamId: KIN_TEAM_ROOM_TEAM_ID,
      }),
    ];
    const directory: KinDirectory = {
      known: true,
      me: new Set([me]),
      agentNames: new Map([
        [activeAgent, "Chief of staff"],
        [retiredAgent, "Old lead"],
      ]),
      retiredAgents: new Set([retiredAgent]),
    };
    const picked = kinPinnableChats({
      orgId,
      inbox: selectKinInboxView({ chats, waiting: [] }),
      directory,
    });
    expect(picked.map((one) => ({ chatId: one.chatId, title: one.title }))).toEqual([
      { chatId: "chat-company", title: "Tidewater Freight" },
      { chatId: "chat-room", title: "Team room" },
      { chatId: "chat-direct", title: "Chief of staff" },
    ]);
  });

  it("keeps the server's refusal sentences verbatim for pin and unpin failures", () => {
    expect(
      kinPinFailureText(
        new KinChatError({
          reason: "not_allowed",
          message: "Not everyone in this chat can see this, so it can't be pinned here.",
        }),
        "pin",
      ),
    ).toBe("Not everyone in this chat can see this, so it can't be pinned here.");
    expect(
      kinPinFailureText(
        new KinChatError({
          reason: "invalid_state",
          message: "This chat has three pins. Unpin one first.",
        }),
        "pin",
      ),
    ).toBe("This chat has three pins. Unpin one first.");
    expect(kinPinFailureText(new Error("socket closed"), "unpin")).toContain(
      KIN_PINS_COPY.unpinFailed,
    );
  });
});
