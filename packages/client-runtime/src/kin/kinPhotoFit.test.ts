import { describe, expect, it } from "vite-plus/test";

import { KIN_PHOTO_FIT, kinPhotosFit, type KinPhotoFitStep } from "./kinPhotoFit.ts";

const MB = 1024 * 1024;

/** A fake encoder: bytes fall with quality, and with the long edge squared. */
function encoder() {
  const steps: Array<{ readonly name: string } & KinPhotoFitStep> = [];
  return {
    steps,
    encode: async (photo: { name: string; bytes: number; edge: number }, step: KinPhotoFitStep) => {
      steps.push({ name: photo.name, ...step });
      const edge = step.maxEdge === null ? photo.edge : Math.min(photo.edge, step.maxEdge);
      const bytes = Math.round(photo.bytes * step.quality * (edge / photo.edge) ** 2);
      return { photo: { ...photo, bytes, edge }, bytes };
    },
  };
}

const photo = (name: string, bytes: number, edge = 4032) => ({
  source: { name, bytes, edge },
  bytes,
  longEdge: edge,
  reencode: true,
});

describe("photos that would pass a message's image cap", () => {
  it("leaves photos that fit untouched", async () => {
    const fake = encoder();
    const photos = [photo("a", 30 * MB), photo("b", 30 * MB)];
    expect(await kinPhotosFit({ items: photos, cap: 80 * MB, encode: fake.encode })).toEqual({
      _tag: "fits",
      items: photos.map((one) => one.source),
    });
    expect(fake.steps).toEqual([]);
  });

  it("lowers the quality first, keeping every pixel", async () => {
    const fake = encoder();
    // 20 photos of 5 MiB: 100 MiB, past an 80 MiB cap.
    const photos = Array.from({ length: 20 }, (_, index) => photo(`p${index}`, 5 * MB));
    const fitted = await kinPhotosFit({ items: photos, cap: 80 * MB, encode: fake.encode });
    expect(fitted._tag).toBe("fits");
    if (fitted._tag !== "fits") return;
    expect(fitted.items.every((one) => one.edge === 4032)).toBe(true);
    expect(fitted.items.reduce((sum, one) => sum + one.bytes, 0)).toBeLessThanOrEqual(80 * MB);
    expect(new Set(fake.steps.map((step) => step.maxEdge))).toEqual(new Set([null]));
    expect(Math.min(...fake.steps.map((step) => step.quality))).toBeGreaterThanOrEqual(0.7);
  });

  it("then lowers the long edge, never under 2,400 px, and never re-encodes what it may not", async () => {
    const fake = encoder();
    const gif = { ...photo("moving.gif", 2 * MB, 800), reencode: false };
    const photos = [gif, ...Array.from({ length: 20 }, (_, index) => photo(`p${index}`, 9 * MB))];
    const fitted = await kinPhotosFit({ items: photos, cap: 80 * MB, encode: fake.encode });
    expect(fitted._tag).toBe("fits");
    if (fitted._tag !== "fits") return;
    expect(fitted.items[0]).toBe(gif.source);
    expect(fake.steps.some((step) => step.name === "moving.gif")).toBe(false);
    const edges = fake.steps.flatMap((step) => (step.maxEdge === null ? [] : [step.maxEdge]));
    expect(edges.length).toBeGreaterThan(0);
    expect(Math.min(...edges)).toBeGreaterThanOrEqual(KIN_PHOTO_FIT.minEdge);
    // Every quality step came before any edge step.
    const firstEdge = fake.steps.findIndex((step) => step.maxEdge !== null);
    expect(fake.steps.slice(firstEdge).every((step) => step.quality === 0.7)).toBe(true);
    expect(fake.steps.slice(0, firstEdge).every((step) => step.maxEdge === null)).toBe(true);
  });

  it("says so, whole, when even the smallest it may make does not fit", async () => {
    const fake = encoder();
    // Already small photos: no edge step helps, and quality alone is not enough.
    const photos = Array.from({ length: 40 }, (_, index) => photo(`p${index}`, 4 * MB, 2000));
    expect(await kinPhotosFit({ items: photos, cap: 80 * MB, encode: fake.encode })).toEqual({
      _tag: "tooLarge",
      text: "These photos are too large to send together. Send them in two messages.",
    });
    expect(fake.steps.every((step) => step.maxEdge === null)).toBe(true);
  });
});
