import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";

import { guard } from "../connections/EgressGuard.ts";
import { FAKE_PNG } from "./FakeImageVendor.ts";
import { makeOpenAiImages } from "./OpenAiImages.ts";

// An invented key, and a local stand-in for the vendor: no request leaves the process.
const KEY = Redacted.make("sk-invented-ambermill-0000");
const b64 = Buffer.from(FAKE_PNG).toString("base64");

const served = (answer: (request: Request) => Response) => {
  const seen: Array<{ url: string; method: string; auth: string | null; body: unknown }> = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const text = await request.text();
    seen.push({
      url: request.url,
      method: request.method,
      auth: request.headers.get("authorization"),
      body: text === "" ? null : JSON.parse(text),
    });
    return answer(request);
  };
  // The guard the server puts beneath every vendor: https, public names, no redirects.
  const http = Layer.effect(HttpClient.HttpClient, Effect.map(HttpClient.HttpClient, guard)).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch as typeof globalThis.fetch)),
  );
  return { seen, http };
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ask = (maxBytes?: number) =>
  makeOpenAiImages(maxBytes).generate(KEY, {
    model: "gpt-image-2.5-flare",
    prompt: "A loaf of sourdough on a bakery counter at dawn",
    size: { width: 1024, height: 1536 },
    count: 2,
  });

describe("OpenAI's Images API", () => {
  it.effect("asks the one vendor host for base64 PNGs and keeps only as many as asked for", () => {
    const { seen, http } = served(() =>
      json(200, {
        output_format: "png",
        data: [{ b64_json: b64 }, { b64_json: b64 }, { b64_json: b64 }],
      }),
    );
    return Effect.gen(function* () {
      const made = yield* ask();
      assert.deepStrictEqual(
        made.images.map((image) => [image.mimeType, image.bytes.byteLength]),
        [
          ["image/png", FAKE_PNG.byteLength],
          ["image/png", FAKE_PNG.byteLength],
        ],
      );
      assert.deepStrictEqual(seen, [
        {
          url: "https://api.openai.com/v1/images/generations",
          method: "POST",
          auth: "Bearer sk-invented-ambermill-0000",
          body: {
            model: "gpt-image-2.5-flare",
            prompt: "A loaf of sourdough on a bakery counter at dawn",
            n: 2,
            size: "1024x1536",
            output_format: "png",
          },
        },
      ]);
    }).pipe(Effect.provide(http));
  });

  it.effect.each([
    [
      401,
      { error: { message: "Incorrect API key provided: sk-inv***0000." } },
      "key_rejected",
      null,
    ],
    [403, { error: { message: "Your organization must be verified." } }, "key_rejected", null],
    [
      400,
      {
        error: {
          code: "moderation_blocked",
          message: "Your request was rejected by the safety system.",
        },
      },
      "refused",
      "Your request was rejected by the safety system.",
    ],
    [400, { error: { code: "invalid_value", message: "Invalid size." } }, "unavailable", null],
    [429, { error: { message: "Rate limit reached." } }, "unavailable", null],
    [500, { error: { message: "The server had an error." } }, "unavailable", null],
    [200, { data: [] }, "unavailable", null],
  ] as const)("answers HTTP %i as a %s", ([status, body, kind, reason]) => {
    const { seen, http } = served(() => json(status, body));
    return Effect.gen(function* () {
      const error = yield* ask().pipe(Effect.flip);
      assert.deepInclude(error, { kind, reason });
      assert.strictEqual(seen.length, 1);
    }).pipe(Effect.provide(http));
  });

  it.effect("follows no redirect and reads no answer past its cap", () =>
    Effect.gen(function* () {
      const moved = served(
        () => new Response(null, { status: 302, headers: { location: "https://elsewhere.test/" } }),
      );
      assert.deepInclude(yield* ask().pipe(Effect.flip, Effect.provide(moved.http)), {
        kind: "unavailable",
      });
      assert.deepStrictEqual(
        moved.seen.map((one) => one.url),
        ["https://api.openai.com/v1/images/generations"],
      );
      const big = served(() => json(200, { data: [{ b64_json: b64.repeat(100) }] }));
      assert.deepInclude(yield* ask(1024).pipe(Effect.flip, Effect.provide(big.http)), {
        kind: "unavailable",
      });
    }),
  );
});
