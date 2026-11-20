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
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  KIN_FIXTURE_AGENT,
  KIN_FIXTURE_CHAT_ID,
  KIN_FIXTURE_OWNER,
  makeKinFixtureMessages,
} from "./kinChatFixtures.ts";
import type { KinFeedViewer } from "./kinChatFeed.ts";
import {
  kinChatFeedFollow,
  kinChatFeedRows,
  kinChatFeedView,
  kinChatReads,
  kinChatScreen,
} from "./kinChatScreen.ts";
import { initialKinFeedFollow, resolveKinFeedFollow } from "./kinFeedFollow.ts";
import { emptyKinChat } from "./kinInboxModel.ts";
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
