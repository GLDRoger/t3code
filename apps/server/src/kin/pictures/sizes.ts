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

/** A named size in the file's own pixels. */
export const pictureOutput = (size: KinPictureSize) => ({
  width: KIN_PICTURE_SIZES[size].width * KIN_PICTURE_SCALE,
  height: KIN_PICTURE_SIZES[size].height * KIN_PICTURE_SCALE,
});

const sizeList = Object.entries(KIN_PICTURE_SIZES)
  .map(([name, size]) => `${name} ${size.width}×${size.height}`)
  .join(", ");
/** What a picture's page adds to a chat page's rules (`KIN_VISUAL_PAGE_GUIDE`). */
export const KIN_PICTURE_PAGE_GUIDE = [
  `A picture is drawn once, with nobody looking: no hover, taps, scrolling, links or saving. It fills exactly the size named, in CSS pixels: ${sizeList}; give html and body that size, your own background and padding, and keep every word inside it.`,
  `Kin draws it at ${KIN_PICTURE_SCALE} times that in the light theme; anything still running after 15 seconds is stopped. Make it the company's own: the brand colours and font, other colours only around them, and the logo on anything posted or sent. You don't see it before it is filed: lay it out in flow with flex or grid, and place something absolutely only in space nothing else uses.`,
].join("\n");
