import { createCanvas, loadImage, type Image, type SKRSContext2D } from "@napi-rs/canvas";
import { describe, expect, it } from "vite-plus/test";

import { fitImageAttachmentSize } from "../imageAttachmentSize.ts";
import {
  KIN_CHAT_PHOTO_MAX_EDGE,
  KIN_PHOTO_FIT,
  kinPhotosFit,
  type KinPhotoFitStep,
} from "./kinPhotoFit.ts";

/** Chat photo quality today: the phone's `composerImageFit.ts` and the web's `imageCompression.ts`. */
const APP_QUALITY = { phone: 0.85, web: 0.92 } as const;
const WIDTH = 4032;
const HEIGHT = 3024;

function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A receipt: paper, a header, rows of print and a total, turned a little as a hand lays it. */
function receipt(
  context: SKRSContext2D,
  next: () => number,
  box: { x: number; y: number; w: number; h: number; turn: number },
) {
  context.save();
  context.translate(box.x + box.w / 2, box.y + box.h / 2);
  context.rotate(box.turn);
  context.shadowColor = "rgba(0,0,0,0.35)";
  context.shadowBlur = 40;
  context.fillStyle = "#f4f1ea";
  context.fillRect(-box.w / 2, -box.h / 2, box.w, box.h);
  context.shadowBlur = 0;
  context.fillStyle = "#1d1d1f";
  context.font = `bold ${Math.round(box.w / 12)}px sans-serif`;
  context.fillText("HARBOR CAFE", -box.w / 2 + 40, -box.h / 2 + 120);
  context.font = `${Math.round(box.w / 22)}px monospace`;
  for (let line = 0, y = -box.h / 2 + 220; y < box.h / 2 - 80; line += 1, y += box.w / 16) {
    const words = 2 + Math.floor(next() * 4);
    const text = Array.from({ length: words }, () => Math.floor(next() * 99_999).toString(36)).join(
      " ",
    );
    context.fillText(`${text}  ${(next() * 900).toFixed(2)}`, -box.w / 2 + 40, y);
    if (line % 7 === 6) context.fillRect(-box.w / 2 + 40, y + 12, box.w - 80, 3);
  }
  context.restore();
}

/** Sensor noise, which is most of what makes a real photo's JPEG large. */
function grain(context: SKRSContext2D, next: () => number, amount: number) {
  const image = context.getImageData(0, 0, WIDTH, HEIGHT);
  const data = image.data;
  for (let index = 0; index < data.length; index += 4) {
    const shift = (next() - 0.5) * amount;
    data[index] = data[index]! + shift + (next() - 0.5) * amount * 0.5;
    data[index + 1] = data[index + 1]! + shift;
    data[index + 2] = data[index + 2]! + shift + (next() - 0.5) * amount * 0.5;
  }
  context.putImageData(image, 0, 0);
}

/** Three 12 MP photos shaped like what an owner sends: each is drawn, then given grain. */
const FIXTURES = {
  /** Three receipts side by side on a wooden table. */
  collage: (context: SKRSContext2D, next: () => number) => {
    context.fillStyle = "#6b4a2f";
    context.fillRect(0, 0, WIDTH, HEIGHT);
    for (let y = 0; y < HEIGHT; y += 6) {
      context.fillStyle = `rgba(${40 + next() * 50},${25 + next() * 30},10,${0.2 + next() * 0.3})`;
      context.fillRect(0, y + Math.sin(y / 90) * 8, WIDTH, 3 + next() * 4);
    }
    for (const [index, turn] of [-0.04, 0.02, -0.015].entries())
      receipt(context, next, { x: 120 + index * 1300, y: 160, w: 1150, h: 2700, turn });
    grain(context, next, 22);
  },
  /** One receipt held over a patterned rug: the hardest kind to compress. */
  busy: (context: SKRSContext2D, next: () => number) => {
    context.fillStyle = "#4a5a3a";
    context.fillRect(0, 0, WIDTH, HEIGHT);
    for (let index = 0; index < 60_000; index += 1) {
      context.fillStyle = `hsl(${next() * 360},${30 + next() * 50}%,${20 + next() * 50}%)`;
      context.beginPath();
      context.ellipse(
        next() * WIDTH,
        next() * HEIGHT,
        4 + next() * 18,
        2 + next() * 10,
        next() * Math.PI,
        0,
        Math.PI * 2,
      );
      context.fill();
    }
    receipt(context, next, { x: 1300, y: 300, w: 1400, h: 2400, turn: 0.05 });
    grain(context, next, 30);
  },
  /** One receipt on a plain desk under soft light. */
  calm: (context: SKRSContext2D, next: () => number) => {
    const light = context.createLinearGradient(0, 0, WIDTH, HEIGHT);
    light.addColorStop(0, "#d9d4cc");
    light.addColorStop(1, "#8f877c");
    context.fillStyle = light;
    context.fillRect(0, 0, WIDTH, HEIGHT);
    receipt(context, next, { x: 1200, y: 200, w: 1500, h: 2600, turn: -0.03 });
    grain(context, next, 12);
  },
} as const;
type Fixture = keyof typeof FIXTURES;

