import { kinIsPeopleChat, type KinChatSummary, type KinPersonId } from "@t3tools/contracts";

import { kinFailureText } from "./kinAnswers.ts";

/**
 * A chat between two people. Anyone starts one with anyone on the team, and starting it again
 * opens the same one. The host lets only those two read it: not the owner, not a co-owner.
 */
export const KIN_PEOPLE_CHAT = {
  message: "Message",
  newChat: "Message a teammate",
  pickTitle: "Message a teammate",
  pickDetail: "A chat between the two of you. Only you and they can read it.",
  noOne: "Nobody else is on the team yet.",
  /** Said where the chat is made and at its top: the host's rule, not a promise of ours. */
  privacy: (name: string) => `Only you and ${name} can read this.`,
};

/** Why a teammate's chat didn't open, in Kin's words for each kind of failure. */
export const kinPeopleChatProblem = (error: unknown) =>
  kinFailureText(error, "Couldn't open that chat.", {
    refused: "You can't message this person.",
    gone: "That person is no longer on the team.",
  });

/** The other person in a chat between two people; null for any other chat. */
export function kinPeopleChatWith(
  chat: Pick<KinChatSummary, "kind" | "teamId" | "members">,
  me: ReadonlySet<string>,
): KinPersonId | null {
  if (!kinIsPeopleChat(chat)) return null;
  for (const member of chat.members)
    if (member.principal._tag === "person" && !me.has(member.principal.personId))
      return member.principal.personId;
  return null;
}

/** Who the viewer can start a chat with: everyone else on the team, by name. */
export function kinMessageablePeople<
  P extends { readonly personId: KinPersonId; readonly displayName: string },
>(people: ReadonlyArray<P>, me: KinPersonId | null): ReadonlyArray<P> {
  return people
    .filter((person) => person.personId !== me)
    .sort((one, other) => one.displayName.localeCompare(other.displayName));
}
