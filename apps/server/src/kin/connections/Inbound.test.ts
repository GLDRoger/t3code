import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";

import { inbound } from "./Inbound.ts";

it.effect("passes on a reply that carries no body, as a server ending a session sends", () =>
  Effect.gen(function* () {
    const http = inbound(yield* HttpClient.HttpClient, []);
    for (const status of [204, 205, 304])
      assert.strictEqual((yield* http.del("https://mcp.example.com/mcp")).status, status);
  }).pipe(
    Effect.provide(
      FetchHttpClient.layer.pipe(
        Layer.provide(
          Layer.succeed(
            FetchHttpClient.Fetch,
            Object.assign(
              (() => {
                const statuses = [204, 205, 304];
                return async () => new Response(null, { status: statuses.shift()! });
              })(),
              { preconnect() {} },
            ),
          ),
        ),
      ),
    ),
  ),
);
