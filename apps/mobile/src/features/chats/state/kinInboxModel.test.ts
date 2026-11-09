import type {
  KinAgentId,
  KinPresence,
  KinWakeupId,
  KinChatId,
  KinChatMember,
  KinChatSummary,
  KinMessage,
  KinWaitingItem,
  KinWidget,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  addKinChatMessage,
  applyKinChatEvent,
  applyKinChatHistory,
  applyKinInboxEvent,
  emptyKinChat,
  emptyKinInbox,
  KIN_CACHED_MESSAGE_LIMIT,
  selectKinInboxView,
  trimKinChatForCache,
  type KinChatState,
} from "./kinInboxModel";

const at = (minute: number) => `2026-11-08T09:${String(minute).padStart(2, "0")}:00.000Z`;

const chat = (id: string, overrides: Partial<KinChatSummary> = {}) =>
  ({
    orgId: "org",
    chatId: id,
    kind: "direct",
    title: id,
    teamId: null,
    lastSeq: 1,
    lastMessageAt: at(0),
    createdAt: at(0),
    archivedAt: null,
    members: [],
    lastMessage: null,
    unread: 0,
    ...overrides,
  }) as KinChatSummary;

const waiting = (id: string, chatId: string, overrides: Partial<KinWaitingItem> = {}) =>
  ({
    waitingId: id,
    orgId: "org",
    personId: "owner",
    chatId,
    messageId: null,
    widgetId: null,
    reason: "question",
    createdAt: at(0),
    resolvedAt: null,
    resolution: null,
    ...overrides,
  }) as KinWaitingItem;

const message = (seq: number, overrides: Partial<KinMessage> = {}) =>
  ({
    orgId: "org",
    chatId: "c1",
    messageId: `m${seq}`,
    seq,
    author: { _tag: "system" },
    authorRole: "owner",
    kind: "text",
    body: `message ${seq}`,
    intent: null,
    mentions: [],
    replyTo: null,
    widgetId: null,
    floorRunId: null,
    status: "posted",
    sentBy: null,
    createdAt: at(0),
    editedAt: null,
    ...overrides,
  }) as KinMessage;

const widget = (id: string, revision: number, messageId = "m1") =>
  ({
    orgId: "org",
    chatId: "c1",
    widgetId: id,
    messageId,
    widgetClass: "native",
    type: "task",
    revision,
    state: { revision },
    source: null,
    feed: null,
    awaiting: [],
    pinnedAt: null,
    closedAt: null,
    updatedAt: at(0),
  }) as unknown as KinWidget;

const member = (leftAt: string | null) =>
  ({
    orgId: "org",
    chatId: "c1",
    memberId: "me",
    principal: { _tag: "person", personId: "owner" },
    role: "owner",
    joinedAt: at(0),
    leftAt,
    mutedUntil: null,
  }) as KinChatMember;

const backlog = (
  messages: ReadonlyArray<KinMessage>,
  lastSeq: number,
  widgets: KinWidget[] = [],
  lastChangeSeq?: number,
) => ({ _tag: "backlog", messages, widgets, lastSeq, lastChangeSeq }) as const;

const chatIds = (rows: ReturnType<typeof selectKinInboxView>["rows"]) =>
  rows.map((row) => row.chat.chatId);

