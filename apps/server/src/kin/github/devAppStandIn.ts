// @effect-diagnostics nodeBuiltinImport:off globalDate:off - the fake gh's world file, lock and clock.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse, UrlParams } from "effect/http";

import { emptyWorld, FakeGitHub, type FakeWorld } from "./fakeGitHub.ts";
import { KinKeychain } from "./Keychain.ts";

/**
 * `KIN_DEV_FAKE_GITHUB` (dev and kin-verify only): Kin's App talks to the fake GitHub's world, the
 * one the stand-in `gh` uses, with an invented key, never the keychain or api.github.com.
 */
const Json = Schema.fromJsonString(Schema.Unknown);
const parse = Schema.decodeUnknownSync(Json);
const json = Schema.encodeSync(Json);

export const devAppStandIn = (directory: string) => {
  const state = `${directory}/state/github.json`;
  const lock = `${state}.lock`;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const withWorld = <A>(use: (github: FakeGitHub) => A): A => {
    for (let tries = 0; ; tries++) {
      try {
        NodeFS.mkdirSync(lock);
        break;
      } catch {
        if (tries > 1000) NodeFS.rmSync(lock, { recursive: true, force: true });
        Atomics.wait(pause, 0, 0, 5);
      }
    }
    try {
      const github = new FakeGitHub(
        NodeFS.existsSync(state)
          ? (parse(NodeFS.readFileSync(state, "utf8")) as FakeWorld)
          : emptyWorld("invented-owner", Date.now()),
      );
      github.world.now = Math.max(github.world.now, Date.now());
      const result = use(github);
      NodeFS.writeFileSync(state, json(github.world));
      return result;
    } finally {
      NodeFS.rmSync(lock, { recursive: true, force: true });
    }
  };
  const privateKeyPem = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  return Layer.mergeAll(
    Layer.succeed(KinKeychain, {
      appSecret: Effect.fn("KinKeychain.devAppSecret")(() =>
        Effect.succeedSome(Redacted.make(json({ privateKeyPem }))),
      ),
    }),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          const query = UrlParams.toString(request.urlParams);
          const url = new URL(`${request.url}${query === "" ? "" : `?${query}`}`);
          const headers = Object.fromEntries(
            Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), value]),
          );
          const body =
            request.body._tag === "Uint8Array"
              ? (parse(new TextDecoder().decode(request.body.body)) as Record<string, unknown>)
              : {};
          const answer = withWorld((github) =>
            github.handle(request.method, `${url.pathname}${url.search}`, headers, body),
          );
          return HttpClientResponse.fromWeb(
            request,
            new Response(answer.body === null ? null : json(answer.body), {
              status: answer.status,
              headers: answer.headers,
            }),
          );
        }),
      ),
    ),
  );
};
