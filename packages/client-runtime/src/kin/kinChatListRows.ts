import {
  KIN_COMPANY_CHAT_TEAM_ID,
  KIN_TEAM_ROOM_TEAM_ID,
  kinIsPeopleChat,
  type KinChatMembersResult,
  type KinChatSummary,
} from "@t3tools/contracts";

import { KIN_RETIRED_LABEL, kinRetiredDirectAgentId } from "./kinAgentRetire.ts";
import { kinAttachmentSummary } from "./kinAttachments.ts";
import type { KinInboxView } from "./kinInboxModel.ts";
import { kinMessageableAgents, type KinNewChatAgent } from "./kinPeopleChat.ts";
import {
  kinChatRowLabel,
  kinChatRowView,
  type KinChatRowView,
  type KinDirectory,
} from "./kinScreenState.ts";

export interface KinChatListRow {
  readonly chat: KinChatSummary;
  readonly view: KinChatRowView;
  /** "You" in "You: on it"; a lead's name only where more than one could have written it. */
  readonly author: string | null;
  readonly preview: string;
  readonly needsYou: boolean;
  readonly working: boolean;
  /** Nobody has written here yet. */
  readonly fresh: boolean;
  /** A direct chat whose agent is retired: kept to read, listed after everything else. */
  readonly retired: boolean;
  /** The company chat, everyone on the team in it: always first. */
  readonly company: boolean;
  /** The agents' Team room: muted for good, after the company chat. */
  readonly teamRoom: boolean;
  /** Something new in the Team room: a quiet dot, never a count or a badge. */
  readonly quietNew: boolean;
}

// A card posted without words has no body to preview, so its id's prefix says what it was.
const CARD_PREVIEWS: ReadonlyArray<readonly [prefix: string, preview: string]> = [
  ["choice:", "Asked you a question"],
  ["chart:", "Sent a chart"],
  ["visual:", "Sent a visual"],
  ["approval:", "Needs your approval"],
  ["task:", "Started a task"],
  ["reminder:", "Reminder"],
  ["scheduled:", "Scheduled task"],
];

function previewOf(chat: KinChatSummary, view: KinChatRowView): string {
  const last = chat.lastMessage;
  if (last === null) return "No messages yet";
  if (last.status === "deleted") return view.preview;
  if (last.body.trim() === "" && last.widgetId !== null) {
    const { widgetId } = last;
    return CARD_PREVIEWS.find(([prefix]) => widgetId.startsWith(prefix))?.[1] ?? "Sent a card";
  }
  if (last.body.trim() === "" && last.attachments !== undefined)
    return kinAttachmentSummary(last.attachments);
  return view.preview;
}

/**
 * A chat between two people whose other person's access was removed, with nothing written since:
 * off the list, its history kept. A new message, or their return, puts it back.
 */
function endedPeopleChat(chat: KinChatSummary, me: ReadonlySet<string>): boolean {
  if (!kinIsPeopleChat(chat)) return false;
  const other = chat.members.find(
    (member) => member.principal._tag === "person" && !me.has(member.principal.personId),
  );
  // Unread words stay listed, so the badge never counts a row that isn't there.
  if (other === undefined || other.leftAt === null || chat.unread > 0) return false;
  const last = chat.lastMessage;
  return last === null || Date.parse(last.createdAt) <= Date.parse(other.leftAt);
}

/**
 * The chat list in one order: chats that wait on the viewer, then working ones, then the rest by
 * latest message, then chats nobody has written in yet, and a retired agent's chats last.
 */
