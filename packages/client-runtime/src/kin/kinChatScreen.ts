import { kinIsChiefOfStaff } from "./kinSetUp.ts";
import {
  KIN_TEAM_ROOM_TEAM_ID,
  type KinChatId,
  type KinChatMembersResult,
  type KinChatSummary,
  type KinLeadsListResult,
  type KinMessage,
} from "@t3tools/contracts";

import {
  kinAgentGroups,
  kinRetiredDirectAgentId,
  kinRetiredGroupAnswerer,
} from "./kinAgentRetire.ts";
import { kinGroupCardRows, type KinCardGroupRow } from "./kinCardGroups.ts";
import { kinFeedMessages } from "./kinCardPresentation.ts";
import {
  buildKinFeedRows,
  kinEarlierPage,
  kinUnseenCount,
  latestKinSeq,
  mergeKinFeed,
  type KinFeedRow,
  type KinFeedViewer,
  kinNewLineSeq,
  type KinNewLineHold,
} from "./kinChatFeed.ts";
import { kinFeedDisplay } from "./kinFeedDisplay.ts";
import { kinFollowsEnd, type KinFeedFollow } from "./kinFeedFollow.ts";
import { kinMentionCandidates } from "./kinGroups.ts";
import { emptyKinChat, type KinChatState } from "./kinInboxModel.ts";
import { kinIntroVisible } from "./kinIntro.ts";
import { kinChatReadOnly } from "./kinLeadPresentation.ts";
import { splitKinOutbox, type KinOutboxEntry } from "./kinOutbox.ts";
import { kinPeopleChatWith } from "./kinPeopleChat.ts";
import {
  kinAvatarView,
  kinChatMuted,
  kinChatTitle,
  kinDirectAgentName,
  kinOwnedLeadAgentId,
} from "./kinScreenState.ts";

const NO_RETIRED_AGENTS: ReadonlySet<string> = new Set();

