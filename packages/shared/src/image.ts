import { isWorkspaceImagePreviewPath } from "./mediaPreview.ts";

// Match PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES so unsupported images remain sendable as files.
const IMAGE_MIME_TYPE_BY_EXTENSION = new Map([
  ["gif", "image/gif"],
  ["jpeg", "image/jpeg"],
  ["jpg", "image/jpeg"],
  ["png", "image/png"],
  ["webp", "image/webp"],
]);

const SUPPORTED_IMAGE_MIME_TYPES = new Set(IMAGE_MIME_TYPE_BY_EXTENSION.values());

export const GENERIC_MIME_TYPES = new Set([
  "application/octet-stream",
  "binary/octet-stream",
  "application/unknown",
  // macOS and Windows label TypeScript `.ts` files as MPEG transport streams, which browsers can't play.
  "video/mp2t",
  "video/vnd.dlna.mpeg-tts",
]);

export function isSvgAttachment(attachment: {
  readonly name: string;
  readonly mimeType: string;
}): boolean {
  const mimeType = attachment.mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (
    mimeType === "image/svg+xml" ||
    ((mimeType === "" || GENERIC_MIME_TYPES.has(mimeType)) && /\.svg$/i.test(attachment.name))
  );
}

export function imageMimeType(attachment: {
  readonly name: string;
  readonly mimeType: string;
}): string | null {
  const mimeType = attachment.mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) return mimeType;
  if (mimeType.startsWith("image/")) return null;
  // Infer from filenames only for missing or generic MIME types; extensions must not override a definite type.
  if (mimeType !== "" && !GENERIC_MIME_TYPES.has(mimeType)) return null;
  const dotIndex = attachment.name.lastIndexOf(".");
  return dotIndex < 0
    ? null
    : (IMAGE_MIME_TYPE_BY_EXTENSION.get(
        attachment.name
          .slice(dotIndex + 1)
          .trim()
          .toLowerCase(),
      ) ?? null);
}

type ComposerAttachmentFileKind = "image" | "file" | "unsupported-image";

const HEIC_IMAGE_MIME_TYPE = /^image\/hei(?:c|f)$/i;
const HEIC_IMAGE_EXTENSION = /\.(?:heic|heif)$/i;

/** Finder and some browsers omit the MIME type when dragging HEIC photos. */
export function isHeicImageFile(file: { readonly name: string; readonly type: string }): boolean {
  if (HEIC_IMAGE_MIME_TYPE.test(file.type)) {
    return true;
  }
  return (
    (file.type === "" || file.type.toLowerCase() === "application/octet-stream") &&
    HEIC_IMAGE_EXTENSION.test(file.name)
  );
}

export function isDngFile(file: { readonly name: string; readonly type: string }): boolean {
  const mimeType = file.type.split(";", 1)[0]?.trim().toLowerCase();
  return (
    file.name.toLowerCase().endsWith(".dng") ||
    mimeType === "image/dng" ||
    mimeType === "image/x-dng" ||
    mimeType === "image/x-adobe-dng"
  );
}

export function inferComposerImageMimeType(file: {
  readonly name: string;
  readonly type: string;
}): string | null {
  const mimeType = file.type.toLowerCase();
  if (mimeType !== "" && mimeType !== "application/octet-stream") {
    return null;
  }
  const dotIndex = file.name.lastIndexOf(".");
  return dotIndex <= 0
    ? null
    : (IMAGE_MIME_TYPE_BY_EXTENSION.get(file.name.slice(dotIndex + 1).toLowerCase()) ?? null);
}

export function classifyComposerAttachmentFile(file: {
  readonly name: string;
  readonly type: string;
}): ComposerAttachmentFileKind {
  if (isSvgAttachment({ name: file.name, mimeType: file.type })) return "file";
  if (isDngFile(file)) return "file";
  if (isHeicImageFile(file)) {
    return "image";
  }
  if (inferComposerImageMimeType(file)) {
    return "image";
  }
  if (!file.type.toLowerCase().startsWith("image/")) {
    return "file";
  }
  if (SUPPORTED_IMAGE_MIME_TYPES.has(file.type.toLowerCase())) return "image";
  // These can be previewed as files, but providers must not receive them as images.
  return isWorkspaceImagePreviewPath(file.name) ? "file" : "unsupported-image";
}

export const unsupportedImageAttachmentMessage = (name: string) =>
  `'${name}' is not a supported image type. Attach GIF, HEIC, HEIF, JPEG, PNG, or WebP images.`;
