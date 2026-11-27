import { describe, expect, it } from "@effect/vitest";
import { kinCanvasClampScale, kinCanvasDetail } from "@t3tools/client-runtime/kin/kinCanvasCamera";

import { detailBand, maxScale } from "./canvasZoom";

const DETAILS = ["dots", "titles", "cards", "near"];

describe("canvas zoom worklets", () => {
  it("match the shared camera on phone and tablet widths", () => {
    for (const width of [320, 375, 402, 440, 744, 1024]) {
      expect(maxScale(width), `max at ${width}`).toBe(kinCanvasClampScale(100, width));
      for (let scale = 0.05; scale < 3; scale += 0.01)
        expect(DETAILS[detailBand(scale, width)], `${scale} at ${width}`).toBe(
          kinCanvasDetail(scale, width),
        );
    }
  });
});
