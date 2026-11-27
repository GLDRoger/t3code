import { fitBillPhotoSize } from "@t3tools/client-runtime/kin/billPhotoSize";
import { kinBillIsPdf } from "@t3tools/client-runtime/kin/kinBills";
import { fileAttachmentTooLargeMessage } from "@t3tools/client-runtime/state/attachments";
import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@t3tools/contracts";
import { imageMimeType, isHeicImageFile } from "@t3tools/shared/image";
import {
  IMAGE_DIMENSIONS_HEADER_BYTES,
  readImageDimensions,
} from "@t3tools/shared/imageDimensions";

import { m } from "../../i18n/messages";
import {
  ownedComposerImageAttachment,
  persistComposerAttachmentFile,
  type DraftComposerImageAttachment,
} from "../../lib/composerImages";

/** Re-encode only a bill that needs fitting or conversion, without going through the chat cap. */
async function renderBillPhoto(uri: string, sourceBytes: number): Promise<string | null> {
  const { ImageManipulator, SaveFormat } = await import("expo-image-manipulator");
  const { File } = await import("expo-file-system");
  const original = await ImageManipulator.manipulate(uri).renderAsync();
  try {
    const target = fitBillPhotoSize(original, sourceBytes);
    for (const scale of [1, 0.75, 0.55]) {
      const resized =
        target === null && scale === 1
          ? null
          : await ImageManipulator.manipulate(original)
              .resize({
                width: Math.max(1, Math.floor((target ?? original).width * scale)),
                height: Math.max(1, Math.floor((target ?? original).height * scale)),
              })
              .renderAsync();
      try {
        const saved = await (resized ?? original).saveAsync({
          format: SaveFormat.JPEG,
          compress: 0.85,
        });
        const file = new File(saved.uri);
        const bytes = file.size;
        if (bytes !== null && bytes > 0 && bytes <= PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)
          return saved.uri;
        if (file.exists) file.delete();
      } finally {
        resized?.release();
      }
    }
    return null;
  } finally {
    original.release();
  }
}

export async function createBillPhotoAttachment(input: {
  readonly uri: string;
  readonly name: string;
  readonly mimeType?: string | null;
}): Promise<DraftComposerImageAttachment> {
  const { File, FileMode } = await import("expo-file-system");
  const source = new File(input.uri);
  const type = imageMimeType({
    name: input.name,
    mimeType: input.mimeType || source.type || "",
  });
  const sourceBytes = source.size ?? 0;
  const maximum = PROVIDER_SEND_TURN_MAX_IMAGE_BYTES;
  if (type !== null && sourceBytes > 0 && sourceBytes <= maximum) {
    const handle = source.open(FileMode.ReadOnly);
    let header: Uint8Array;
    try {
      header = await handle.readBytes(Math.min(IMAGE_DIMENSIONS_HEADER_BYTES, sourceBytes));
    } finally {
      handle.close();
    }
    const size = readImageDimensions(header);
    if (size !== null && fitBillPhotoSize(size, sourceBytes) === null) {
      const fileUri = await persistComposerAttachmentFile(input.uri, input.name, maximum);
      return ownedComposerImageAttachment({ fileUri, name: input.name, mimeType: type });
    }
  }
  const rendered = await renderBillPhoto(input.uri, sourceBytes);
  if (rendered === null) throw new Error(fileAttachmentTooLargeMessage(input.name, maximum, m));
  try {
    const name = /\.jpe?g$/i.test(input.name)
      ? input.name
      : `${input.name.replace(/\.[^.]+$/, "")}.jpg`;
    const fileUri = await persistComposerAttachmentFile(rendered, name, maximum);
    return await ownedComposerImageAttachment({ fileUri, name, mimeType: "image/jpeg" });
  } finally {
    try {
      const temp = new File(rendered);
      if (temp.exists) temp.delete();
    } catch (error) {
      console.warn("[composer-images] could not remove temporary bill photo", error);
    }
  }
}

/** The Files picker must leave PDFs and unrelated documents on their existing path. */
export async function preparePickedBillPhoto(
  input: Parameters<typeof createBillPhotoAttachment>[0],
) {
  const mimeType = input.mimeType ?? "";
  if (kinBillIsPdf({ name: input.name, mimeType })) return null;
  return imageMimeType({ name: input.name, mimeType }) !== null ||
    isHeicImageFile({ name: input.name, type: mimeType })
    ? createBillPhotoAttachment(input)
    : null;
}
