import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/http";

import { CloudLink } from "../cloud/CloudLink.ts";
import { publicAddress } from "./publicAddress.ts";

const linked = {
  linked: true,
  cloudUserId: "invented-user",
  relayUrl: "wss://relay.example.test",
  relayIssuer: null,
  publishAgentActivity: false,
  tunnelHostname: "ambermill.tunnel.example.test",
};
const tunnel = "https://ambermill.tunnel.example.test";

it.effect("names KIN_PUBLIC_URL first, then a live tunnel, else nothing", () =>
  Effect.gen(function* () {
    const cases = [
      [
        "https://kin.ambermill.example.test/ignored/path",
        linked,
        "https://kin.ambermill.example.test",
      ],
      // Bad or local-only values are ignored, and the tunnel still answers.
      ["not a url", linked, tunnel],
      ["http://kin.ambermill.example.test", linked, tunnel],
      ["https://localhost:3773", linked, tunnel],
      ["https://127.0.0.1:3773", linked, tunnel],
      // A LAN or tailnet origin reaches teammates on that network, so it counts.
      ["https://192.168.1.20", { ...linked, linked: false }, "https://192.168.1.20"],
      ["", linked, tunnel],
      [undefined, linked, tunnel],
      [undefined, { ...linked, linkRevoked: true }, undefined],
      [undefined, { ...linked, linked: false }, undefined],
      [undefined, { ...linked, tunnelHostname: undefined }, undefined],
      [undefined, { ...linked, tunnelHostname: "localhost" }, undefined],
      ["https://kin.localhost", { ...linked, linked: false }, undefined],
    ] as const;
    for (const [value, state, expected] of cases) {
      const env = ConfigProvider.layer(
        ConfigProvider.fromUnknown(value === undefined ? {} : { KIN_PUBLIC_URL: value }),
      );
      const cloud = Layer.mock(CloudLink)({ linkState: () => Effect.succeed(state) });
      assert.strictEqual(
        yield* publicAddress().pipe(Effect.provide(Layer.merge(env, cloud))),
        expected,
        `${value} with ${JSON.stringify(state)}`,
      );
    }
    // No T3 Connect at all: only the setting can name one.
    assert.isUndefined(
      yield* publicAddress().pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
      ),
    );
  }),
);

it.effect("a request's headers never change the address", () =>
  Effect.gen(function* () {
    const request = HttpServerRequest.fromWeb(
      new Request("https://attacker.example.test/ws", {
        headers: {
          host: "attacker.example.test",
          origin: "https://attacker.example.test",
          "x-forwarded-host": "attacker.example.test",
          "x-forwarded-proto": "https",
        },
      }),
    );
    const cloud = Layer.mock(CloudLink)({ linkState: () => Effect.succeed(linked) });
    const env = ConfigProvider.layer(ConfigProvider.fromUnknown({}));
    const seen = yield* publicAddress().pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, request),
      Effect.provide(Layer.merge(env, cloud)),
    );
    assert.strictEqual(seen, tunnel);
    const none = yield* publicAddress().pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, request),
      Effect.provide(env),
    );
    assert.isUndefined(none);
  }),
);
