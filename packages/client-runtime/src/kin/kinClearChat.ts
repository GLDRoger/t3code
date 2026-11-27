import type { KinChat, KinChatMember } from "@t3tools/contracts";

export const KIN_CLEAR_CHAT_ACTION = "Clear chat";
export const KIN_CLEAR_CHAT_TITLE = "Clear this chat?";
export const KIN_CLEAR_CHAT_FAILED = "Couldn't clear this chat.";

export const KIN_CLEAR_CHAT_DONE = "Chat cleared";

/** The files a clear leaves because a doc uses them, in words; null when it leaves none. */
export function kinClearChatKept(keptFiles: number | undefined): string | null {
  if (keptFiles === undefined || keptFiles === 0) return null;
  return keptFiles === 1
    ? "1 file stays because a document uses it."
    : `${keptFiles} files stay because documents use them.`;
}

export type KinClearChatPins = "none" | "some" | "unknown";

/**
 * Confirm body: memory line for leads that keep any (`"group"`, lead name, or `null`), `keptFiles`
 * from preview, and `pins` (`"some"`, `"none"`, or `"unknown"` when no count is already on screen).
 */
export function kinClearChatBody(
  remembers: string | null,
  keptFiles?: number,
  pins: KinClearChatPins = "none",
): string {
  const gone =
    pins === "some"
      ? "This deletes every message here for good and unpins what is pinned here."
      : pins === "unknown"
        ? "This deletes every message here for good, and unpins anything pinned here."
        : "This deletes every message here for good.";
  const memory =
    remembers === null
      ? ""
      : ` What ${remembers === "group" ? "the agents remember" : `${remembers} remembers`} is kept.`;
  const kept = kinClearChatKept(keptFiles);
  return `${gone}${memory}${kept === null ? "" : ` ${kept}`}`;
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
