import type { ChatAttachment, ChatImageAttachment } from "@t3tools/contracts";
import {
  IMAGE_ATTACHMENT_MAX_EDGE,
  IMAGE_DIMENSIONS_HEADER_BYTES,
  BILL_PHOTO_MAX_PIXELS,
  readImageDimensions,
  readJpegOrientation,
} from "@t3tools/shared/imageDimensions";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

import {
  createDeterministicAttachmentId,
  KIN_ATTACHMENT_ID_PREFIX,
  resolveAttachmentPath,
} from "../../attachmentStore.ts";
import { cutBillPage } from "./billCutter.ts";
import { BILL_MODEL_IMAGE_BYTES } from "./billCutterProtocol.ts";

const previews = Semaphore.makeUnsafe(1);

export const billPhotoPreviewId = (sourceId: string) => {
  const id = createDeterministicAttachmentId(
    KIN_ATTACHMENT_ID_PREFIX.slice(0, -1),
    `${sourceId}#bill-preview-v1`,
  );
  return id === null ? null : `${id}-jpg`;
};

/** Only the model uses this JPEG. The bill row and viewer keep the original attachment id. */
export const billPhotoForModel = Effect.fn("KinBills.photoForModel")(
  function* (attachmentsDir: string, attachment: ChatAttachment) {
    const fs = yield* FileSystem.FileSystem;
    const source = resolveAttachmentPath({ attachmentsDir, attachment });
    const id = billPhotoPreviewId(attachment.id);
    if (source === null || id === null) return undefined;
    const image: ChatImageAttachment = {
      type: "image",
      id,
      name: attachment.name,
      mimeType: "image/jpeg",
      sizeBytes: attachment.sizeBytes,
    };
    const path = resolveAttachmentPath({ attachmentsDir, attachment: image });
    if (path === null) return undefined;
    const readHeader = fs.open(source, { flag: "r" }).pipe(
      Effect.flatMap((file) => file.readAlloc(IMAGE_DIMENSIONS_HEADER_BYTES)),
      Effect.scoped,
    );
    const header = yield* readHeader;
    if (Option.isNone(header)) return undefined;
    const size = readImageDimensions(header.value);
    if (size === null || size.width * size.height > BILL_PHOTO_MAX_PIXELS) return undefined;
    // Only an unrotated JPEG is sure to look the same to the provider as to the cutter's decoder,
    // which also turns a WebP's EXIF upright; any other picture is shown as the cutter draws it.
    if (
      Math.max(size.width, size.height) <= IMAGE_ATTACHMENT_MAX_EDGE &&
      attachment.sizeBytes <= BILL_MODEL_IMAGE_BYTES &&
      header.value[0] === 0xff &&
      header.value[1] === 0xd8 &&
      readJpegOrientation(header.value) === 1
    )
      return attachment;

    return yield* previews.withPermit(
      Effect.gen(function* () {
        if (!(yield* fs.exists(source))) return undefined;
        const cached = yield* fs.stat(path).pipe(Effect.option);
        if (Option.isSome(cached)) return { ...image, sizeBytes: Number(cached.value.size) };
        const bytes = yield* fs.readFile(source);
        const { outcome } = yield* cutBillPage({ kind: "photo", bytes, boxes: [] });
        if (outcome._tag !== "cut" || outcome.preview === undefined) return undefined;
        const jpeg = outcome.preview;
        const partial = `${path}.part`;
        yield* fs.writeFile(partial, jpeg).pipe(
          Effect.andThen(
            Effect.uninterruptible(
              Effect.gen(function* () {
                yield* fs.rename(partial, path);
                // A chat clear may delete the original while its preview is being drawn.
                if (!(yield* fs.exists(source))) yield* fs.remove(path, { force: true });
              }),
            ),
          ),
          Effect.ensuring(fs.remove(partial, { force: true }).pipe(Effect.ignore)),
        );
        if (!(yield* fs.exists(path))) return undefined;
        return { ...image, sizeBytes: jpeg.byteLength };
      }),
    );
  },
  Effect.orElseSucceed(() => undefined),
);
