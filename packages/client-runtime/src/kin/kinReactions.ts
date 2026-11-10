import {
  KIN_REACTION_EMOJI,
  type KinChatMember,
  type KinMessage,
  type KinReaction,
  type KinReactionEmoji,
} from "@t3tools/contracts";

/** Spoken names, so VoiceOver reads "thumbs up" rather than the glyph's codepoint. */
export const KIN_REACTION_NAMES: Readonly<Record<KinReactionEmoji, string>> = {
  "👍": "thumbs up",
  "✅": "check mark",
  "👎": "thumbs down",
  "❌": "cross mark",
  "❤️": "heart",
  "👀": "eyes",
  "😂": "laughing",
  "🎉": "party",
  "😮": "surprised",
  "🔥": "fire",
  "🙏": "thank you",
  "😢": "sad",
  "💯": "hundred",
};

/** The long-press sheet's reactions, in its two rows; ✅ and ❌ stay reachable as chips. */
export const KIN_PICKER_REACTIONS = [
  "👍",
  "👎",
  "❤️",
  "😂",
  "🎉",
  "😮",
  "🔥",
  "👀",
  "🙏",
  "😢",
  "💯",
] as const satisfies ReadonlyArray<KinReactionEmoji>;

const reactionKey = (reaction: Pick<KinReaction, "messageId" | "memberId" | "emoji">) =>
  `${reaction.messageId}|${reaction.memberId}|${reaction.emoji}`;

/** Applies one stream `reaction` event: a withdrawn one (`removedAt` set) drops out. */
export function applyKinReaction(
  current: ReadonlyArray<KinReaction>,
  reaction: KinReaction,
): ReadonlyArray<KinReaction> {
  const key = reactionKey(reaction);
  const index = current.findIndex((held) => reactionKey(held) === key);
  if (reaction.removedAt !== null) {
    if (index === -1) return current;
    // A late removal of an older copy must not drop a newer re-add.
    if (current[index]!.createdAt > reaction.createdAt) return current;
    return current.filter((_, at) => at !== index);
  }
  if (index === -1) return [...current, reaction];
  if (current[index]!.createdAt >= reaction.createdAt) return current;
  const next = current.slice();
  next[index] = reaction;
  return next;
}

/** Adds a history page's reactions; the held copy of the same reaction wins. */
export function mergeKinReactions(
  current: ReadonlyArray<KinReaction>,
  incoming: ReadonlyArray<KinReaction>,
): ReadonlyArray<KinReaction> {
  if (incoming.length === 0) return current;
  const held = new Set(current.map(reactionKey));
  const added = incoming.filter((reaction) => !held.has(reactionKey(reaction)));
  return added.length === 0 ? current : [...current, ...added];
}

export interface KinReactionChip {
  readonly emoji: KinReactionEmoji;
  readonly count: number;
  /** The viewer reacted with this emoji: tapping the chip withdraws it. */
  readonly mine: boolean;
  /** Read as one VoiceOver element, for example "thumbs up, 2, including you". */
  readonly label: string;
}

/** One chip per emoji on the message, in the picker's order. */
export function kinReactionChips(
  reactions: ReadonlyArray<KinReaction>,
  messageId: string,
  viewerMemberId: string | null,
  /** Who reacted, for the label; the lead's own reaction reads "Lead". */
  nameOf: (memberId: string) => string | null = () => null,
): ReadonlyArray<KinReactionChip> {
  const onMessage = reactions.filter(
    (reaction) => reaction.messageId === messageId && reaction.removedAt === null,
  );
  return KIN_REACTION_EMOJI.flatMap((emoji) => {
    const by = onMessage.filter((reaction) => reaction.emoji === emoji);
    if (by.length === 0) return [];
    const mine = viewerMemberId !== null && by.some((r) => r.memberId === viewerMemberId);
    const others = by
      .filter((reaction) => reaction.memberId !== viewerMemberId)
      .map((reaction) => nameOf(reaction.memberId))
      .filter((name): name is string => name !== null);
    const who = [...(mine ? ["you"] : []), ...others];
    return [
      {
        emoji,
        count: by.length,
        mine,
        label: `${KIN_REACTION_NAMES[emoji]}, ${by.length}${who.length > 0 ? `, ${who.join(" and ")}` : ""}`,
      },
    ];
  });
}

/**
 * What a tap or picker choice sends. The host keeps one reaction per person per message, so a
 * new emoji replaces the viewer's and their current one again removes it.
 */
export const kinReactionToggle = (
  chips: ReadonlyArray<KinReactionChip>,
  messageId: KinMessage["messageId"],
  emoji: KinReactionEmoji,
) => ({ messageId, emoji, on: !chips.some((chip) => chip.emoji === emoji && chip.mine) });

/** The viewer's member id in the chat, for spotting their own reactions. */
export const kinViewerMemberId = (
  members: ReadonlyArray<KinChatMember>,
  personId: string | null,
): string | null =>
  personId === null
    ? null
    : (members.find(
        (member) =>
          member.leftAt === null &&
          member.principal._tag === "person" &&
          member.principal.personId === personId,
      )?.memberId ?? null);
