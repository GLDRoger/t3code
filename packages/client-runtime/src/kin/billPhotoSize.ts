import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@t3tools/contracts";
import { BILL_PHOTO_MAX_PIXELS, type ImageDimensions } from "@t3tools/shared/imageDimensions";

export function fitBillPhotoSize(size: ImageDimensions, bytes: number): ImageDimensions | null {
  const pixels = size.width * size.height;
  if (pixels <= BILL_PHOTO_MAX_PIXELS && bytes <= PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) return null;
  // Encoded size roughly tracks pixel count; leave headroom when the source exceeds the byte limit.
  const scale = Math.min(
    Math.sqrt(BILL_PHOTO_MAX_PIXELS / pixels),
    bytes > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
      ? Math.sqrt(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES / bytes) * 0.9
      : 1,
  );
  return {
    width: Math.max(1, Math.min(BILL_PHOTO_MAX_PIXELS, Math.floor(size.width * scale))),
    height: Math.max(1, Math.min(BILL_PHOTO_MAX_PIXELS, Math.floor(size.height * scale))),
  };
}
