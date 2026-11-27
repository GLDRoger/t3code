// @effect-diagnostics globalDate:off - Fixtures build day starts relative to a fixed clock.
import {
  KIN_TEAM_ROOM_TEAM_ID,
  type EnvironmentId,
  type KinChatId,
  type KinChatMember,
  type KinChatSummary,
  type KinLeadsListResult,
  type KinMemberId,
  type KinMessage,
  type KinOrgId,
  type KinPresence,
  type KinWakeupId,
  type KinWidgetId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  KIN_FIXTURE_AGENT,
  KIN_FIXTURE_CHAT_ID,
  KIN_FIXTURE_OWNER,
  makeKinFixtureMessages,
} from "./kinChatFixtures.ts";
import { KIN_HISTORY_PAGE_SIZE, kinSeqToMarkRead, type KinFeedViewer } from "./kinChatFeed.ts";
import {
  kinChatFeedFollow,
  kinChatFeedRows,
  kinChatFeedView,
  kinChatReads,
  kinChatScreen,
} from "./kinChatScreen.ts";
import { initialKinFeedFollow, resolveKinFeedFollow } from "./kinFeedFollow.ts";
import {
  applyKinChatEvent,
  applyKinChatHistory,
  emptyKinChat,
  trimKinChatForCache,
} from "./kinInboxModel.ts";
import type { KinOutboxEntry } from "./kinOutbox.ts";

const ORG = "fixture-org" as KinOrgId;
const AT = "2026-11-08T08:00:00.000Z";
const viewer: KinFeedViewer = {
  personId: KIN_FIXTURE_OWNER,
  agentNames: new Map([[KIN_FIXTURE_AGENT, "Chief of staff"]]),
};

const member = (
  principal: KinChatMember["principal"],
  role: KinChatMember["role"],
  memberId: string,
): KinChatMember => ({
  orgId: ORG,
  chatId: KIN_FIXTURE_CHAT_ID,
  memberId: memberId as KinMemberId,
  principal,
  role,
  joinedAt: AT,
  leftAt: null,
  mutedUntil: null,
});
const chat = (fields: Partial<KinChatSummary> = {}): KinChatSummary => ({
  orgId: ORG,
  chatId: KIN_FIXTURE_CHAT_ID,
  kind: "direct",
  title: null,
  teamId: null,
  lastSeq: 0,
  lastMessageAt: null,
  createdAt: AT,
  archivedAt: null,
  members: [
    member({ _tag: "person", personId: KIN_FIXTURE_OWNER }, "owner", "member-owner"),
    member({ _tag: "agent", agentId: KIN_FIXTURE_AGENT }, "member", "member-lead"),
  ],
  lastMessage: null,
  unread: 0,
  ...fields,
});
const teamRoom = chat({
  chatId: "team-room" as KinChatId,
  kind: "team_group",
  teamId: KIN_TEAM_ROOM_TEAM_ID,
  title: "Team",
});
const leadsOf = (retired: boolean): KinLeadsListResult =>
  ({
    leads: [
      {
        agentId: KIN_FIXTURE_AGENT,
        orgId: ORG,
        name: "Chief of staff",
        charter: "Keeps Rhea's week in order.",
        ...(retired ? { retired: { at: AT } } : {}),
      },
    ],
  }) as never;

const screen = (fields: Partial<Parameters<typeof kinChatScreen>[0]> = {}) =>
  kinChatScreen({
    chatId: KIN_FIXTURE_CHAT_ID,
    orgId: ORG,
    viewer,
    chats: [chat(), teamRoom],
    leads: null,
    group: null,
    canRestore: true,
    namesKnown: true,
    nowMs: Date.parse(AT),
    ...fields,
  });

describe("kinChatReads", () => {
  it("reads a direct chat's leads, the full list where the viewer may restore, and a group's members", () => {
    const chats = [chat(), teamRoom];
    expect(kinChatReads({ chatId: KIN_FIXTURE_CHAT_ID, chats, canRestore: true })).toEqual({
      orgId: ORG,
      leads: "agents",
      group: false,
    });
    expect(kinChatReads({ chatId: KIN_FIXTURE_CHAT_ID, chats, canRestore: false }).leads).toBe(
      "leads",
    );
    expect(kinChatReads({ chatId: teamRoom.chatId, chats, canRestore: true })).toEqual({
      orgId: ORG,
      leads: null,
      group: true,
    });
    // Before the inbox is read, nothing else is.
    expect(kinChatReads({ chatId: KIN_FIXTURE_CHAT_ID, chats: null, canRestore: true })).toEqual({
      orgId: null,
      leads: null,
      group: false,
    });
  });
});