/** A lead's charter as the empty chat's opening lines: whole when short, else cut at a word. */
function kinIntroCharter(charter: string): string | null {
  const text = charter.trim();
  if (text === "") return null;
  if (text.length <= 240) return text;
  const cut = text.slice(0, 240);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 120)).replace(/[\s.,;:]+$/, "")}…`;
}

/**
 * What a chat's screen reads besides the chat and the inbox: a direct chat's leads (the owner's
 * list, retired ones too, where they may restore), and a group's members. `orgId` is the chat's.
 */
/** How long the message a Waiting on you row opened stays tinted. */
export const KIN_LAND_MARK_MS = 1_600;

export function kinChatReads(input: {
  readonly chatId: KinChatId | null;
  readonly chats: ReadonlyArray<KinChatSummary> | null;
  readonly canRestore: boolean;
}) {
  const summary = input.chats?.find((chat) => chat.chatId === input.chatId);
  return {
    orgId: summary?.orgId ?? null,
    leads:
      summary === undefined || summary.kind !== "direct"
        ? null
        : input.canRestore
          ? ("agents" as const)
          : ("leads" as const),
    group: summary !== undefined && summary.kind !== "direct",
  };
}

/** Who a chat is with and what its screen offers, from what the client has read so far. */
export function kinChatScreen(input: {
  readonly chatId: KinChatId | null;
  readonly orgId: string;
  readonly viewer: KinFeedViewer;
  /** The inbox's chats; null until it is read. */
  readonly chats: ReadonlyArray<KinChatSummary> | null;
  /** As `kinChatReads` asks; null until read or when not asked. */
  readonly leads: KinLeadsListResult | null;
  readonly group: KinChatMembersResult | null;
  /** The viewer may restore a retired agent: their list then carries the retired ones too. */
  readonly canRestore: boolean;
  /** The host has said who the viewer is, so an untitled direct chat's name can be read. */
  readonly namesKnown: boolean;
  readonly nowMs: number;
}) {
  const { viewer, leads, group } = input;
  const summary = input.chats?.find((chat) => chat.chatId === input.chatId);
  const teamRoomId =
    input.chats?.find((chat) => chat.orgId === input.orgId && chat.teamId === KIN_TEAM_ROOM_TEAM_ID)
      ?.chatId ?? null;
  const ownedAgentId = summary === undefined ? null : kinOwnedLeadAgentId(summary, viewer.personId);
  const isGroup = summary !== undefined && summary.kind !== "direct";
  const lead =
    leads !== null && ownedAgentId !== null
      ? (leads.leads.find((held) => held.agentId === ownedAgentId) ?? null)
      : null;
  const contact =
    leads !== null && ownedAgentId === null
      ? (leads.contacts?.find((held) => held.chatId === input.chatId) ?? null)
      : null;
  const retiredAgents = viewer.retiredAgents ?? NO_RETIRED_AGENTS;
  // The profile is read after a retire or restore; the directory says it for everyone else.
  const retiredAgentId =
    lead !== null
      ? lead.retired === undefined
        ? null
        : lead.agentId
      : kinRetiredDirectAgentId(summary, retiredAgents);
  const retiredName =
    retiredAgentId === null
      ? null
      : (lead?.name ?? viewer.agentNames.get(retiredAgentId) ?? "This agent");
  const pairWith =
    summary === undefined || viewer.personId === null
      ? null
      : kinPeopleChatWith(summary, new Set([viewer.personId]));
  return {
    summary,
    isGroup,
    teamRoomId,
    ownedAgentId,
    lead,
    contact,
    /** The lead's charter, which the empty chat's intro opens with. */
    charter: lead === null ? null : kinIntroCharter(lead.charter),
    /** The viewer's own Chief of staff: its intro says what it does with What we sell's answer. */
    setsUp: lead !== null && kinIsChiefOfStaff(lead.domain),
    /** What the owner of someone else's lead wrote for the people it talks to. */
    about: contact === null || contact.intro.trim() === "" ? null : contact.intro,
    activeAgents: leads === null ? 0 : kinAgentGroups(leads.leads).active.length,
    /** A retired direct agent's name; Restore is offered only on the viewer's own, when allowed. */
    retired:
      retiredName === null
        ? null
        : {
            name: retiredName,
            restorable:
              lead !== null && lead.retired !== undefined && input.canRestore ? lead : null,
          },
    readOnly: kinChatReadOnly(summary, viewer.personId),
    pairWith,
    agentName: summary === undefined ? null : kinDirectAgentName(summary, viewer.agentNames),
    title:
      summary === undefined
        ? "Chat"
        : !input.namesKnown && summary.title === null && summary.kind === "direct"
          ? null
          : kinChatTitle(summary, viewer.agentNames),
    muted:
      summary !== undefined &&
      viewer.personId !== null &&
      kinChatMuted(summary, new Set([viewer.personId]), input.nowMs),
    avatar:
      summary === undefined
        ? null
        : kinAvatarView(
            summary,
            summary.members.find(
              (member) =>
                member.leftAt === null &&
                (member.principal._tag === "agent" ||
                  (member.principal._tag === "person" && member.principal.personId === pairWith)),
            ) ?? null,
          ),
    mentionable: kinMentionCandidates(group?.members ?? null, viewer.retiredAgents),
    silentAnswerer: kinRetiredGroupAnswerer(group, viewer.retiredAgents),
  };
}
export type KinChatScreen = ReturnType<typeof kinChatScreen>;

/** One row of a chat's feed as drawn: a feed row, a group of cards, or a send not yet acked. */
export type KinChatRow =
  | KinFeedRow
  | KinCardGroupRow
  | {
      readonly type: "pending";
      readonly key: string;
      readonly entry: KinOutboxEntry;
      readonly continues: boolean;
    };

/** Where a chat's writing area stands: a retired agent's Restore line, a read-only line, or open. */
export type KinComposerState = "retired" | "read-only" | "open";

type KinChatFeedInput = {
  readonly chatId: KinChatId;
  readonly live: KinChatState;
  /** Pages read before the stream's window. */
  readonly earlier: KinChatState;
  /** No earlier page is left to read. */
  readonly exhausted: boolean;
  readonly outbox: ReadonlyArray<KinOutboxEntry>;
  readonly viewer: KinFeedViewer;
  readonly expandedRuns: ReadonlySet<string>;
  /** The start of today, local time, for day dividers. */
  readonly dayStart: Date;
  readonly teamRoomId: KinChatId | null;
  readonly direct: boolean;
  readonly formatTime: (iso: string) => string;
  /**
   * A message the chat was opened on (a notification's, a waiting row's, a task's card), or a
   * Team-room discussion's id, which opens on its first row.
   */
  readonly landOn: string | null;
  readonly ownsLead: boolean;
  readonly agentName: string | null;
  readonly retired: boolean;
  readonly readOnly: boolean;
  /** Where the "New" line was placed; absent or null draws none. */
  readonly newLine?: KinNewLineHold | null;
};

const NEW_LINE_LABEL = "New";

/** The highest seq a chat row shows; 0 for rows that show none. */
function kinChatRowSeq(row: KinChatRow): number {
  switch (row.type) {
    case "message":
    case "system":
    case "relay":
      return row.message.seq;
    case "fold":
      return row.lastSeq;
    case "cards":
      return Math.max(
        row.first.message.seq,
        row.question?.message.seq ?? 0,
        ...row.tasks.map((task) => task.message.seq),
      );
    case "day":
    case "draft":
    case "pending":
      return 0;
  }
}

/** The "New" line, drawn as a divider before the row that holds `seq`. */
function withNewLine(rows: ReadonlyArray<KinChatRow>, seq: number | null) {
  if (seq === null) return rows;
  const index = rows.findIndex((row) => kinChatRowSeq(row) >= seq);
  if (index < 0) return rows;
  return [
    ...rows.slice(0, index),
    { type: "day" as const, key: "new-line", label: NEW_LINE_LABEL },
    ...rows.slice(index),
  ];
}

/**
 * What a chat's feed shows and in what order, and whether the person may write; scrolling does
 * not change it. The stream's messages, then earlier pages, then the outbox: acked sends join the
 * messages, the rest follow them as pending rows. Repeated notices collapse to their last copy.
 */
export function kinChatFeedRows(input: KinChatFeedInput) {
  const { live } = input;
  const streamed = mergeKinFeed(live, input.earlier);
  const { acked, pending, echoed } = splitKinOutbox(input.outbox, streamed.messages);
  const { messages } = mergeKinFeed(streamed, { ...emptyKinChat, messages: acked });
  const widgets = new Map(streamed.widgets.map((widget) => [widget.widgetId, widget]));
  const feedRows = buildKinFeedRows(
    kinFeedMessages(messages, widgets),
    input.viewer,
    input.expandedRuns,
    input.dayStart,
    live.drafts,
    input.chatId === input.teamRoomId,
  );
  const display = kinFeedDisplay({
    rows: feedRows,
    direct: input.direct,
    formatTime: input.formatTime,
  });
  const shownRows = feedRows.some((row) => display.get(row.key)?.hidden === true)
    ? feedRows.filter((row) => display.get(row.key)?.hidden !== true)
    : feedRows;
  const lastShownRow = shownRows.at(-1);
  const endsOnOwn = lastShownRow?.type === "message" && lastShownRow.own;
  const groupedRows = kinGroupCardRows(
    shownRows,
    widgets,
    new Set(
      streamed.reactions.flatMap((reaction) =>
        reaction.removedAt === null ? [reaction.messageId] : [],
      ),
    ),
  );
  const newLineSeq = kinNewLineSeq(messages, input.newLine ?? null, input.viewer.personId);
  const linedRows = withNewLine(groupedRows, newLineSeq);
  const rows: ReadonlyArray<KinChatRow> =
    pending.length === 0
      ? linedRows
      : [
          ...linedRows,
          ...pending.map((entry, index) => ({
            type: "pending" as const,
            key: `pending:${entry.clientMessageId}`,
            entry,
            continues: index > 0 || endsOnOwn,
          })),
        ];
  const { landOn } = input;
  const landIndex =
    landOn === null
      ? -1
      : rows.findIndex((row) =>
          row.type === "message"
            ? row.message.messageId === landOn || row.message.discussionId === landOn
            : row.type === "fold"
              ? row.discussionId === landOn
              : row.type === "cards" &&
                [row.question, ...row.tasks].some((card) => card?.message.messageId === landOn),
        );
  const earlierPage = kinEarlierPage(input.chatId, messages, input.exhausted, live.clearedSeq);
  // Older than what has loaded: page back to it rather than open at the end.
  const landPage = landOn !== null && landIndex < 0 ? earlierPage : null;
  const showIntro = kinIntroVisible({
    // Nobody is there to greet in a retired agent's chat.
    ownsLead: input.ownsLead && !input.retired,
    agentName: input.agentName,
    viewerPersonId: input.viewer.personId,
    messages,
    pendingCount: pending.length,
    historyIncomplete: earlierPage !== null || live.needsHistoryReload,
  });
  const composer: KinComposerState = input.retired
    ? "retired"
    : input.readOnly
      ? "read-only"
      : "open";
  return {
    streamed,
    messages,
    widgets,
    /** Outbox entries the stream now carries, for the outbox to forget. */
    echoed,
    pending,
    /** Before notices collapse and cards group: every message row the feed draws. */
    feedRows,
    rows,
    display,
    /** The row to bring into view for `landOn`; -1 until it has loaded. */
    landIndex,
    /** The page to read next to reach `landOn`; null once it has loaded or nothing is left. */
    landPage,
    latestSeq: latestKinSeq(messages),
    earlierPage,
    showIntro,
    // After a reset the feed is empty until the latest page reloads; that's not an empty chat.
    empty: rows.length === 0 && earlierPage === null && !live.needsHistoryReload,
    composer,
  };
}

/** Where the feed scrolls, apart from its rows, so a scroll recomputes only this. */
export function kinChatFeedFollow(
  messages: ReadonlyArray<KinMessage>,
  follow: KinFeedFollow,
  viewerPersonId: KinFeedViewer["personId"],
) {
  const followsEnd = kinFollowsEnd(follow);
  return {
    /** The list keeps to its end as rows arrive; otherwise it holds what is in view. */
    followsEnd,
    unseen: followsEnd ? 0 : kinUnseenCount(messages, follow.seenSeq, viewerPersonId),
  };
}

/** A chat's feed rows and where it scrolls, as one view. */
export function kinChatFeedView(input: KinChatFeedInput & { readonly follow: KinFeedFollow }) {
  const rows = kinChatFeedRows(input);
  return { ...rows, ...kinChatFeedFollow(rows.messages, input.follow, input.viewer.personId) };
}
export type KinChatFeedView = ReturnType<typeof kinChatFeedView>;
