export const BILL_MODEL_IMAGE_BYTES = 4 * 1024 * 1024;

export type BillBox = readonly [x: number, y: number, width: number, height: number];

export const BILL_GRID = 1000;
const BILL_PAD = 20;
export const validBillBox = ([x, y, w, h]: BillBox) =>
  [x, y, w, h].every(Number.isInteger) &&
  x >= 0 &&
  y >= 0 &&
  w >= 50 &&
  h >= 50 &&
  x + w <= BILL_GRID &&
  y + h <= BILL_GRID;

export const paddedBillBox = ([x, y, w, h]: BillBox): BillBox => {
  const left = Math.max(0, x - BILL_PAD);
  const top = Math.max(0, y - BILL_PAD);
  return [
    left,
    top,
    Math.min(BILL_GRID, x + w + BILL_PAD) - left,
    Math.min(BILL_GRID, y + h + BILL_PAD) - top,
  ];
};

export type BillPage = (
  | { readonly kind: "photo" }
  | { readonly kind: "pdf"; readonly page: number }
) & { readonly boxes: ReadonlyArray<BillBox> };

export type BillPageInput = BillPage & { readonly bytes: Uint8Array };

const problems = {
  box: "Kin couldn't cut this page",
  damaged: "Kin couldn't cut this page",
  heic: "Kin can't read this kind of photo: add it as a JPEG or PNG.",
  photo_pixels: "This photo is too large to cut: take it under 50 megapixels.",
  pdf_pages: "Too many pages to read as bills: split the PDF.",
  time: "Kin couldn't cut this page",
} as const;

export const refuseBillPage = (reason: keyof typeof problems) =>
  ({ _tag: "refused", reason, problem: problems[reason] }) as const;

export type BillPageOutcome =
  | ReturnType<typeof refuseBillPage>
  | {
      readonly _tag: "cut";
      readonly frame: { readonly width: number; readonly height: number };
      readonly preview?: Uint8Array;
      readonly crops: ReadonlyArray<Uint8Array>;
    };

export type BillCutterReply = { readonly outcome: BillPageOutcome; readonly peakKib: number };

export const MAX_BILL_BOXES = 24;
export const BILL_CUTTER_TIMEOUT_MS = 60_000;
export const BILL_CUTTER_OUTPUT_BYTES = 64 * 1024 * 1024;
