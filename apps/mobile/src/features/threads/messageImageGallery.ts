import type { ChatAttachment, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { imageMimeType } from "@t3tools/shared/image";
import type { FilePreviewItem } from "../../components/ui/FilePreviewModal.types";
import { remoteAttachmentImageSource } from "../../lib/filePreviewGallery";
import { markdownImageSources } from "../../lib/markdownImageSources";
import { resolveMarkdownMediaPreview } from "../../lib/markdownMedia";

/** A message's attached pictures, in order, as one gallery. */
export function attachmentImageGallery(
  attachments: readonly Pick<ChatAttachment, "type" | "id" | "name" | "mimeType">[],
  environmentId: EnvironmentId,
): FilePreviewItem[] {
  const images: FilePreviewItem[] = [];
  for (const attachment of attachments) {
    if (attachment.type !== "image" && imageMimeType(attachment) === null) continue;
    images.push(remoteAttachmentImageSource(environmentId, attachment.id, attachment));
  }
  return images;
}

export function messageImageGallery(
  message: { readonly text: string; readonly attachments?: readonly ChatAttachment[] },
  context: {
    environmentId: EnvironmentId;
    threadId: ThreadId;
    workspaceRoot: string | null | undefined;
  },
): FilePreviewItem[] {
  const images = attachmentImageGallery(message.attachments ?? [], context.environmentId);
  for (const href of markdownImageSources(message.text)) {
    const preview = resolveMarkdownMediaPreview(href, { ...context, imageEmbed: true });
    if (preview?.kind === "image") images.push(preview.source);
  }
  return images;
}
