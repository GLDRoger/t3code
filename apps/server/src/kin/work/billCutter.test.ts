import * as NodeBuffer from "node:buffer";

import { describe, expect, it } from "@effect/vitest";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import * as Effect from "effect/Effect";

import { scannedBillPdf, withJpegOrientation } from "../../../scripts/kin-bill-cutter-benchmark.ts";
import { cutBillPage } from "./billCutter.ts";

const photo = (bytes: Uint8Array) => ({
  kind: "photo" as const,
  bytes,
  boxes: [[30, 30, 450, 450]] as const,
});

const rotatedJpeg = async (orientation = 6) => {
  const sheet = createCanvas(200, 100);
  const context = sheet.getContext("2d");
  context.fillStyle = "#dd2317";
  context.fillRect(0, 0, 100, 100);
  context.fillStyle = "#165bdc";
  context.fillRect(100, 0, 100, 100);
  return withJpegOrientation(await sheet.encode("jpeg", 95), orientation);
};

describe("cutBillPage", () => {
  it.effect("uses an EXIF 6 photo's upright frame for the preview and crop", () =>
    Effect.gen(function* () {
      const bytes = yield* Effect.promise(() => rotatedJpeg());
      const { outcome: preview } = yield* cutBillPage({ ...photo(bytes), boxes: [] });
      const { outcome } = yield* cutBillPage(photo(bytes));
      expect(outcome._tag).toBe("cut");
      if (outcome._tag !== "cut") return;
      expect(outcome.frame).toMatchObject({ width: 100, height: 200 });
      expect(preview._tag).toBe("cut");
      if (preview._tag !== "cut") return;
      expect(preview.preview).toBeDefined();
      const crop = yield* Effect.promise(() =>
        loadImage(NodeBuffer.Buffer.from(outcome.crops[0]!)),
      );
      expect([crop.width, crop.height]).toEqual([49, 98]);
      for (const jpeg of [preview.preview!, outcome.crops[0]!]) {
        const image = yield* Effect.promise(() => loadImage(NodeBuffer.Buffer.from(jpeg)));
        const sheet = createCanvas(image.width, image.height);
        const context = sheet.getContext("2d");
        context.drawImage(image, 0, 0);
        const [red, , blue] = context.getImageData(image.width / 2, image.height / 4, 1, 1).data;
        expect(red).toBeGreaterThan(180);
        expect(blue).toBeLessThan(70);
      }
    }),
  );

  it.effect("draws an upright preview for a half-turn with unchanged dimensions", () =>
    Effect.gen(function* () {
      const bytes = yield* Effect.promise(() => rotatedJpeg(3));
      const { outcome } = yield* cutBillPage({ ...photo(bytes), boxes: [] });
      expect(outcome).toMatchObject({
        _tag: "cut",
        frame: { width: 200, height: 100 },
        preview: expect.any(Uint8Array),
      });
    }),
  );

  it.effect("refuses a box outside the page", () =>
    Effect.gen(function* () {
      const bytes = yield* Effect.promise(() => rotatedJpeg());
      const { outcome } = yield* cutBillPage({ ...photo(bytes), boxes: [[800, 0, 201, 100]] });
      expect(outcome).toMatchObject({ _tag: "refused", reason: "box" });
    }),
  );

  it.effect("refuses a 51 MP header before trying to decode", () =>
    Effect.gen(function* () {
      const bytes = NodeBuffer.Buffer.from(
        "89504e470d0a1a0a0000000d4948445200002710000013ec",
        "hex",
      );
      const { outcome } = yield* cutBillPage(photo(bytes));
      expect(outcome).toMatchObject({
        _tag: "refused",
        reason: "photo_pixels",
        problem: "This photo is too large to cut: take it under 50 megapixels.",
      });
    }),
  );

  it.effect("refuses a HEIC photo", () =>
    Effect.gen(function* () {
      const bytes = NodeBuffer.Buffer.from(
        "000000186674797068656963000000006d69663168656963",
        "hex",
      );
      const { outcome } = yield* cutBillPage(photo(bytes));
      expect(outcome).toMatchObject({ _tag: "refused", reason: "heic" });
    }),
  );

  const pdfInput = (bytes: Uint8Array) => ({
    kind: "pdf" as const,
    page: 1,
    bytes,
    boxes: [[0, 0, 1000, 1000]] as const,
  });

  it.effect("rasterizes a PDF at up to 300 dpi and clamps padded crops to the page", () =>
    Effect.gen(function* () {
      const sheet = createCanvas(24, 18);
      const context = sheet.getContext("2d");
      context.fillStyle = "#bb2417";
      context.fillRect(0, 0, sheet.width, sheet.height);
      const jpeg = yield* Effect.promise(() => sheet.encode("jpeg", 90));
      const bytes = scannedBillPdf({ jpeg, width: 24, height: 18 });
      const { outcome } = yield* cutBillPage(pdfInput(bytes));
      expect(outcome._tag).toBe("cut");
      if (outcome._tag !== "cut") return;
      expect(outcome.frame).toEqual({ width: 2480, height: 3508 });
      const crop = yield* Effect.promise(() =>
        loadImage(NodeBuffer.Buffer.from(outcome.crops[0]!)),
      );
      expect([crop.width, crop.height]).toEqual([1767, 2500]);
      const pixel = createCanvas(1, 1).getContext("2d");
      pixel.drawImage(crop, 0, 0, 1, 1);
      const [red, , blue] = pixel.getImageData(0, 0, 1, 1).data;
      expect(red).toBeGreaterThan(150);
      expect(blue).toBeLessThan(70);
    }),
  );

  it.effect("limits a large PDF page to 12 MP", () =>
    Effect.gen(function* () {
      const jpeg = yield* Effect.promise(() => createCanvas(2, 2).encode("jpeg", 90));
      const bytes = scannedBillPdf({
        jpeg,
        width: 2,
        height: 2,
        pageWidth: 1200,
        pageHeight: 1200,
      });
      const { outcome } = yield* cutBillPage({ ...pdfInput(bytes), boxes: [] });
      expect(outcome).toMatchObject({ _tag: "cut", frame: { width: 3464, height: 3464 } });
    }),
  );

  it.effect("refuses to split a PDF of more than 50 pages", () =>
    Effect.gen(function* () {
      const jpeg = yield* Effect.promise(() => createCanvas(2, 2).encode("jpeg", 90));
      const bytes = scannedBillPdf({ jpeg, width: 2, height: 2, pageCount: 51 });
      const { outcome } = yield* cutBillPage(pdfInput(bytes));
      expect(outcome).toMatchObject({ _tag: "refused", reason: "pdf_pages" });
    }),
  );

  it.effect("kills and reaps the child at its time limit", () =>
    Effect.gen(function* () {
      const bytes = yield* Effect.promise(() => rotatedJpeg());
      const result = yield* cutBillPage(photo(bytes), { timeoutMs: 1 });
      expect(result).toMatchObject({
        outcome: { _tag: "refused", reason: "time" },
        signal: "SIGKILL",
      });
    }),
  );
});