describe("kin inbox", () => {
  it("sorts chats with anything waiting first, then by latest activity", () => {
    const state = applyKinInboxEvent(emptyKinInbox, {
      _tag: "snapshot",
      chats: [
        chat("old", { lastMessageAt: at(1), unread: 2 }),
        chat("new", { lastMessageAt: at(9), unread: 1 }),
        chat("asks", { lastMessageAt: at(0) }),
        chat("quiet", { lastMessageAt: null, createdAt: at(5) }),
        chat("archived", { lastMessageAt: at(30), archivedAt: at(31), unread: 4 }),
      ],
      waiting: [
        waiting("w1", "asks"),
        waiting("w2", "asks"),
        waiting("done", "new", { resolvedAt: at(2), resolution: "answered" }),
      ],
    });
    const view = selectKinInboxView(state);
    expect(chatIds(view.rows)).toEqual(["asks", "new", "quiet", "old"]);
    expect(view.rows[0]!.waitingCount).toBe(2);
    expect(view.waitingCount).toBe(2);
    expect(view.unreadCount).toBe(3);
  });

  it("upserts chats without moving one backwards, and resolves waiting rows", () => {
    let state = applyKinInboxEvent(emptyKinInbox, {
      _tag: "snapshot",
      chats: [chat("a", { lastSeq: 5, unread: 1 })],
      waiting: [waiting("w1", "a")],
    });
    state = applyKinInboxEvent(state, { _tag: "chat", chat: chat("a", { lastSeq: 4, unread: 9 }) });
    expect(state.chats[0]!.unread).toBe(1);
    state = applyKinInboxEvent(state, { _tag: "chat", chat: chat("a", { lastSeq: 5, unread: 0 }) });
    expect(state.chats[0]!.unread).toBe(0);
    state = applyKinInboxEvent(state, { _tag: "chat", chat: chat("b") });
    expect(state.chats.map((c) => c.chatId)).toEqual(["a", "b"]);

    state = applyKinInboxEvent(state, { _tag: "waiting", item: waiting("w2", "b") });
    state = applyKinInboxEvent(state, {
      _tag: "waiting",
      item: waiting("w1", "a", { resolvedAt: at(3), resolution: "answered" }),
    });
    expect(state.waiting.map((w) => w.waitingId)).toEqual(["w2"]);
  });

  it("drops a chat the viewer left, with its waiting rows", () => {
    let state = applyKinInboxEvent(emptyKinInbox, {
      _tag: "snapshot",
      chats: [chat("a"), chat("b")],
      waiting: [waiting("w1", "a"), waiting("w2", "b")],
    });
    state = applyKinInboxEvent(state, { _tag: "left", chatId: "a" as KinChatId });
    expect(state.chats.map((c) => c.chatId)).toEqual(["b"]);
    expect(state.waiting.map((w) => w.waitingId)).toEqual(["w2"]);
  });

  it("replaces everything with a reconnect's fresh snapshot", () => {
    let state = applyKinInboxEvent(emptyKinInbox, {
      _tag: "snapshot",
      chats: [chat("a"), chat("b")],
      waiting: [waiting("w1", "a")],
    });
    state = applyKinInboxEvent(state, { _tag: "snapshot", chats: [chat("b")], waiting: [] });
    expect(state).toEqual({ chats: [chat("b")], waiting: [] });
  });
});

