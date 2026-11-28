import { describe, expect, it } from "vite-plus/test";

import {
  IMAGE_ATTACHMENT_MAX_EDGE,
  downscalableImageMimeType,
  fitImageAttachmentSize,
} from "./imageAttachmentSize.ts";
import { fitBillPhotoSize } from "./kin/billPhotoSize.ts";
import { KIN_CHAT_PHOTO_MAX_EDGE } from "./kin/kinPhotoFit.ts";

describe("downscalableImageMimeType", () => {
  it.each([
    ["image/png", "image/png"],
    ["image/jpeg", "image/jpeg"],
    ["image/jpg", "image/jpeg"],
    ["IMAGE/PNG", "image/png"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(downscalableImageMimeType(input)).toBe(expected);
  });

  it.each(["image/gif", "image/webp", "text/plain"])("rejects %s", (input) => {
    expect(downscalableImageMimeType(input)).toBeNull();
  });
});

describe("fitBillPhotoSize", () => {
  it.each([
    [{ width: 4032, height: 3024 }, 3_000_000, null],
    [{ width: 10000, height: 5000 }, 3_000_000, null],
    [{ width: 12000, height: 6000 }, 3_000_000, { width: 10000, height: 5000 }],
    [{ width: 6000, height: 12000 }, 3_000_000, { width: 5000, height: 10000 }],
    [{ width: 10000, height: 5000 }, 41_943_040, { width: 4500, height: 2250 }],
    [{ width: 10000, height: 5001 }, 10_485_760, { width: 9999, height: 5000 }],
  ] as const)("fits %j and %i bytes within the upload ceilings", (size, bytes, expected) => {
    expect(fitBillPhotoSize(size, bytes)).toEqual(expected);
  });
});

describe("fitImageAttachmentSize", () => {
  it("continues to cap an ordinary phone photo at 2000 px", () => {
    expect(fitImageAttachmentSize({ width: 4032, height: 3024 })).toEqual({
      width: 2000,
      height: 1500,
    });
  });

  it.each([
    [
      "a 12 MP photo",
      { width: 4032, height: 3024 },
      { width: 2000, height: 1500 },
      { width: 3200, height: 2400 },
    ],
    [
      "a 48 MP portrait",
      { width: 6048, height: 8064 },
      { width: 1500, height: 2000 },
      { width: 2400, height: 3200 },
    ],
    ["a 3,000 px scan", { width: 3000, height: 2000 }, { width: 2000, height: 1333 }, null],
    ["a 3,200 px photo", { width: 3200, height: 1800 }, { width: 2000, height: 1125 }, null],
  ] as const)(
    "fits %s to 2,000 px in a thread and 3,200 px in a Kin chat",
    (_, size, thread, kin) => {
      expect(fitImageAttachmentSize(size)).toEqual(thread);
      expect(fitImageAttachmentSize(size, KIN_CHAT_PHOTO_MAX_EDGE)).toEqual(kin);
    },
  );

  it("returns null when the image already fits", () => {
    expect(fitImageAttachmentSize({ width: 800, height: 600 })).toBeNull();
    expect(
      fitImageAttachmentSize({
        width: IMAGE_ATTACHMENT_MAX_EDGE,
        height: IMAGE_ATTACHMENT_MAX_EDGE,
      }),
    ).toBeNull();
  });

  it("scales the longest edge down to the limit", () => {
    expect(fitImageAttachmentSize({ width: 4000, height: 2000 })).toEqual({
      width: 2000,
      height: 1000,
    });
  });

  it("clamps the short edge of extreme aspect ratios to at least 1px", () => {
    expect(fitImageAttachmentSize({ width: 1, height: 10000 })).toEqual({
      width: 1,
      height: IMAGE_ATTACHMENT_MAX_EDGE,
    });
  });
});
