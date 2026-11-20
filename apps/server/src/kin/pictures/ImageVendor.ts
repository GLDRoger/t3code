import type * as Effect from "effect/Effect";
import type * as HttpClient from "effect/http/HttpClient";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

/**
 * Why a picture service made nothing. `reason` is the service's own words when it gave any, cut
 * short; it never carries the key, the request or a raw body.
 */
export class ImageVendorError extends Schema.TaggedError<ImageVendorError>()("ImageVendorError", {
  kind: Schema.Literals([
    /** It turned the prompt down. */
    "refused",
    /** The key is wrong, revoked, or may not use the model. */
    "key_rejected",
    /** No answer, too slow, or the service failed. */
    "unavailable",
  ]),
  reason: Schema.NullOr(Schema.String),
}) {}

export type PictureKey = Redacted.Redacted<string>;
export type PixelSize = { readonly width: number; readonly height: number };

export type GeneratedImage = { readonly bytes: Uint8Array; readonly mimeType: string };

/**
 * One image service. Kin's sizes, counts, limits and files never depend on which; another
 * vendor is one more of these.
 */
export interface KinImageVendor {
  /** The secret's name and the setting's value: `openai`. */
  readonly name: string;
  readonly label: string;
  /** The one host a call may go to. */
  readonly host: string;
  /** Where an owner makes a key. */
  readonly keyUrl: string;
  readonly defaultModel: string;
  /** Every size it makes; Kin picks the nearest to the one asked for. */
  readonly sizes: ReadonlyArray<PixelSize>;
  readonly generate: (
    key: PictureKey,
    request: {
      readonly model: string;
      readonly prompt: string;
      readonly size: PixelSize;
      readonly count: number;
    },
  ) => Effect.Effect<
    { readonly images: ReadonlyArray<GeneratedImage> },
    ImageVendorError,
    HttpClient.HttpClient
  >;
}
