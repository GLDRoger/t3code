import {
  KinMessageId,
  type KinChatId,
  type KinRecordDetail,
  type KinRecordLink,
  type KinRecordRef,
} from "@t3tools/contracts";

import { kinRecordName } from "./kinLists.ts";
import type { KinNotificationDestination } from "./kinNotificationDestination.ts";
import type { KinWorkLinkView } from "./kinWork.ts";

type RecordKind = Extract<KinNotificationDestination, { readonly _tag: "record" }>["kind"];

const KIN_LINKED_GROUPS = [
  "tasks",
  "projects",
  "client",
  "money",
  "docs",
  "chats",
  "people",
] as const;
export type KinLinkedGroupName = (typeof KIN_LINKED_GROUPS)[number];

export const KIN_LINKED = {
  group: {
    tasks: "Tasks",
    projects: "Projects",
    client: "Client",
    money: "Money",
    docs: "Docs",
    chats: "Chats",
    people: "People",
  } satisfies Record<KinLinkedGroupName, string>,
  /** A message link the host gave no label. */
  message: "Where this came from",
  /** A message link into a chat this reader isn't in: told in words, not linked. */
  closedChat: (agent: string | null) =>
    agent === null ? "Where this came from: a chat" : `Where this came from: a chat with ${agent}`,
  more: (count: number) => `${count} more`,
  unlisted: (count: number) => `${count} more not shown`,
} as const;

export type KinLinkedKind = RecordKind | "contact" | "message";
/** One linked thing; `title` is null for a message the host gave no label, for the screen to word. */
export interface KinLinkedItem {
  readonly kind: KinLinkedKind;
  readonly key: string;
  /** What the row calls it: an entry's issued number, else its key. */
  readonly name: string;
  readonly title: string | null;
  /** Null for a chat this reader may not open: the row is told, not tapped. */
  readonly open: KinNotificationDestination | null;
}
export interface KinLinkedGroup {
  readonly group: KinLinkedGroupName;
  readonly items: ReadonlyArray<KinLinkedItem>;
  /** Past `items`, in this group. */
  readonly more: number;
}
export interface KinLinked {
  readonly groups: ReadonlyArray<KinLinkedGroup>;
  /** Entries linking here past the host's cap, in no group the host named. */
  readonly unlisted: number;
}

type KeyKind = Exclude<KinLinkedKind, "message">;
const KIND_BY_PREFIX: Readonly<Partial<Record<string, KeyKind>>> = {
  W: "task",
  M: "task",
  P: "project",
  C: "client",
  CT: "contact",
  D: "doc",
};
const GROUP_OF: Readonly<Record<KinLinkedKind, KinLinkedGroupName>> = {
  task: "tasks",
  project: "projects",
  client: "client",
  entry: "money",
  doc: "docs",
  message: "chats",
  contact: "people",
};

/** What a key is, by its prefix; any other list's (INV, QT, a defined list's own) is an entry. */
const kinLinkedKindOf = (key: string): KeyKind =>
  KIND_BY_PREFIX[key.slice(0, key.indexOf("-"))] ?? "entry";

const recordItem = (ref: Pick<KinRecordRef, "key" | "title">, number?: string): KinLinkedItem => {
  const kind = kinLinkedKindOf(ref.key);
  return {
    kind,
    key: ref.key,
    name: kinRecordName(ref.key, number),
    title: ref.title,
    // A contact has no screen of its own; chat's key links open it as an entry too.
    open: { _tag: "record", chatId: null, key: ref.key, kind: kind === "contact" ? "entry" : kind },
  };
};

const messageItem = (link: KinRecordLink, chatId: KinChatId): KinLinkedItem => ({
  kind: "message",
  key: link.target,
  name: link.target,
  title: link.label,
  open: { _tag: "chat", chatId, messageId: KinMessageId.make(link.target) },
});

/**
 * A record's or doc's links both ways, grouped Tasks · Projects · Client · Money · Docs · Chats ·
 * People, each at most `limit` with how many more. Workers, pull requests, web addresses and memory
 * are no linked record, so they are left to the screen.
 */
export function kinLinked(
  detail: Pick<KinRecordDetail, "key" | "links"> &
    Partial<
      Pick<KinRecordDetail, "project" | "party" | "milestone" | "linkedFrom" | "linkedFromMore">
    >,
  limit = 5,
  options: {
    /** Groups opened past `limit` in place: the detail already holds the rest. */
    readonly expanded?: ReadonlySet<KinLinkedGroupName>;
    /** The screen shows its client, project and milestone already; a real link to one still lists. */
    readonly parentsShown?: boolean;
  } = {},
): KinLinked {
  const { expanded = new Set(), parentsShown = false } = options;
  const seen = new Set([detail.key]);
  const items: Array<KinLinkedItem> = [];
  const add = (item: KinLinkedItem) => {
    if (seen.has(item.key)) return;
    seen.add(item.key);
    items.push(item);
  };
  if (!parentsShown)
    for (const ref of [detail.party, detail.project, detail.milestone])
      if (ref !== undefined) add(recordItem(ref));
  for (const link of [...detail.links, ...(detail.linkedFrom ?? [])]) {
    if (link.kind === "record" && link.record !== undefined)
      add(recordItem(link.record, link.number));
    if (link.kind === "message" && link.chatId !== null) add(messageItem(link, link.chatId));
    else if (link.kind === "message" && link.closedChat !== undefined)
      add({
        kind: "message",
        key: link.target,
        name: link.target,
        title: KIN_LINKED.closedChat(link.closedChat.agent),
        open: null,
      });
  }
  const groups = KIN_LINKED_GROUPS.flatMap((group): ReadonlyArray<KinLinkedGroup> => {
    const all = items.filter((item) => GROUP_OF[item.kind] === group);
    const shown = expanded.has(group) ? all : all.slice(0, limit);
    return all.length === 0 ? [] : [{ group, items: shown, more: all.length - shown.length }];
  });
  return { groups, unlisted: detail.linkedFromMore ?? 0 };
}

/** The own links `kinLinked` leaves to the screen: pull requests, workers, notes, web pages, unseen records. */
export const kinLinkedRest = (links: ReadonlyArray<KinWorkLinkView>) =>
  links.filter((link) => link.kind !== "message" && (link.kind !== "task" || link.open === null));
