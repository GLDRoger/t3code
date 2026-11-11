import type { KinChat, KinChatMember } from "@t3tools/contracts";

export const KIN_CLEAR_CHAT_ACTION = "Clear chat";
export const KIN_CLEAR_CHAT_TITLE = "Clear this chat?";
export const KIN_CLEAR_CHAT_FAILED = "Couldn't clear this chat. Try again.";

/**
 * What the confirm says. The line about memory shows only to someone whose leads keep any: a
 * lead's name in their direct chat, `"group"` in a group, `null` for a teammate's own chat.
 */
export function kinClearChatBody(remembers: string | null): string {
  const gone = "This deletes every message here for good.";
  if (remembers === null) return gone;
  return `${gone} What ${remembers === "group" ? "the leads remember" : `${remembers} remembers`} is kept.`;
}

/**
 * Whether to offer clearing a direct chat: the viewer is the one person in it. The host decides
 * again on the call; a group's own details check its owner.
 */
export function kinOwnsDirectChat(
  kind: KinChat["kind"],
  members: ReadonlyArray<KinChatMember>,
  personId: string | null,
): boolean {
  if (kind !== "direct" || personId === null) return false;
  const people = members.filter(
    (member) => member.leftAt === null && member.principal._tag === "person",
  );
  return (
    people.length === 1 &&
    people[0]!.principal._tag === "person" &&
    people[0]!.principal.personId === personId
  );
}
