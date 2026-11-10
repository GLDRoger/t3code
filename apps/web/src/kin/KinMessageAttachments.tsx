import type { EnvironmentId, KinAttachment } from "@t3tools/contracts";

import { useAssetUrls } from "../assets/assetUrls";
import { openExpandedImagePreview } from "../components/chat/ExpandedImageDialog";
import { GuestMessageAttachments } from "../components/chat/GuestMessageAttachments";

/**
 * A Kin message's files, drawn as a thread message's are. The bytes load from signed asset URLs
 * the host mints per viewer; the message itself carries only names, types and sizes.
 */
export function KinMessageAttachments(props: {
  readonly environmentId: EnvironmentId;
  readonly attachments: ReadonlyArray<KinAttachment>;
  /** Where image previews open; the chat mounts the dialog host under the same key. */
  readonly previewKey: string;
}) {
  const { attachments } = props;
  const urls = useAssetUrls(
    props.environmentId,
    attachments.map((attachment) => ({
      _tag: "attachment" as const,
      attachmentId: attachment.id,
      fileName: attachment.name,
      mimeType: attachment.mimeType,
    })),
  );
  const urlById = new Map(attachments.map((attachment, index) => [attachment.id, urls[index]]));
  const url = (id: string) => urlById.get(id) ?? undefined;
  const filesReady = attachments.every(
    (attachment) => attachment.type !== "file" || url(attachment.id) !== undefined,
  );
  const openImage = (id: string) => {
    const images = attachments.flatMap((attachment) => {
      const src = attachment.type === "image" ? url(attachment.id) : undefined;
      return src === undefined
        ? []
        : [{ id: attachment.id, src, name: attachment.name, mimeType: attachment.mimeType }];
    });
    const index = images.findIndex((image) => image.id === id);
    if (index < 0) return;
    openExpandedImagePreview(props.previewKey, {
      images: images.map(({ id: _id, ...image }) => image),
      index,
    });
  };
  return (
    <GuestMessageAttachments
      attachments={attachments}
      imageUrl={(attachment) => url(attachment.id)}
      onOpenImage={(attachment) => openImage(attachment.id)}
      {...(filesReady ? { fileHref: (file) => url(file.id) ?? "" } : {})}
    />
  );
}
