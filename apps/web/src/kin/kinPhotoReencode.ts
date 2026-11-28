/** A photo again as a JPEG at `quality`, its long edge at most `maxEdge`; null keeps every pixel. */
export async function kinPhotoReencode(
  file: File,
  quality: number,
  maxEdge: number | null,
): Promise<File | null> {
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") return null;
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const longest = Math.max(bitmap.width, bitmap.height);
    const scale = maxEdge === null || longest <= maxEdge ? 1 : maxEdge / longest;
    const canvas = new OffscreenCanvas(
      Math.max(1, Math.round(bitmap.width * scale)),
      Math.max(1, Math.round(bitmap.height * scale)),
    );
    const context = canvas.getContext("2d");
    if (context === null) return null;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
    const base = (file.name || "image").replace(/\.[^.]+$/, "");
    return new File([blob], `${base}.jpg`, { type: "image/jpeg", lastModified: file.lastModified });
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}
