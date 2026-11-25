import type { KinChatMember, KinMessage } from "@t3tools/contracts";
import { isDismissedArrival } from "./arrivalNotes.ts";

/** A message its agent took back: only the line that says so, never its words (`withdrawnSaid`). */
const withdrawnLine = (message: KinMessage): KinMessage => {
  const {
    attachments: _attachments,
    refs: _refs,
    links: _links,
    embeds: _embeds,
    turnChanges: _turnChanges,
    ...rest
  } = message;
  return { ...rest, body: "" };
};

export function messageForViewer(
  message: KinMessage,
  viewer: KinChatMember["principal"] | undefined,
): KinMessage {
  if (viewer?._tag === "person" && isDismissedArrival(message)) {
    const { when: _when, ...rest } = message;
    return { ...rest, body: "" };
  }
  if (message.withdrawn !== undefined) {
    const { clientMessageId: _, ...line } = withdrawnLine(message);
    return line;
  }
  if (
    (viewer?._tag === "person" &&
      message.author._tag === "human" &&
      viewer.personId === message.author.personId) ||
    (viewer?._tag === "agent" &&
      message.author._tag === "agent" &&
      viewer.agentId === message.author.agentId)
  )
    return message;
  const { clientMessageId: _, ...visible } = message;
  return visible;
}
