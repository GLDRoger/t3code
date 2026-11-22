import type * as Effect from "effect/Effect";
import type * as HttpClient from "effect/http/HttpClient";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

/**
 * Why a picture service gave no picture, by what it means for the count: whether the request
 * left at all, and whether the service settled it. Its own words are never kept.
 */
export class ImageVendorError extends Schema.TaggedError<ImageVendorError>()("ImageVendorError", {
  kind: Schema.Literals([
    /** It turned the prompt down, by its stable code: nothing was made. */
    "refused",
    /** The key is wrong, revoked, or may not use the model: nothing was made. */
    "key_rejected",
    /** Another refusal with a stable code (a 4xx such as a rate limit): nothing was made. */
    "declined",
    /** The request never left: nothing was made. */
    "not_sent",
    /** It left and no settled answer came back (a 5xx, a timeout, a broken body): it may be made. */
    "lost",
  ]),
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
