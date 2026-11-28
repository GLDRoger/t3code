/**
 * A photo sent in a Kin chat keeps its pixels up to this long edge, so a receipt that is a third
 * of a collage can still be read; a T3 thread's stay at `IMAGE_ATTACHMENT_MAX_EDGE`. Not 4,032:
 * the web chat draws each message photo from the stored file, with no smaller copy.
 */
export const KIN_CHAT_PHOTO_MAX_EDGE = 3200;

/**
 * Photos sent together in one message, fitted under the message's image cap before they upload.
 * Bills are cut out of these photos, so pixels go last: the JPEG quality falls first, then the
 * long edge, and never past either floor. A PDF is never one of these.
 */
export const KIN_PHOTO_FIT = {
  /** A message's images together, as `chatAttachment.ts` caps them (its constant isn't exported). */
  cap: 80 * 1024 * 1024,
  qualities: [0.85, 0.8, 0.75, 0.7],
  edges: [3200, 2800, 2400],
  minEdge: 2400,
  tooLarge: "These photos are too large to send together. Send them in two messages.",
} as const;

export interface KinPhotoFitStep {
  readonly quality: number;
  /** Null keeps every pixel. */
  readonly maxEdge: number | null;
}

const LAST_QUALITY = KIN_PHOTO_FIT.qualities.at(-1)!;
const STEPS: ReadonlyArray<KinPhotoFitStep> = [
  ...KIN_PHOTO_FIT.qualities.map((quality) => ({ quality, maxEdge: null })),
  ...KIN_PHOTO_FIT.edges.map((maxEdge) => ({ quality: LAST_QUALITY, maxEdge })),
];

/**
 * `items` are a message's images, in order. Each step re-encodes every photo it may from its
 * original; a photo whose long edge already fits a step's edge keeps its full-pixel encoding.
 */
export async function kinPhotosFit<P>(input: {
  readonly items: ReadonlyArray<{
    readonly source: P;
    readonly bytes: number;
    readonly longEdge: number | null;
    /** False for what can't be re-encoded as a JPEG (an animated GIF): counted, never changed. */
    readonly reencode: boolean;
  }>;
  readonly cap: number;
  readonly encode: (
    source: P,
    step: KinPhotoFitStep,
  ) => Promise<{ readonly photo: P; readonly bytes: number } | null>;
}): Promise<
  | { readonly _tag: "fits"; readonly items: ReadonlyArray<P> }
  | { readonly _tag: "tooLarge"; readonly text: string }
> {
  const total = (sizes: ReadonlyArray<number>) => sizes.reduce((sum, bytes) => sum + bytes, 0);
  if (total(input.items.map((item) => item.bytes)) <= input.cap)
    return { _tag: "fits", items: input.items.map((item) => item.source) };
  let best = input.items.map((item) => ({ photo: item.source, bytes: item.bytes }));
  for (const step of STEPS) {
    const next = [];
    for (const [index, item] of input.items.entries()) {
      const held = best[index]!;
      const fitsEdge =
        step.maxEdge !== null && (item.longEdge === null || item.longEdge <= step.maxEdge);
      if (!item.reencode || fitsEdge) {
        next.push(held);
        continue;
      }
      const encoded = await input.encode(item.source, step).catch(() => null);
      next.push(encoded !== null && encoded.bytes < held.bytes ? encoded : held);
    }
    best = next;
    if (total(best.map((one) => one.bytes)) <= input.cap)
      return { _tag: "fits", items: best.map((one) => one.photo) };
  }
  return { _tag: "tooLarge", text: KIN_PHOTO_FIT.tooLarge };
}
