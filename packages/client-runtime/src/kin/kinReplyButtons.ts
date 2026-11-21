import type { KinMessage, KinMessageLinkTarget } from "@t3tools/contracts";

export const KIN_REPLY_BUTTONS_MAX = 3;

export const KIN_REPLY_BUTTONS = {
  label: "Open what this reply names",
  open: (text: string) => `Open ${text}`,
} as const;

export interface KinReplyButton {
  /** Stable per target, for React keys. */
  readonly id: string;
  readonly label: string;
  /** The entry's one line, such as "Logo files · Open"; null for a chat or a person. */
  readonly note: string | null;
  readonly to: KinMessageLinkTarget;
}

// Records first, then the chats and people it named. Settings stays a link in the text.
const RANK: Readonly<Record<KinMessageLinkTarget["_tag"], number | null>> = {
  record: 0,
  chat: 1,
  person: 2,
  settings: null,
};

const idOf = (to: KinMessageLinkTarget) => {
  switch (to._tag) {
    case "record":
      return `record:${to.key}`;
    case "chat":
      return `chat:${to.chatId}`;
    case "person":
      return `person:${to.personId}`;
    case "settings":
      return "settings";
  }
};

/**
 * The buttons under an agent's reply: up to three of the links the host worked out for this
 * reader, records before chats before people, each target once, in the order the reply names them.
 * None under a person's message, a system line, a brief, or a link back to the chat it is in.
 */
export function kinReplyButtons(
  message: Pick<KinMessage, "author" | "kind" | "status" | "links" | "chatId" | "form">,
): ReadonlyArray<KinReplyButton> {
  if (
    message.author._tag !== "agent" ||
    message.kind !== "text" ||
    message.status !== "posted" ||
    message.form === "brief"
  )
    return [];
  const seen = new Set<string>();
  const buttons: Array<KinReplyButton & { readonly rank: number }> = [];
  for (const link of message.links ?? []) {
    const rank = RANK[link.to._tag];
    const id = idOf(link.to);
    if (rank === null || seen.has(id)) continue;
    if (link.to._tag === "chat" && link.to.chatId === message.chatId) continue;
    seen.add(id);
    buttons.push({
      id,
      label: KIN_REPLY_BUTTONS.open(link.text),
      note: link.note,
      to: link.to,
      rank,
    });
  }
  return buttons
    .sort((a, b) => a.rank - b.rank)
    .slice(0, KIN_REPLY_BUTTONS_MAX)
    .map(({ rank: _rank, ...button }) => button);
}
