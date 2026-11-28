import { IMAGE_ATTACHMENT_MAX_EDGE } from "@t3tools/shared/imageDimensions";

export { IMAGE_ATTACHMENT_MAX_EDGE };

export type DownscalableImageMimeType = "image/png" | "image/jpeg";

export function downscalableImageMimeType(mimeType: string): DownscalableImageMimeType | null {
  const normalized = mimeType.toLowerCase();
  if (normalized === "image/png") return "image/png";
  if (normalized === "image/jpeg" || normalized === "image/jpg") return "image/jpeg";
  return null;
}

export function fitImageAttachmentSize(
  size: { readonly width: number; readonly height: number },
  maxEdge: number = IMAGE_ATTACHMENT_MAX_EDGE,
): { width: number; height: number } | null {
  const longestEdge = Math.max(size.width, size.height);
  if (longestEdge <= maxEdge) return null;
  const scale = maxEdge / longestEdge;
  return {
    width: Math.max(1, Math.min(maxEdge, Math.round(size.width * scale))),
    height: Math.max(1, Math.min(maxEdge, Math.round(size.height * scale))),
  };
}
