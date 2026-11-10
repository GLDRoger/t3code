import type { KinAttachment } from "@t3tools/contracts";

/** What stands in for a message's files where only a line fits: the list, a label, a reader. */
export function kinAttachmentSummary(attachments: ReadonlyArray<KinAttachment>): string {
  const [first] = attachments;
  if (first === undefined) return "";
  const photos = attachments.every((attachment) => attachment.type === "image");
  if (attachments.length > 1) return `${attachments.length} ${photos ? "photos" : "attachments"}`;
  return photos ? "Photo" : first.name;
}

/** A message's words, or a word for its files when it has none. */
export function kinMessageSummary(message: {
  readonly body: string;
  readonly attachments?: ReadonlyArray<KinAttachment> | undefined;
}): string {
  return message.body.trim() === ""
    ? kinAttachmentSummary(message.attachments ?? [])
    : message.body;
}
