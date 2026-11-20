import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import { ImageVendorError, type KinImageVendor } from "./ImageVendor.ts";

/**
 * OpenAI's Images API, read from its reference and image generation guide on 20 Nov 2026:
 * `POST /v1/images/generations`, a GPT image model, base64 images in `data[].b64_json`, and a
 * refused prompt as `error.code` `moderation_blocked`. The three sizes every GPT image model makes.
 */
const HOST = "api.openai.com";
const GENERATIONS = `https://${HOST}/v1/images/generations`;
/** Four images at the chat's 10 MiB image cap, as base64, with room for the JSON around them. */
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

const field = (value: unknown, ...path: ReadonlyArray<string>): unknown =>
  path.reduce<unknown>(
    (at, name) => (Predicate.hasProperty(at, name) ? at[name] : undefined),
    value,
  );
const text = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value : null);

const isVendorError = Schema.is(ImageVendorError);
const fail = (kind: ImageVendorError["kind"], reason: string | null = null) =>
  new ImageVendorError({ kind, reason });

/** The body as JSON, refused past the cap without reading the rest. */
const cappedJson = (stream: Stream.Stream<Uint8Array, unknown>, maxBytes: number) =>
  stream.pipe(
    Stream.runFoldEffect(
      () => ({ size: 0, chunks: [] as Array<Uint8Array> }),
      (acc, chunk) => {
        const size = acc.size + chunk.length;
        if (size > maxBytes) return Effect.fail(fail("unavailable"));
        acc.chunks.push(chunk);
        return Effect.succeed({ size, chunks: acc.chunks });
      },
    ),
    Effect.mapError((cause) => (isVendorError(cause) ? cause : fail("unavailable"))),
    Effect.map(({ size, chunks }) => {
      const body = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.length;
      }
      try {
        return JSON.parse(new TextDecoder().decode(body)) as unknown;
      } catch {
        return null;
      }
    }),
  );

const MIME: Record<string, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/** `maxResponseBytes` is lowered only by tests, which can't send 64 MiB. */
export const makeOpenAiImages = (maxResponseBytes = MAX_RESPONSE_BYTES): KinImageVendor => ({
  name: "openai",
  label: "OpenAI",
  host: HOST,
  keyUrl: "https://platform.openai.com/api-keys",
  defaultModel: "gpt-image-2.5-flare",
  sizes: [
    { width: 1024, height: 1024 },
    { width: 1536, height: 1024 },
    { width: 1024, height: 1536 },
  ],
  generate: Effect.fn("KinOpenAiImages.generate")(function* (key, request) {
    const http = yield* HttpClient.HttpClient;
    const response = yield* http
      .execute(
        HttpClientRequest.post(GENERATIONS).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.bearerToken(Redacted.value(key)),
          HttpClientRequest.bodyJsonUnsafe({
            model: request.model,
            prompt: request.prompt,
            n: request.count,
            size: `${request.size.width}x${request.size.height}`,
            output_format: "png",
          }),
        ),
      )
      .pipe(Effect.mapError(() => fail("unavailable")));
    const body = yield* cappedJson(response.stream, maxResponseBytes);
    const status = response.status;
    const said = text(field(body, "error", "message"))?.slice(0, 200) ?? null;
    if (status === 401 || status === 403) return yield* fail("key_rejected");
    if (status === 400 && field(body, "error", "code") === "moderation_blocked")
      return yield* fail("refused", said);
    if (status < 200 || status >= 300) return yield* fail("unavailable");
    const format = text(field(body, "output_format")) ?? "png";
    const data = field(body, "data");
    const images = (Array.isArray(data) ? data : []).flatMap((one) => {
      const b64 = text(field(one, "b64_json"));
      return b64 === null
        ? []
        : [{ bytes: new Uint8Array(Buffer.from(b64, "base64")), mimeType: MIME[format] ?? "" }];
    });
    if (images.length === 0) return yield* fail("unavailable");
    return { images: images.slice(0, request.count) };
  }),
});

export const openAiImages = makeOpenAiImages();