export function kinChatListRows(
  inbox: KinInboxView,
  directory: KinDirectory,
): ReadonlyArray<KinChatListRow> {
  const shown = inbox.rows.filter((row) => !endedPeopleChat(row.chat, directory.me));
  const rows = shown.map((row): KinChatListRow => {
    const view = kinChatRowView(row, directory);
    const retired = kinRetiredDirectAgentId(row.chat, directory.retiredAgents) !== null;
    const fresh = row.chat.lastMessage === null;
    return {
      chat: row.chat,
      view,
      author: view.author === "You" || row.chat.kind !== "direct" ? view.author : null,
      // Nobody is there to say hello to.
      preview: retired && fresh ? KIN_RETIRED_LABEL : previewOf(row.chat, view),
      needsYou: row.fold === "needsYou",
      working: row.chat.working === true,
      fresh,
      retired,
      company: row.chat.teamId === KIN_COMPANY_CHAT_TEAM_ID,
      teamRoom: row.chat.teamId === KIN_TEAM_ROOM_TEAM_ID,
      quietNew: row.chat.fresh === true,
    };
  });
  const live = rows.filter((row) => !row.retired && !row.company && !row.teamRoom);
  const settled = (row: KinChatListRow) => row.fresh && !row.needsYou && !row.working;
  return [
    ...rows.filter((row) => row.company),
    ...rows.filter((row) => row.teamRoom),
    ...live.filter((row) => !settled(row)),
    ...live.filter(settled),
    ...rows.filter((row) => row.retired),
  ];
}

/** "Tech lead, agent. Payments test fixed. 9:30. 3 unread. Working." */
export function kinChatListRowLabel(row: KinChatListRow, time: (date: Date) => string): string {
  const label = kinChatRowLabel({ ...row.view, author: row.author, preview: row.preview }, time);
  return [
    label,
    row.retired && row.preview !== KIN_RETIRED_LABEL ? "Retired." : null,
    row.working ? "Working." : null,
    row.needsYou ? "Needs you." : null,
    row.quietNew ? "New messages." : null,
  ]
    .filter((part) => part !== null)
    .join(" ");
}

/**
 * The agents the host lets the viewer message that have no chat with them yet, listed under the
 * chats with what each is for. Not chats: nothing here is unread or raises a badge.
 */
export function kinChatListAgents(
  chats: ReadonlyArray<Pick<KinChatSummary, "kind" | "members">>,
  leads: Parameters<typeof kinMessageableAgents>[0],
  me: ReadonlySet<string>,
): ReadonlyArray<KinNewChatAgent> {
  const talking = new Set(
    chats
      .filter(
        (chat) =>
          chat.kind === "direct" &&
          chat.members.some(
            (member) => member.principal._tag === "person" && me.has(member.principal.personId),
          ),
      )
      .flatMap((chat) =>
        chat.members.flatMap((member) =>
          member.principal._tag === "agent" ? [member.principal.agentId] : [],
        ),
      ),
  );
  return kinMessageableAgents(leads).filter((agent) => !talking.has(agent.agentId));
}

/** Above the agents not yet talked to: each row opens a chat with that agent. */
export const KIN_CHATS_AGENTS_TITLE = "Agents you can message";

/** One line on the first Chats screen until the person dismisses it on this phone. */
export const KIN_CHATS_INTRO = {
  line: "Kin is your company's assistant: tell one of its agents what you need, and it gets started.",
  dismiss: "Dismiss",
} as const;

/** A teammate's first look, before anyone has started a chat with them. */
export const KIN_TEAMMATE_WELCOME = {
  title: "Welcome to the team",
  detail: "When someone on your team starts a chat with you, it shows up here.",
};

/** Who is in a group, people then agents: "You, Priya, Sam · Chief of staff, Finance". */
export function kinRoomLine(
  members: KinChatMembersResult["members"],
  me: ReadonlySet<string>,
): string {
  const here = members.filter((member) => member.leftAt === null);
  const mine = here.some(
    (member) => member.principal._tag === "person" && me.has(member.principal.personId),
  );
  const others = here.flatMap((member) =>
    member.principal._tag === "person" && !me.has(member.principal.personId)
      ? [member.displayName]
      : [],
  );
  const agents = here
    .filter((member) => member.principal._tag === "agent")
    .map((member) => member.displayName);
  return [[...(mine ? ["You"] : []), ...others].join(", "), agents.join(", ")]
    .filter((part) => part !== "")
    .join(" · ");
}

/** The chat list with no chats yet, for the owner and for a teammate. */
export const KIN_CHATS_EMPTY = {
  title: "No chats yet",
  none: "Chats with your agents show up here.",
  chiefPitch:
    "Start with a Chief of staff: your front door for everything. You chat with it like a colleague, and it passes work to the agents you add later.",
  firstAgent: "Create your first agent",
} as const;