async function jpeg(source: Image, quality: number, maxEdge: number | null) {
  const fitted = maxEdge === null ? null : fitImageAttachmentSize(source, maxEdge);
  const { width, height } = fitted ?? source;
  const canvas = createCanvas(width, height);
  canvas.getContext("2d").drawImage(source, 0, 0, width, height);
  return canvas.encode("jpeg", Math.round(quality * 100));
}

/** Each fixture as a camera wrote it, then as a Kin chat on each app stores it. */
async function photos() {
  const made = new Map<
    Fixture,
    {
      readonly camera: number;
      readonly stored: Record<keyof typeof APP_QUALITY, Image & { bytes: number }>;
    }
  >();
  for (const [index, name] of (Object.keys(FIXTURES) as Fixture[]).entries()) {
    const canvas = createCanvas(WIDTH, HEIGHT);
    FIXTURES[name](canvas.getContext("2d"), random(index + 1));
    const camera = await canvas.encode("jpeg", 92);
    const original = await loadImage(camera);
    const stored = async (quality: number) => {
      const bytes = await jpeg(original, quality, KIN_CHAT_PHOTO_MAX_EDGE);
      return Object.assign(await loadImage(bytes), { bytes: bytes.byteLength });
    };
    made.set(name, {
      camera: camera.byteLength,
      stored: { phone: await stored(APP_QUALITY.phone), web: await stored(APP_QUALITY.web) },
    });
  }
  return made;
}

/** Twenty photos, as a person sends a day's receipts: mostly collages. */
const TWENTY: ReadonlyArray<Fixture> = [
  ...Array<Fixture>(10).fill("collage"),
  ...Array<Fixture>(5).fill("busy"),
  ...Array<Fixture>(5).fill("calm"),
];

describe("twenty 12 MP photos in one Kin chat message, measured", () => {
  it("are stored at 3,200 px and go through part 1's size plan in its order", async () => {
    const made = await photos();
    for (const app of ["phone", "web"] as const) {
      const cache = new Map<string, number>();
      const steps: Array<KinPhotoFitStep> = [];
      const encode = async (name: Fixture, step: KinPhotoFitStep) => {
        steps.push(step);
        const key = `${name}:${step.quality}:${step.maxEdge}`;
        const bytes =
          cache.get(key) ??
          (await jpeg(made.get(name)!.stored[app], step.quality, step.maxEdge)).byteLength;
        cache.set(key, bytes);
        return { photo: name, bytes };
      };
      const set = (names: ReadonlyArray<Fixture>) =>
        names.map((name) => ({
          source: name,
          bytes: made.get(name)!.stored[app].bytes,
          longEdge: KIN_CHAT_PHOTO_MAX_EDGE,
          reencode: true,
        }));
      for (const { stored } of made.values())
        expect(Math.max(stored[app].width, stored[app].height)).toBe(KIN_CHAT_PHOTO_MAX_EDGE);

      // A day's twenty go as they are: the plan never runs.
      expect(await kinPhotosFit({ items: set(TWENTY), cap: KIN_PHOTO_FIT.cap, encode })).toEqual({
        _tag: "fits",
        items: TWENTY,
      });
      expect(steps).toEqual([]);

      // Forty of the hardest pass the cap; quality alone brings them under it, every pixel kept.
      const forty = Array<Fixture>(40).fill("busy");
      expect(await kinPhotosFit({ items: set(forty), cap: KIN_PHOTO_FIT.cap, encode })).toEqual({
        _tag: "fits",
        items: forty,
      });
      expect(steps[0]).toEqual({ quality: 0.85, maxEdge: null });
      expect(steps.every((step) => step.maxEdge === null && step.quality >= 0.7)).toBe(true);
    }
  });
});