describe("kin chat feed", () => {
  const seqs = (state: KinChatState) => state.messages.map((m) => m.seq);

  it("tracks the highest contiguous seq, not the highest seen", () => {
    let state = applyKinChatEvent(emptyKinChat, backlog([message(1), message(2)], 2));
    expect(state.contiguousSeq).toBe(2);
    // A send reply lands before the stream delivers seq 3.
    state = addKinChatMessage(state, message(4));
    expect(state.contiguousSeq).toBe(2);
    state = applyKinChatEvent(state, { _tag: "message", message: message(3) });
    expect(state.contiguousSeq).toBe(4);
    state = applyKinChatEvent(state, { _tag: "message", message: message(6) });
    expect(state.contiguousSeq).toBe(4);
    expect(seqs(state)).toEqual([1, 2, 3, 4, 6]);
  });

  it("treats seqs a backlog skipped as delivered", () => {
    // Seq 2 is a suggestion this viewer can't see; the server says it sent all through 3.
    let state = applyKinChatEvent(emptyKinChat, backlog([message(1), message(3)], 3));
    expect(state.contiguousSeq).toBe(3);
    // A resumed backlog also closes a gap left open by a live event.
    state = applyKinChatEvent(state, { _tag: "message", message: message(5) });
    expect(state.contiguousSeq).toBe(3);
    state = applyKinChatEvent(state, backlog([message(5), message(6)], 6));
    expect(state.contiguousSeq).toBe(6);
    // A resumed backlog with nothing new keeps the state, so the stream emits no view.
    expect(applyKinChatEvent(state, backlog([], 6))).toBe(state);
  });

  it("replaces messages and widgets a resumed backlog changed, and keeps its change cursor", () => {
    // The window holds 2-4; 1 is older than anything held.
    let state = applyKinChatEvent(
      emptyKinChat,
      backlog([message(2), message(3), message(4)], 4, [widget("w", 1, "m2")], 5),
    );
    expect(state.changeSeq).toBe(5);
    state = applyKinChatEvent(state, { _tag: "message", message: message(5) });
    // Offline: 2 was edited, 3 deleted and the card on 2 moved on. They come back by id, below 5.
    // 1 changed too but isn't held; inserting it would make "Load earlier" skip what lies between.
    state = applyKinChatEvent(
      state,
      backlog(
        [
          message(1, { body: "edited" }),
          message(2, { body: "edited" }),
          message(3, { status: "deleted" }),
        ],
        5,
        [widget("w", 2, "m2")],
        9,
      ),
    );
    expect(seqs(state)).toEqual([2, 3, 4, 5]);
    expect(state.messages.map((m) => [m.body, m.status])).toEqual([
      ["edited", "posted"],
      ["message 3", "deleted"],
      ["message 4", "posted"],
      ["message 5", "posted"],
    ]);
    expect(state.widgets.map((w) => w.revision)).toEqual([2]);
    expect(state).toMatchObject({ contiguousSeq: 5, changeSeq: 9 });
    // A live edit to an unheld older message is dropped the same way.
    expect(
      applyKinChatEvent(state, { _tag: "message", message: message(1, { body: "live edit" }) }),
    ).toBe(state);
    // Live events never move the snapshot cursor.
    state = applyKinChatEvent(state, { _tag: "message", message: message(6, { body: "live" }) });
    state = applyKinChatEvent(state, { _tag: "widget", widget: widget("w", 3, "m2") });
    expect(state.changeSeq).toBe(9);
  });

  it("takes a mid-stream backlog's cursors without duplicating what arrived live", () => {
    let state = applyKinChatEvent(emptyKinChat, backlog([message(1)], 1, [widget("w", 1)], 3));
    // Live traffic: the change cursor stays frozen at the last backlog.
    state = applyKinChatEvent(state, { _tag: "message", message: message(2) });
    state = applyKinChatEvent(state, { _tag: "message", message: message(3) });
    state = applyKinChatEvent(state, { _tag: "widget", widget: widget("w", 2) });
    expect(state).toMatchObject({ contiguousSeq: 3, changeSeq: 3 });
    // The periodic backlog carries only seq 4, committed but not yet published live.
    state = applyKinChatEvent(state, backlog([message(4)], 4, [], 120));
    expect(state).toMatchObject({ contiguousSeq: 4, changeSeq: 120 });
    // Its late live copy and further live events leave the new cursor alone.
    state = applyKinChatEvent(state, { _tag: "message", message: message(4) });
    state = applyKinChatEvent(state, { _tag: "message", message: message(5) });
    expect(seqs(state)).toEqual([1, 2, 3, 4, 5]);
    expect(state.widgets.map((w) => w.revision)).toEqual([2]);
    expect(state).toMatchObject({ contiguousSeq: 5, changeSeq: 120 });
  });

  it("keeps the highest widget revision", () => {
    let state = applyKinChatEvent(emptyKinChat, backlog([message(1)], 1, [widget("w", 2)]));
    const stale = applyKinChatEvent(state, { _tag: "widget", widget: widget("w", 1) });
    expect(stale).toBe(state);
    state = applyKinChatEvent(state, { _tag: "widget", widget: widget("w", 3) });
    expect(state.widgets.map((w) => w.revision)).toEqual([3]);
  });

  it("asks for a history reload after a reset and clears it once a page lands", () => {
    let state = applyKinChatEvent(emptyKinChat, backlog([message(1)], 1, [widget("w", 1)]));
    state = applyKinChatEvent(state, { _tag: "reset", lastSeq: 400, lastChangeSeq: 412 });
    expect(state).toMatchObject({
      messages: [],
      widgets: [],
      contiguousSeq: 400,
      changeSeq: 412,
      needsHistoryReload: true,
    });
    state = applyKinChatHistory(state, {
      messages: [message(399), message(400)],
      widgets: [],
      hasMore: true,
    });
    expect(seqs(state)).toEqual([399, 400]);
    expect(state.needsHistoryReload).toBe(false);
    expect(state.contiguousSeq).toBe(400);
  });

  it("marks the chat left only for a member event with leftAt", () => {
    const state = applyKinChatEvent(emptyKinChat, backlog([], 0));
    expect(applyKinChatEvent(state, { _tag: "member", member: member(null) }).left).toBe(false);
    expect(applyKinChatEvent(state, { _tag: "member", member: member(at(4)) }).left).toBe(true);
  });

  it("moves read marks forward only", () => {
    let state = applyKinChatEvent(emptyKinChat, { _tag: "read", memberId: "me" as never, seq: 5 });
    state = applyKinChatEvent(state, { _tag: "read", memberId: "me" as never, seq: 3 });
    expect(state.reads).toEqual({ me: 5 });
  });

  it("caches the latest messages and only the widgets they anchor", () => {
    const messages = Array.from({ length: KIN_CACHED_MESSAGE_LIMIT + 10 }, (_, i) =>
      message(i + 1),
    );
    const state = applyKinChatEvent(
      emptyKinChat,
      backlog(messages, messages.length, [
        widget("early", 1, "m1"),
        widget("late", 1, `m${messages.length}`),
      ]),
    );
    const cached = trimKinChatForCache(state);
    expect(cached.messages).toHaveLength(KIN_CACHED_MESSAGE_LIMIT);
    expect(cached.messages[0]!.seq).toBe(11);
    expect(cached.widgets.map((w) => w.widgetId)).toEqual(["late"]);
    expect(cached.contiguousSeq).toBe(messages.length);
    expect(trimKinChatForCache({ ...state, drafts: [draft], presence: [thinking] })).toMatchObject({
      drafts: [],
      presence: [],
    });
  });
});

