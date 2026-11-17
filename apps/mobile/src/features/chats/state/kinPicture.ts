import type { EnvironmentId, KinAttachment } from "@t3tools/contracts";

import * as Effect from "effect/Effect";
import { prepareTurnAttachments } from "../../../lib/attachmentUpload";
import { uploadComposerAttachmentShared } from "../../../state/composer-attachment-uploads";
import { beginForegroundHandoff } from "../../../lib/foreground-handoff";
import { uuidv4 } from "../../../lib/uuid";

const PICTURE_EDGE = 512;

/**
 * Picks a square photo, scales it to 512 px and uploads it through the composer's upload path.
 * Null when the person cancelled; throws when the upload failed. The host claims it on save.
 */
export async function pickKinPicture(environmentId: EnvironmentId): Promise<KinAttachment | null> {
  const picker = await import("expo-image-picker");
  const endHandoff = beginForegroundHandoff();
  let picked: Awaited<ReturnType<typeof picker.launchImageLibraryAsync>>;
  try {
    picked = await picker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 1,
      base64: false,
    });
  } finally {
    endHandoff();
  }
  const asset = picked.canceled ? undefined : picked.assets[0];
  if (asset === undefined) return null;
  const { ImageManipulator, SaveFormat } = await import("expo-image-manipulator");
  const source = await ImageManipulator.manipulate(asset.uri).renderAsync();
  const edge = Math.max(source.width, source.height);
  const image =
    edge > PICTURE_EDGE
      ? await ImageManipulator.manipulate(source)
          .resize(
            source.width >= source.height ? { width: PICTURE_EDGE } : { height: PICTURE_EDGE },
          )
          .renderAsync()
      : source;
  const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.86 });
  if (image !== source) image.release();
  source.release();
  const { File } = await import("expo-file-system");
  const sizeBytes = new File(saved.uri).size ?? 0;
  const prepared = await Effect.runPromise(
    prepareTurnAttachments({
      environmentId,
      supportsImageUploads: true,
      uploadAttachment: (attachment) => uploadComposerAttachmentShared(environmentId, attachment),
      attachments: [
        {
          id: uuidv4(),
          type: "image",
          name: "picture.jpg",
          mimeType: "image/jpeg",
          sizeBytes,
          previewUri: saved.uri,
          fileUri: saved.uri,
        },
      ],
    }),
  );
  const uploaded = prepared.status === "ready" ? prepared.attachments[0] : undefined;
  if (uploaded === undefined || !("id" in uploaded) || uploaded.type !== "image")
    throw new Error("The picture didn't upload.");
  return {
    type: "image",
    id: String(uploaded.id),
    name: uploaded.name,
    mimeType: uploaded.mimeType ?? "image/jpeg",
    sizeBytes: uploaded.sizeBytes,
  };
}