describe("kinChatScreen", () => {
  it("finds the chat, the org's Team room and the viewer's own lead", () => {
    const view = screen({ leads: leadsOf(false) });
    expect(view.summary?.chatId).toBe(KIN_FIXTURE_CHAT_ID);
    expect(view.teamRoomId).toBe(teamRoom.chatId);
    expect(view.ownedAgentId).toBe(KIN_FIXTURE_AGENT);
    expect(view.lead?.name).toBe("Chief of staff");
    expect(view.charter).toBe("Keeps Rhea's week in order.");
    expect(view.title).toBe("Chief of staff");
    expect([view.retired, view.readOnly, view.activeAgents]).toEqual([null, false, 1]);
  });

  it("offers Restore on a retired lead only to a viewer who may restore", () => {
    expect(screen({ leads: leadsOf(true) }).retired).toMatchObject({
      name: "Chief of staff",
      restorable: { agentId: KIN_FIXTURE_AGENT },
    });
    expect(screen({ leads: leadsOf(true), canRestore: false }).retired).toEqual({
      name: "Chief of staff",
      restorable: null,
    });
  });

  it("holds an untitled direct chat's name until the host says who the viewer is", () => {
    expect(screen({ namesKnown: false }).title).toBeNull();
    expect(screen({ chats: null }).title).toBe("Chat");
  });
});

const messages = makeKinFixtureMessages(4);
const ownBody = (message: KinMessage) => message.body;
const pendingEntry = (clientMessageId: string, sent: KinMessage | null = null): KinOutboxEntry => ({
  environmentId: "env" as EnvironmentId,
  chatId: KIN_FIXTURE_CHAT_ID,
  clientMessageId,
  body: "Invented follow-up",
  createdAt: AT,
  error: null,
  state: sent === null ? "waiting" : "sent",
  sent,
});
const feedInput = (
  fields: Partial<Parameters<typeof kinChatFeedView>[0]> = {},
): Parameters<typeof kinChatFeedView>[0] => ({
  chatId: KIN_FIXTURE_CHAT_ID,
  live: { ...emptyKinChat, messages },
  earlier: emptyKinChat,
  exhausted: true,
  outbox: [],
  viewer,
  expandedRuns: new Set(),
  dayStart: new Date(Date.parse("2026-11-08T00:00:00.000Z")),
  teamRoomId: null,
  direct: true,
  formatTime: (iso) => iso.slice(11, 16),
  follow: initialKinFeedFollow(4),
  landOn: null,
  caughtUp: true,
  ownsLead: true,
  agentName: "Chief of staff",
  retired: false,
  readOnly: false,
  ...fields,
});
const feed = (fields: Partial<Parameters<typeof kinChatFeedView>[0]> = {}) =>
  kinChatFeedView(feedInput(fields));
const keys = (view: ReturnType<typeof feed>) => view.rows.map((row) => row.key);

