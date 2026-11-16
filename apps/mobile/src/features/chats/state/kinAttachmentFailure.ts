// `lib/attachmentUpload.ts` throws this when a draft's file is gone; retrying can't help, so say it.
const LOST_FILE = /^'.+' is no longer available\. Attach the image again\.$/;

/**
 * The alert for attachments that didn't upload. Causes are internal (an interrupted fiber, an
 * HTTP status, a dropped socket), so the reader gets plain words and a next step instead.
 */
export function kinAttachmentFailure(
  error: unknown,
  kinds: ReadonlyArray<string>,
): { readonly title: string; readonly message: string } {
  const what = kinds.every((kind) => kind === "image")
    ? kinds.length === 1
      ? "the photo"
      : "the photos"
    : kinds.length === 1
      ? "the file"
      : "the files";
  const lost = error instanceof Error && LOST_FILE.test(error.message) ? error.message : null;
  const still = kinds.length === 1 ? "It's" : "They're";
  return {
    title: `Couldn't send ${what}`,
    message: lost ?? `Check the connection and try again. ${still} still in the message box.`,
  };
}