const LEAD = "lead" as KinAgentId;
const lead = {
  _tag: "agent",
  agentId: LEAD,
  memberId: "lm",
  ownerPersonId: "owner",
  threadId: "t",
} as KinMessage["author"];
const draft = { draftId: "d1", agentId: LEAD, text: "Hi", startedAt: at(1) };
const thinking: KinPresence = {
  agentId: LEAD,
  wakeupId: "w1" as KinWakeupId,
  state: "thinking",
  label: null,
  startedAt: at(0),
  since: at(0),
};
const delta = (offset: number, text: string, draftId = "d1") =>
  ({ _tag: "draft", draftId, agentId: LEAD, offset, text }) as const;

describe("kin streaming reply", () => {
  it("grows a draft by matching offsets and ignores a delta that doesn't fit", () => {
    let state = applyKinChatEvent(emptyKinChat, delta(3, "lost start"), at(1));
    expect(state.drafts).toEqual([]);
    state = applyKinChatEvent(state, delta(0, "Hi"), at(1));
    state = applyKinChatEvent(state, delta(2, " there"), at(2));
    // A gap or a replay holds the text as is, until the message or a backlog brings it all.
    expect(applyKinChatEvent(state, delta(3, "x"), at(3))).toBe(state);
    expect(applyKinChatEvent(state, delta(2, " there"), at(3))).toBe(state);
    expect(state.drafts).toEqual([{ ...draft, text: "Hi there", startedAt: at(1) }]);
  });

  it("swaps the draft for its durable message once, and a late delta can't bring it back", () => {
    let state = applyKinChatEvent(emptyKinChat, delta(0, "Hi"), at(1));
    const reply = message(1, { author: lead, body: "Hi there", clientMessageId: "reply:d1" });
    state = applyKinChatEvent(state, { _tag: "message", message: reply });
    expect(state.drafts).toEqual([]);
    expect(state.messages).toEqual([reply]);
    expect(applyKinChatEvent(state, delta(0, "Hi"), at(2))).toBe(state);
    // Without a reply id, the same agent's message grown from the draft settles it.
    state = applyKinChatEvent(state, delta(0, "Next", "d2"), at(2));
    state = applyKinChatEvent(state, {
      _tag: "message",
      message: message(2, { author: lead, body: "Next one" }),
    });
    expect(state.drafts).toEqual([]);
    // `end` drops a draft whose text was never posted.
    state = applyKinChatEvent(state, delta(0, "Draft", "d3"), at(3));
    state = applyKinChatEvent(state, { ...delta(5, "", "d3"), end: { messageId: null } }, at(3));
    expect(state.drafts).toEqual([]);
  });

  it("takes drafts and presence from a backlog, and drops a draft whose run ended", () => {
    let state = applyKinChatEvent(emptyKinChat, delta(0, "Hi"), at(1));
    state = applyKinChatEvent(
      state,
      {
        ...backlog([], 0),
        drafts: [
          { draftId: "d1", agentId: LEAD, text: "Hi there" },
          { draftId: "d2", agentId: LEAD, text: "Also" },
        ],
        presence: [thinking],
      },
      at(5),
    );
    expect(state.drafts.map((d) => [d.text, d.startedAt])).toEqual([
      ["Hi there", at(1)],
      ["Also", at(5)],
    ]);
    expect(state.presence).toEqual([thinking]);
    state = applyKinChatEvent(state, { _tag: "presence", agentId: LEAD, presence: null });
    expect(state).toMatchObject({ drafts: [], presence: [] });
  });
});