describe("kinChatFeedView", () => {
  it("puts unsent messages after the feed, and lets the outbox forget what the stream carries", () => {
    const shown = keys(feed());
    const view = feed({
      outbox: [pendingEntry("c-1"), pendingEntry("c-2")],
    });
    expect(keys(view)).toEqual([...shown, "pending:c-1", "pending:c-2"]);
    // The first follows an agent reply, so it starts a run; the second continues it.
    expect(view.rows.slice(-2).map((row) => row.type === "pending" && row.continues)).toEqual([
      false,
      true,
    ]);
    const echoed = { ...messages[0]!, clientMessageId: "c-1" } as KinMessage;
    const carried = feed({
      live: { ...emptyKinChat, messages: [echoed, ...messages.slice(1)] },
      outbox: [pendingEntry("c-1")],
    });
    expect(carried.echoed).toEqual(["c-1"]);
    expect(carried.pending).toEqual([]);
  });

  it("shows an acked send as a message until the stream carries it", () => {
    const sent = { ...messages[2]!, messageId: "sent-5", seq: 5, body: "Invented acked" };
    const view = feed({ outbox: [pendingEntry("c-3", sent as KinMessage)] });
    expect(view.pending).toEqual([]);
    expect(view.messages.map(ownBody).at(-1)).toBe("Invented acked");
    expect(view.latestSeq).toBe(5);
  });

  const wakeupId = "pickup-turn" as KinWakeupId;
  const otherWakeupId = "other-turn" as KinWakeupId;
  const presence: KinPresence = {
    agentId: KIN_FIXTURE_AGENT,
    wakeupId,
    state: "working",
    label: null,
    startedAt: AT,
    since: AT,
  };
  const prior = messages[0]!;
  const ask = (seq: number): KinMessage => ({
    ...messages[1]!,
    seq,
    messageId: `pickup-card-${seq}` as KinMessage["messageId"],
    widgetId: `choice:pickup-card-${seq}` as KinWidgetId,
    body: "",
    sourceWakeupId: wakeupId,
    ordinaryTurnAsk: true,
  });
  const first = ask(2);
  const second = ask(3);
  const words: KinMessage = {
    ...messages[1]!,
    seq: 4,
    body: "Rhea, Tidewater Freight can collect on either day.",
    sourceWakeupId: wakeupId,
  };
  const append = (
    state: typeof emptyKinChat,
    ...events: ReadonlyArray<Parameters<typeof applyKinChatEvent>[1]>
  ) => events.reduce((held, event) => applyKinChatEvent(held, event, AT), state);
  const working = append(
    { ...emptyKinChat, messages: [prior] },
    { _tag: "presence", agentId: presence.agentId, presence },
    { _tag: "message", message: first },
  );
  const ended = { _tag: "presence", agentId: presence.agentId, presence: null } as const;
  const order = (view: ReturnType<typeof feed>) =>
    view.feedRows.flatMap((row) => (row.type === "message" ? [row.message.messageId] : []));

  it.each([
    ["card first", working, [prior.messageId]],
    [
      "first posted words and two cards",
      append(working, { _tag: "message", message: second }, { _tag: "message", message: words }),
      [prior.messageId, words.messageId, first.messageId, second.messageId],
    ],
    [
      "interleaved messages do not split two cards away from their reply",
      append(
        working,
        {
          _tag: "message",
          message: { ...prior, messageId: "extra" as KinMessage["messageId"], seq: 3 },
        },
        { _tag: "message", message: ask(4) },
        { _tag: "message", message: { ...words, seq: 5 } },
      ),
      [prior.messageId, "extra", words.messageId, first.messageId, ask(4).messageId],
    ],
    [
      "wordless end with two cards",
      append(working, { _tag: "message", message: second }, ended),
      [prior.messageId, first.messageId, second.messageId],
    ],
    [
      "Stop clears presence without posting held words",
      append(
        working,
        {
          _tag: "draft",
          draftId: "discarded",
          agentId: presence.agentId,
          sourceWakeupId: wakeupId,
          offset: 0,
          text: "Half the answer",
        },
        ended,
      ),
      [prior.messageId, first.messageId],
    ],
    [
      "presence moves to another wake-up",
      append(working, { ...ended, presence: { ...presence, wakeupId: otherWakeupId } }),
      [prior.messageId, first.messageId],
    ],
    [
      "joined row fills in place",
      append(working, { _tag: "message", message: { ...first, body: words.body } }),
      [prior.messageId, first.messageId],
    ],
    [
      "an older host, Confirm or run control never waits",
      { ...working, messages: [prior, { ...first, ordinaryTurnAsk: undefined }] },
      [prior.messageId, first.messageId],
    ],
    [
      "false opts out",
      { ...working, messages: [prior, { ...first, ordinaryTurnAsk: false }] },
      [prior.messageId, first.messageId],
    ],
    ["no known running turn", { ...working, presence: [] }, [prior.messageId, first.messageId]],
  ] as const)("%s", (_label, live, expected) => {
    expect(order(feed({ live }))).toEqual(expected);
  });

  it("keeps an ask hidden through cache reload, a fresh backlog, a checkpoint and a reset", () => {
    const cached = trimKinChatForCache({ ...working, contiguousSeq: first.seq });
    expect([order(feed({ live: cached, caughtUp: false })), cached.contiguousSeq]).toEqual([
      [prior.messageId],
      prior.seq,
    ]);
    const backlog = {
      _tag: "backlog",
      lastSeq: first.seq,
      messages: [first],
      widgets: [],
      presence: [presence],
    } as const;
    const reloaded = append(cached, backlog);
    expect(order(feed({ live: reloaded }))).toEqual([prior.messageId]);
    const checkpointed = append(reloaded, {
      _tag: "backlog",
      lastSeq: first.seq,
      messages: [],
      widgets: [],
    });
    expect(order(feed({ live: checkpointed }))).toEqual([prior.messageId]);
    const reset = append(emptyKinChat, {
      _tag: "reset",
      lastSeq: first.seq,
      presence: [presence],
    });
    const page = applyKinChatHistory(reset, {
      messages: [prior, first],
      widgets: [],
      hasMore: false,
    });
    expect(order(feed({ live: page }))).toEqual([prior.messageId]);
    const reconnected = append(reloaded, { ...backlog, presence: [] });
    expect(order(feed({ live: reconnected }))).toEqual([prior.messageId, first.messageId]);
  });

  it("does not mark or seek past a held deep-link target, even when other rows have arrived", () => {
    const priorSeq = prior.seq + 10;
    const later = { ...words, seq: words.seq + 10, sourceWakeupId: otherWakeupId };
    const live = append(
      {
        ...working,
        messages: working.messages.map((message) => ({ ...message, seq: message.seq + 10 })),
      },
      { _tag: "message", message: later },
    );
    const follow = resolveKinFeedFollow(initialKinFeedFollow(priorSeq), {
      type: "navigated",
      seq: priorSeq,
    });
    const target = { exhausted: false, landOn: first.messageId, follow };
    const pending = feed({ ...target, live });
    const mark = (view: ReturnType<typeof feed>) =>
      kinSeqToMarkRead({
        seesEnd: true,
        latestSeq: view.latestSeq,
        markedSeq: priorSeq,
        attemptedSeq: priorSeq,
        unread: 2,
      });
    expect(pending.earlierPage).not.toBeNull();
    expect(pending).toMatchObject({ unseen: 1, landPage: null, openRow: null });
    expect(mark(pending)).toBeNull();
    const released = feed({ ...target, live: append(live, ended) });
    expect(released).toMatchObject({ unseen: 2, openRow: { kind: "land", key: first.messageId } });
    expect(mark(released)).toBe(later.seq);
  });

  it("keeps the last copy of a notice the host repeated", () => {
    const notice = (seq: number) =>
      ({
        ...messages[1]!,
        messageId: `notice-${seq}`,
        seq,
        kind: "system",
        author: { _tag: "system" },
        body: "Invented: the lead could not reply.",
      }) as KinMessage;
    const view = feed({
      live: { ...emptyKinChat, messages: [...messages, notice(5), notice(6)] },
    });
    expect(view.rows.filter((row) => row.type === "system")).toHaveLength(1);
    expect(view.feedRows.filter((row) => row.type === "system")).toHaveLength(2);
  });

  it("finds the row a notification opened on, once it has loaded", () => {
    expect(feed({ landOn: "fixture-3" }).landIndex).toBe(
      keys(feed()).findIndex((key) => key.includes("fixture-3")),
    );
    expect(feed({ landOn: "fixture-3" }).landIndex).toBeGreaterThan(-1);
    expect(feed({ landOn: "fixture-99" }).landIndex).toBe(-1);
    // A Team-room discussion opens on its first row.
    const discussed = messages.map((m) =>
      m.seq >= 3 ? { ...m, discussionId: "TD-1" as KinMessage["discussionId"] } : m,
    );
    expect(feed({ live: { ...emptyKinChat, messages: discussed }, landOn: "TD-1" }).landIndex).toBe(
      keys(feed()).findIndex((key) => key.includes("fixture-3")),
    );
    // Older than what has loaded: the chat reads back to it instead of opening at the end.
    const later = { ...emptyKinChat, messages: messages.map((m) => ({ ...m, seq: m.seq + 50 })) };
    expect(feed({ live: later, exhausted: false, landOn: "fixture-99" }).landPage).toEqual({
      chatId: KIN_FIXTURE_CHAT_ID,
      beforeSeq: messages[0]!.seq + 50,
      limit: KIN_HISTORY_PAGE_SIZE,
    });
    expect(feed({ live: later, exhausted: false, landOn: "fixture-3" }).landPage).toBeNull();
    expect(feed({ live: later, exhausted: true, landOn: "fixture-99" }).landPage).toBeNull();
    expect(feed({ live: later, exhausted: false }).landPage).toBeNull();
    // Only the saved copy shows, as on a cold start from a push: a message it lacks is likelier
    // newer than older, so the chat waits for the stream instead of reading back.
    const saved = feed({ live: later, exhausted: false, landOn: "fixture-99", caughtUp: false });
    expect([saved.landPage, saved.openRow]).toEqual([null, null]);
  });

  it("draws the New line before the first unanswered row and opens on it unless a message was asked for", () => {
    const shown = keys(feed());
    // After the mark at 2: message 3 is the owner's own, 4 is the lead's.
    const at = shown.findIndex((key) => key.includes("fixture-4"));
    const newLine = { chatId: KIN_FIXTURE_CHAT_ID, mark: 2, upTo: 4 };
    const view = feed({ newLine });
    expect(keys(view)).toEqual([...shown.slice(0, at), "new-line", ...shown.slice(at)]);
    expect(view.rows[at]).toMatchObject({ type: "day", label: "New" });
    expect(view.openRow).toEqual({
      kind: "new-line",
      key: "new-line",
      index: at,
      viewPosition: 0.08,
    });
    expect(keys(feed())).not.toContain("new-line");
    expect(feed().openRow).toBeNull();
    // An explicit target wins over the New line, including while paging back to load it.
    const landed = feed({ newLine, landOn: "fixture-2" });
    expect(landed.openRow).toEqual({
      kind: "land",
      key: "fixture-2",
      index: landed.landIndex,
      viewPosition: 0.3,
    });
    expect(feed({ newLine, landOn: "fixture-99" }).openRow).toBeNull();
  });

  it("follows the end until the reader scrolls away, then counts what they have not seen", () => {
    expect([feed().followsEnd, feed().unseen]).toEqual([true, 0]);
    const away = resolveKinFeedFollow(initialKinFeedFollow(2), { type: "navigated", seq: 2 });
    const view = feed({ follow: away });
    expect(view.followsEnd).toBe(false);
    // Messages 3 and 4: one from the lead, one the owner wrote, which they have seen.
    expect(view.unseen).toBe(1);
    // Read apart from the rows, so scrolling leaves the rows as they were.
    const { follow: _follow, ...rowsInput } = feedInput({ follow: away });
    const rows = kinChatFeedRows(rowsInput);
    expect(kinChatFeedFollow(rows.messages, away, viewer.personId)).toEqual({
      followsEnd: false,
      unseen: 1,
    });
    expect(rows.rows).toEqual(view.rows);
  });

  it("clears a turn's progress update once its reply is in, as the host's setting says", () => {
    const turn = "0b7e4d1a-2c3f-4a5b-8d9e-1f2a3b4c5d6e" as KinWakeupId;
    const held = messages.map((message) =>
      message.seq === 2
        ? { ...message, sourceWakeupId: turn, progress: true as const }
        : message.seq === 4
          ? { ...message, sourceWakeupId: turn }
          : message,
    );
    const shown = (clearUpdates: boolean) =>
      keys(feed({ live: { ...emptyKinChat, messages: held, clearUpdates } }));
    expect(shown(false)).toContain("fixture-2");
    expect(shown(true)).not.toContain("fixture-2");
    expect(shown(true)).toContain("fixture-4");
  });

  it("says where the composer stands", () => {
    expect(feed().composer).toBe("open");
    expect(feed({ readOnly: true }).composer).toBe("read-only");
    expect(feed({ retired: true, readOnly: true }).composer).toBe("retired");
  });

  it("calls a chat empty only when no history is still to come", () => {
    const none = { ...emptyKinChat, messages: [] };
    expect(feed({ live: none }).empty).toBe(true);
    expect(feed({ live: { ...none, needsHistoryReload: true } }).empty).toBe(false);
    // An empty chat with the viewer's own lead greets them, unless the lead is retired.
    expect(feed({ live: none }).showIntro).toBe(true);
    expect(feed({ live: none, retired: true }).showIntro).toBe(false);
  });
});
