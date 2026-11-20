import * as Schema from "effect/Schema";

/** Layout in CSS pixels; the file is drawn at `KIN_PICTURE_SCALE` times that, so text stays sharp. */
export const KIN_PICTURE_SIZES = {
  square: { width: 540, height: 540 },
  portrait: { width: 540, height: 675 },
  story: { width: 540, height: 960 },
  landscape: { width: 960, height: 540 },
  link: { width: 600, height: 314 },
  page: { width: 794, height: 1123 },
} as const;
export const KIN_PICTURE_SCALE = 2;

export const KinPictureSize = Schema.Literals([
  "square",
  "portrait",
  "story",
  "landscape",
  "link",
  "page",
]);
export type KinPictureSize = typeof KinPictureSize.Type;
