// @effect-diagnostics nodeBuiltinImport:off - an invented RSA key for the App's JWT.
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse, UrlParams } from "effect/http";

import type { FakeApp, FakeGitHub } from "./fakeGitHub.ts";
import { KinGitHubAppKey } from "./appKey.ts";
import { KinGitHubAppConfig } from "./KinGitHubApp.ts";

export const BOT_LOGIN = "invented-kin[bot]";
export const BOT_EMAIL = "41+invented-kin[bot]@users.noreply.github.com";

const privateKeyPem = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

const Json = Schema.fromJsonString(Schema.Unknown);
const parse = Schema.decodeUnknownSync(Json);
const json = Schema.encodeSync(Json);

/** The invented App key as the secret store keeps it. */
export const appKeyJson = () => json({ privateKeyPem });

/** Kin's GitHub App, installed where `installations` say, in the fake GitHub's world. */
export const installApp = (github: FakeGitHub, installations: FakeApp["installations"]) => {
  github.world.app = {
    id: 9001,
    slug: "invented-kin",
    name: "Invented Kin",
    botId: 41,
    installations,
    minted: [],
  };
};

/** GitHub's REST API over the fake, as the App's HTTP client reaches it. */
export const fakeHttp = (github: FakeGitHub) =>
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
        const answer = github.handle(request.method, `${url.pathname}${url.search}`, headers, body);
        return HttpClientResponse.fromWeb(
          request,
          new Response(answer.body === null ? null : json(answer.body), {
            status: answer.status,
            headers: answer.headers,
          }),
        );
      }),
    ),
  );

/** The App's key, or none, and the env lines that name the App. */
export const appHost = (options: { readonly appId?: string; readonly key?: boolean }) =>
  Layer.mergeAll(
    Layer.succeed(KinGitHubAppKey, {
      get: () =>
        Effect.succeed(
          options.key === false
            ? Option.none()
            : Option.some(Redacted.make(json({ privateKeyPem }))),
        ),
      set: () => Effect.void,
      remove: () => Effect.void,
    }),
    Layer.succeed(KinGitHubAppConfig, {
      appId: Option.fromNullishOr(options.appId),
      botLogin: Option.none(),
    }),
  );
