import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import { ImageVendorError, type KinImageVendor, type PixelSize } from "./ImageVendor.ts";

/** A 1×1 PNG: every picture the fake makes. */
export const FAKE_PNG = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

export type FakeImageMode = "ok" | "refuse" | "reject" | "silent" | "down";
export type FakeImageCall = {
  readonly key: string;
  readonly model: string;
  readonly prompt: string;
  readonly size: PixelSize;
  readonly count: number;
};

/**
 * A picture service in memory: the fixed PNG per picture asked for, every call recorded. `mode`
 * makes it refuse the prompt, reject the key, fail, or never answer; `before` runs ahead of each
 * answer, so a test can hold a call there.
 */
export const makeFakeImageVendor = (
  options: { readonly name?: string; readonly label?: string } = {},
) => {
  const calls: Array<FakeImageCall> = [];
  const control = {
    mode: "ok" as FakeImageMode,
    refusal: "The prompt asks for a real person's likeness." as string | null,
    before: Effect.void as Effect.Effect<void>,
  };
  const vendor: KinImageVendor = {
    name: options.name ?? "openai",
    label: options.label ?? "OpenAI",
    host: "api.openai.com",
    keyUrl: "https://platform.openai.com/api-keys",
    defaultModel: "gpt-image-2.5-flare",
    sizes: [
      { width: 1024, height: 1024 },
      { width: 1536, height: 1024 },
      { width: 1024, height: 1536 },
    ],
    generate: Effect.fn("FakeImageVendor.generate")(function* (key, request) {
      calls.push({ key: Redacted.value(key), ...request });
      yield* control.before;
      switch (control.mode) {
        case "ok":
          return {
            images: Array.from({ length: request.count }, () => ({
              bytes: FAKE_PNG,
              mimeType: "image/png",
            })),
          };
        case "refuse":
          return yield* new ImageVendorError({ kind: "refused", reason: control.refusal });
        case "reject":
          return yield* new ImageVendorError({ kind: "key_rejected", reason: null });
        case "down":
          return yield* new ImageVendorError({ kind: "unavailable", reason: null });
        case "silent":
          return yield* Effect.never;
      }
    }),
  };
  return { vendor, calls, control };
};
