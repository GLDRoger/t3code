import type { KinChatMember, KinMessage } from "@t3tools/contracts";

export function messageForViewer(
  message: KinMessage,
  viewer: KinChatMember["principal"] | undefined,
): KinMessage {
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
