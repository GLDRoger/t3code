import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";

import { guard, guardedLookup, urlRefusal } from "./EgressGuard.ts";

describe("EgressGuard", () => {
  it("refuses addresses that aren't public https", () => {
    for (const url of [
      "http://mcp.example.com/mcp",
      "https://127.0.0.1/mcp",
      "https://10.0.0.1/mcp",
      "https://100.100.100.100/mcp",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/mcp",
      "https://[fd00::1]/mcp",
      "https://localhost/mcp",
      "https://printer.local/mcp",
      "https://box.tailnet.ts.net/mcp",
      "https://intranet/mcp",
      "https://name:secret@mcp.example.com/mcp",
    ])
      assert.isDefined(urlRefusal(new URL(url)), url);
    assert.isUndefined(urlRefusal(new URL("https://mcp.example.com/mcp")));
    assert.isUndefined(urlRefusal(new URL("https://93.184.216.34/mcp")));
  });

  it("refuses a public name that resolves to a private address", async () => {
    const lookup = (addresses: ReadonlyArray<string>) =>
      guardedLookup((_host, _options, callback) =>
        callback(
          null,
          addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
        ),
      );
    const run = (addresses: ReadonlyArray<string>) =>
      new Promise<{ error: Error | null; address: unknown }>((resolve) =>
        lookup(addresses)("mcp.example.com", {}, (error, address) => resolve({ error, address })),
      );
    assert.strictEqual((await run(["93.184.216.34"])).address, "93.184.216.34");
    for (const rebound of [["10.0.0.5"], ["93.184.216.34", "127.0.0.1"], ["fd00::1"], []])
      assert.strictEqual((await run(rebound)).error?.name, "EgressRefused", rebound.join(","));
  });

  const seen: Array<string> = [];
  const fetch: typeof globalThis.fetch = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Request(input, init).url);
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: "https://169.254.169.254/latest/meta-data" },
        }),
      );
    },
    { preconnect() {} },
  );

  it.effect("never follows a redirect", () =>
    Effect.gen(function* () {
      const client = guard(yield* HttpClient.HttpClient);
      const error = yield* client.get("https://mcp.example.com/mcp").pipe(Effect.flip);
      assert.include(error.message, "redirect (302)");
      assert.deepStrictEqual(seen, ["https://mcp.example.com/mcp"]);
      const refused = yield* client.get("https://10.0.0.1/mcp").pipe(Effect.flip);
      assert.include(refused.message, "public internet addresses");
      assert.strictEqual(seen.length, 1);
    }).pipe(
      Effect.provide(
        FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
      ),
    ),
  );
});
