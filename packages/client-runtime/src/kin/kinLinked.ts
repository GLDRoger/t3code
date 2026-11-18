import {
  KinMessageId,
  type KinChatId,
  type KinRecordDetail,
  type KinRecordLink,
  type KinRecordRef,
} from "@t3tools/contracts";

import type { KinNotificationDestination } from "./kinNotificationDestination.ts";

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

export type KinLinkedKind = RecordKind | "contact" | "message";
/** One linked thing; `title` is null for a message the host gave no label, for the screen to word. */
export interface KinLinkedItem {
  readonly kind: KinLinkedKind;
  readonly key: string;
  readonly title: string | null;
  readonly open: KinNotificationDestination;
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

const recordItem = (ref: Pick<KinRecordRef, "key" | "title">): KinLinkedItem => {
  const kind = kinLinkedKindOf(ref.key);
  return {
    kind,
    key: ref.key,
    title: ref.title,
    // A contact has no screen of its own; chat's key links open it as an entry too.
    open: { _tag: "record", chatId: null, key: ref.key, kind: kind === "contact" ? "entry" : kind },
  };
};

const messageItem = (link: KinRecordLink, chatId: KinChatId): KinLinkedItem => ({
  kind: "message",
  key: link.target,
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
): KinLinked {
  const seen = new Set([detail.key]);
  const items: Array<KinLinkedItem> = [];
  const add = (item: KinLinkedItem) => {
    if (seen.has(item.key)) return;
    seen.add(item.key);
    items.push(item);
  };
  for (const ref of [detail.party, detail.project, detail.milestone])
    if (ref !== undefined) add(recordItem(ref));
  for (const link of [...detail.links, ...(detail.linkedFrom ?? [])]) {
    if (link.kind === "record" && link.record !== undefined) add(recordItem(link.record));
    if (link.kind === "message" && link.chatId !== null) add(messageItem(link, link.chatId));
  }
  const groups = KIN_LINKED_GROUPS.flatMap((group): ReadonlyArray<KinLinkedGroup> => {
    const all = items.filter((item) => GROUP_OF[item.kind] === group);
    return all.length === 0
      ? []
      : [{ group, items: all.slice(0, limit), more: Math.max(0, all.length - limit) }];
  });
  return { groups, unlisted: detail.linkedFromMore ?? 0 };
}
