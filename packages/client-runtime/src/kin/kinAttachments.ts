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

/**
 * This device's copies of the images in messages it sent, by `clientMessageId`. The host serves
 * an upload only once the message that claims it is posted, so a sending message shows these,
 * and a posted one keeps them until the host's copy has loaded. `release` frees one copy.
 */
export function createKinLocalPreviews(release: (url: string) => void) {
  const byMessage = new Map<string, ReadonlyArray<string>>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const forget = (clientMessageId: string) => {
    const urls = byMessage.get(clientMessageId);
    if (urls === undefined) return;
    byMessage.delete(clientMessageId);
    for (const url of urls) release(url);
    notify();
  };
  return {
    remember: (clientMessageId: string, urls: ReadonlyArray<string>) => {
      if (urls.length === 0) return;
      const previous = byMessage.get(clientMessageId);
      byMessage.set(clientMessageId, urls);
      for (const url of previous ?? []) if (!urls.includes(url)) release(url);
      notify();
    },
    get: (clientMessageId: string | null | undefined) =>
      clientMessageId == null ? undefined : byMessage.get(clientMessageId),
    forget,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/** Each image's local copy by attachment id: the message's n-th image takes the n-th copy. */
export function kinLocalImageUrls(
  attachments: ReadonlyArray<KinAttachment>,
  previews: ReadonlyArray<string> | undefined,
): ReadonlyMap<string, string> {
  const urls = new Map<string, string>();
  if (previews === undefined) return urls;
  let index = 0;
  for (const attachment of attachments) {
    if (attachment.type !== "image") continue;
    const url = previews[index++];
    if (url !== undefined) urls.set(attachment.id, url);
  }
  return urls;
}
