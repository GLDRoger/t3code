import { kinLocalImageUrls } from "@t3tools/client-runtime/kin/kinAttachments";
import type { EnvironmentId, KinAttachment } from "@t3tools/contracts";
import { useEffect, useSyncExternalStore } from "react";

import { useAssetUrls } from "../assets/assetUrls";
import { openExpandedImagePreview } from "../components/chat/ExpandedImageDialog";
import { GuestMessageAttachments } from "../components/chat/GuestMessageAttachments";
import { kinLocalPreviews } from "./kinOutbox";

const NO_RESOURCES: ReadonlyArray<never> = [];
const loaded = (src: string) =>
  new Promise<void>((resolve) => {
    const image = new Image();
    image.onload = () => resolve();
    image.onerror = () => resolve();
    image.src = src;
  });

/**
 * A Kin message's files, drawn as a thread message's are. The bytes load from signed asset URLs
 * the host mints per viewer; the message itself carries only names, types and sizes.
 */
export function KinMessageAttachments(props: {
  readonly environmentId: EnvironmentId;
  readonly attachments: ReadonlyArray<KinAttachment>;
  /** Where image previews open; the chat mounts the dialog host under the same key. */
  readonly previewKey: string;
  /** The viewer's own message: its images show this tab's copies until the host's have loaded. */
  readonly clientMessageId?: string | undefined;
  /** Not posted yet: the host serves no upload before its message claims it, so none is asked. */
  readonly unposted?: boolean;
}) {
  const { attachments, clientMessageId } = props;
  const local = kinLocalImageUrls(
    attachments,
    useSyncExternalStore(kinLocalPreviews.subscribe, () => kinLocalPreviews.get(clientMessageId)),
  );
  const urls = useAssetUrls(
    props.environmentId,
    props.unposted === true
      ? NO_RESOURCES
      : attachments.map((attachment) => ({
          _tag: "attachment" as const,
          attachmentId: attachment.id,
          fileName: attachment.name,
          mimeType: attachment.mimeType,
        })),
  );
  const hostUrlById = new Map(
    props.unposted === true
      ? []
      : attachments.map((attachment, index) => [attachment.id, urls[index] ?? undefined]),
  );
  const handoff = [...local.keys()].map((id) => hostUrlById.get(id));
  const ready =
    props.unposted !== true && handoff.length > 0 && handoff.every((src) => src !== undefined)
      ? handoff.join("\n")
      : "";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- preloads the host's images so the local copies swap out without an empty frame
  useEffect(() => {
    if (ready === "" || clientMessageId === undefined) return;
    let current = true;
    void Promise.all(ready.split("\n").map(loaded)).then(() => {
      if (current) kinLocalPreviews.forget(clientMessageId);
    });
    return () => {
      current = false;
    };
  }, [ready, clientMessageId]);
  const url = (id: string) => local.get(id) ?? hostUrlById.get(id);
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
