import { KIN_CANVAS_MAX_SCALE } from "@t3tools/client-runtime/kin/kinCanvasCamera";

/** `kinCanvasNearScale` and `kinCanvasMaxScale` again, as worklets for the UI thread. */
export const nearScale = (width: number) => {
  "worklet";
  return Math.max(1, Math.min(1.6, (width * 0.75) / 240));
};

export const maxScale = (width: number) => {
  "worklet";
  return Math.max(nearScale(width) * 1.15, Math.min(KIN_CANVAS_MAX_SCALE, (width - 24) / 240));
};

/** `kinCanvasDetail`'s bands as an index into dots, titles, cards, near. */
export const detailBand = (scale: number, width: number) => {
  "worklet";
  return scale < 0.22 ? 0 : scale < 0.55 ? 1 : scale < nearScale(width) ? 2 : 3;
};
