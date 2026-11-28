import {
  KIN_PHOTO_FIT,
  kinPhotosFit,
  type KinPhotoFitStep,
} from "@t3tools/client-runtime/kin/kinPhotoFit";
import { isProviderSendTurnSupportedImageMimeType } from "@t3tools/contracts";
import {
  IMAGE_DIMENSIONS_HEADER_BYTES,
  readImageDimensions,
} from "@t3tools/shared/imageDimensions";

import {
  ownedComposerImageAttachment,
  type DraftComposerAttachment,
} from "../../lib/composerImages";

const isImage = (attachment: DraftComposerAttachment) =>
  attachment.type === "image" || isProviderSendTurnSupportedImageMimeType(attachment.mimeType);

async function longEdgeOf(uri: string, bytes: number) {
  try {
    const { File, FileMode } = await import("expo-file-system");
    const handle = new File(uri).open(FileMode.ReadOnly);
    try {
      const size = readImageDimensions(
        await handle.readBytes(Math.min(IMAGE_DIMENSIONS_HEADER_BYTES, bytes)),
      );
      return size === null ? null : Math.max(size.width, size.height);
    } finally {
      handle.close();
    }
  } catch {
    return null;
  }
}

async function encode(attachment: DraftComposerAttachment, step: KinPhotoFitStep) {
  if (attachment.fileUri === undefined) return null;
  const { ImageManipulator, SaveFormat } = await import("expo-image-manipulator");
  const image = await ImageManipulator.manipulate(attachment.fileUri).renderAsync();
  const longest = Math.max(image.width, image.height);
  const scale = step.maxEdge === null || longest <= step.maxEdge ? 1 : step.maxEdge / longest;
  const resized =
    scale === 1
      ? null
      : await ImageManipulator.manipulate(image)
          .resize({
            width: Math.max(1, Math.round(image.width * scale)),
            height: Math.max(1, Math.round(image.height * scale)),
          })
          .renderAsync();
  try {
    const saved = await (resized ?? image).saveAsync({
      format: SaveFormat.JPEG,
      compress: step.quality,
    });
    const photo: DraftComposerAttachment = await ownedComposerImageAttachment({
      fileUri: saved.uri,
      name: `${attachment.name.replace(/\.[^.]+$/, "")}.jpg`,
      mimeType: "image/jpeg",
    });
    return { photo, bytes: photo.sizeBytes };
  } finally {
    resized?.release();
    image.release();
  }
}

/**
 * A message's attachments as they go, in order: when its photos together pass the message's cap,
 * each is re-encoded (`kinPhotosFit`); PDFs and other files go as they are.
 */
export async function fitKinChatPhotos(
  attachments: ReadonlyArray<DraftComposerAttachment>,
): Promise<
  | { readonly _tag: "fits"; readonly attachments: ReadonlyArray<DraftComposerAttachment> }
  | { readonly _tag: "tooLarge"; readonly text: string }
> {
  const images = attachments.filter(isImage);
  const bytes = images.reduce((sum, attachment) => sum + attachment.sizeBytes, 0);
  if (bytes <= KIN_PHOTO_FIT.cap) return { _tag: "fits", attachments };
  const items = await Promise.all(
    images.map(async (attachment) => ({
      source: attachment,
      bytes: attachment.sizeBytes,
      longEdge:
        attachment.fileUri === undefined
          ? null
          : await longEdgeOf(attachment.fileUri, attachment.sizeBytes),
      reencode:
        attachment.fileUri !== undefined && attachment.mimeType.toLowerCase() !== "image/gif",
    })),
  );
  const fitted = await kinPhotosFit({ items, cap: KIN_PHOTO_FIT.cap, encode });
  if (fitted._tag === "tooLarge") return fitted;
  const byId = new Map(images.map((attachment, index) => [attachment.id, fitted.items[index]!]));
  return {
    _tag: "fits",
    attachments: attachments.map((attachment) => byId.get(attachment.id) ?? attachment),
  };
}
