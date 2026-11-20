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

const sizeList = Object.entries(KIN_PICTURE_SIZES)
  .map(([name, size]) => `${name} ${size.width}×${size.height}`)
  .join(", ");
/** What a picture's page adds to a chat page's rules (`KIN_VISUAL_PAGE_GUIDE`). */
export const KIN_PICTURE_PAGE_GUIDE = [
  "A picture is drawn once, with nobody looking: no hover, taps, scrolling, links or saving.",
  `Unlike a page in the chat, it fills exactly the size you named, in CSS pixels: ${sizeList}. Give html and body that size, your own background and padding, and keep every word inside it.`,
  `Kin draws it at ${KIN_PICTURE_SCALE} times that, so text stays sharp, in the light theme. Draw everything as the page loads; anything still running after 15 seconds is stopped.`,
  "Make it the company's own: --brand-primary and --brand-secondary are its main colours and --brand-font its type, and the logo belongs on anything posted or sent. Add other colours only around them.",
  "You don't see it before it is filed, so lay it out in flow with flex or grid. Place something absolutely only in space nothing else uses: headlines run wide at picture sizes.",
].join("\n");
