import { PDF_PAGE_IMAGES } from "../lead/turn/pdfPageImages.ts";

export const BILLS_PER_TURN = 5;
export const CHAT_MODEL_IMAGE_BYTES = 1024 * 1024;
export const BILL_MODEL_IMAGE_BYTES = Math.floor(PDF_PAGE_IMAGES.bytesPerTurn / BILLS_PER_TURN);

export type BillBox = readonly [x: number, y: number, width: number, height: number];

export type BillPage = (
  | { readonly kind: "photo"; readonly preview?: "chat" }
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
