/** A rectangle in canvas units. */
export interface KinCanvasBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** The canvas point at the middle of the screen, and screen points per canvas unit. */
export interface KinCanvasCamera {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

export interface KinCanvasInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export const KIN_CANVAS_MIN_SCALE = 0.08;
export const KIN_CANVAS_MAX_SCALE = 2.5;
const NO_INSETS: KinCanvasInsets = { top: 0, right: 0, bottom: 0, left: 0 };

export const kinCanvasClampScale = (scale: number) =>
  Math.min(KIN_CANVAS_MAX_SCALE, Math.max(KIN_CANVAS_MIN_SCALE, scale));

/** The camera that shows `box` in the part of a `width` × `height` screen the chrome leaves free. */
export function kinCanvasFit(
  box: KinCanvasBox,
  width: number,
  height: number,
  insets: KinCanvasInsets = NO_INSETS,
  pad = 32,
  maxScale = 1,
): KinCanvasCamera {
  const w = width - insets.left - insets.right - pad * 2;
  const h = height - insets.top - insets.bottom - pad * 2;
  if (box.w <= 0 || box.h <= 0 || w <= 0 || h <= 0)
    return { x: box.x + box.w / 2, y: box.y + box.h / 2, scale: 1 };
  const scale = kinCanvasClampScale(Math.min(w / box.w, h / box.h, maxScale));
  return {
    x: box.x + box.w / 2 - (insets.left - insets.right) / 2 / scale,
    y: box.y + box.h / 2 - (insets.top - insets.bottom) / 2 / scale,
    scale,
  };
}

/** The part of the canvas a camera shows. */
export const kinCanvasVisible = (
  camera: KinCanvasCamera,
  width: number,
  height: number,
): KinCanvasBox => ({
  x: camera.x - width / 2 / camera.scale,
  y: camera.y - height / 2 / camera.scale,
  w: width / camera.scale,
  h: height / camera.scale,
});

const kinCanvasToWorld = (
  camera: KinCanvasCamera,
  width: number,
  height: number,
  sx: number,
  sy: number,
) => ({
  x: (sx - width / 2) / camera.scale + camera.x,
  y: (sy - height / 2) / camera.scale + camera.y,
});

export const kinCanvasPan = (camera: KinCanvasCamera, dx: number, dy: number): KinCanvasCamera => ({
  ...camera,
  x: camera.x - dx / camera.scale,
  y: camera.y - dy / camera.scale,
});

/** Zoom by `factor` keeping the canvas point under the screen point (sx, sy) where it is. */
export function kinCanvasZoom(
  camera: KinCanvasCamera,
  factor: number,
  sx: number,
  sy: number,
  width: number,
  height: number,
): KinCanvasCamera {
  const scale = kinCanvasClampScale(camera.scale * factor);
  const at = kinCanvasToWorld(camera, width, height, sx, sy);
  return { scale, x: at.x - (sx - width / 2) / scale, y: at.y - (sy - height / 2) / scale };
}

/** Partway (0..1) along a camera move: eased, with zoom in log space so it feels even. */
export function kinCanvasTween(
  from: KinCanvasCamera,
  to: KinCanvasCamera,
  k: number,
): KinCanvasCamera {
  const t = Math.min(1, Math.max(0, k));
  const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
  const a = Math.log(from.scale);
  const b = Math.log(to.scale);
  return {
    x: from.x + (to.x - from.x) * e,
    y: from.y + (to.y - from.y) * e,
    scale: Math.exp(a + (b - a) * e),
  };
}

/** A move's length in ms: short hops are quick, long ones never drag. */
export const kinCanvasTweenMs = (from: KinCanvasCamera, to: KinCanvasCamera) =>
  Math.round(
    Math.min(
      600,
      240 +
        Math.hypot(to.x - from.x, to.y - from.y) * Math.min(from.scale, to.scale) * 0.08 +
        Math.abs(Math.log(to.scale / from.scale)) * 120,
    ),
  );

/**
 * How much a card says at a zoom. `dots`: only its colour. `titles`: key and title. `cards`: the
 * whole card. `near`: the card is about as wide as the screen, so it shows what it says (a doc's
 * text, a task's notes) to read in place. `width` is the screen's, in points.
 */
export type KinCanvasDetail = "dots" | "titles" | "cards" | "near";
export const kinCanvasDetail = (scale: number, width = Infinity): KinCanvasDetail =>
  scale < 0.22
    ? "dots"
    : scale < 0.55
      ? "titles"
      : scale < Math.max(1.1, Math.min(1.6, (width - 32) / KIN_CANVAS_NEAR_CARD_W))
        ? "cards"
        : "near";

/** A card's width in canvas units, which `near` measures against the screen. */
const KIN_CANVAS_NEAR_CARD_W = 240;
