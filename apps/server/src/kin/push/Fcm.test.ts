// @effect-diagnostics nodeBuiltinImport:off -- a throwaway RSA key on disk, as a service-account file is.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import type { KinPushToken } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as TestClock from "effect/testing/TestClock";

import {
  FCM_SCOPE,
  FCM_TOKEN_URL,
  KinFcmTransport,
  layer,
  loadFcmCredentials,
  makeFcmTransport,
} from "./Fcm.ts";

const NOW = Date.parse("2026-11-08T00:00:00Z");
const token = "fcm-phone:APA91b-test_token-0123456789" as KinPushToken;

const keyFile = Effect.acquireRelease(
  Effect.sync(() => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kin-fcm-"));
    const pair = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const write = (name: string, value: unknown) => {
      const path = NodePath.join(dir, name);
      NodeFS.writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
      return path;
    };
    const account = {
      type: "service_account",
      project_id: "ambermill-kin",
      client_email: "kin-push@ambermill-kin.iam.gserviceaccount.example",
      private_key: pair.privateKey.export({ type: "pkcs8", format: "pem" }),
    };
    const ec = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    return {
      dir,
      good: write("service-account.json", account),
      notJson: write("not-json.json", "{"),
      notAccount: write("other.json", { type: "authorized_user", client_id: "x" }),
      ecKey: write("ec.json", {
        ...account,
        private_key: ec.privateKey.export({ type: "pkcs8", format: "pem" }),
      }),
      publicKey: pair.publicKey,
    };
  }),
  ({ dir }) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
);

const load = (env: Record<string, string>) =>
  Effect.result(loadFcmCredentials()).pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
  );

/** A fake Google: answers the token endpoint and FCM as told, and records every request. */
const fakeGoogle = (answer: (url: string, calls: number) => { status: number; body: unknown }) => {
  const requests: Array<{ url: string; authorization: string | undefined; body: string }> = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const body =
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
      requests.push({ url: request.url, authorization: request.headers.authorization, body });
      const calls = requests.filter((one) => one.url === request.url).length;
      const reply = answer(request.url, calls);
      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(reply.body), { status: reply.status }),
      );
    }),
  );
  return { requests, client };
};

const decodePart = (part: string): unknown => JSON.parse(Buffer.from(part, "base64url").toString());

it.effect("loads the service account only from its file, and never says what is in it", () =>
  Effect.gen(function* () {
    const file = yield* keyFile;
    const failures = [
      [{}, "no FCM service account is configured"],
      [{ KIN_FCM_SERVICE_ACCOUNT_FILE: NodePath.join(file.dir, "missing.json") }, "can't be read"],
      [{ KIN_FCM_SERVICE_ACCOUNT_FILE: file.notJson }, "isn't a service-account key"],
      [{ KIN_FCM_SERVICE_ACCOUNT_FILE: file.notAccount }, "isn't a service-account key"],
      [{ KIN_FCM_SERVICE_ACCOUNT_FILE: file.ecKey }, "isn't an RSA key"],
    ] as const;
    for (const [env, reason] of failures) {
      const result = yield* load(env);
      assert.isTrue(result._tag === "Failure" && result.failure.includes(reason), reason);
      if (result._tag === "Failure") assert.notInclude(result.failure, "PRIVATE KEY");
    }
    const loaded = yield* load({ KIN_FCM_SERVICE_ACCOUNT_FILE: file.good });
    assert.isTrue(loaded._tag === "Success" && loaded.success.projectId === "ambermill-kin");
    // Unset, the server starts as before: Android push is off, said once, and nothing is sent.
    const said: Array<unknown> = [];
    const off = yield* Effect.gen(function* () {
      const fcm = yield* KinFcmTransport;
      return { status: fcm.status, sent: yield* fcm.send({ token, data: {}, priority: "HIGH" }) };
    }).pipe(
      Effect.provide(layer),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
      Effect.provide(
        Logger.layer([Logger.make(({ message }) => said.push(message))], {
          mergeWithExisting: false,
        }),
      ),
    );
    assert.deepStrictEqual(off, {
      status: "unconfigured",
      sent: { status: 0, reason: "unconfigured" },
    });
    assert.deepStrictEqual(said.flat(), [
      "Kin push to Android is off: no FCM service account is configured.",
    ]);
  }),
);

it.effect("signs the token exchange, keeps the access token until near its end, and renews", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const file = yield* keyFile;
    const loaded = yield* load({ KIN_FCM_SERVICE_ACCOUNT_FILE: file.good });
    if (loaded._tag !== "Success") return assert.fail("no credentials");
    const send = `https://fcm.googleapis.com/v1/projects/ambermill-kin/messages:send`;
    let refuse = false;
    const google = fakeGoogle((url, calls) =>
      url === FCM_TOKEN_URL
        ? { status: 200, body: { access_token: `access-${calls}`, expires_in: 3600 } }
        : refuse
          ? ((refuse = false),
            { status: 401, body: { error: { status: "UNAUTHENTICATED", code: 401 } } })
          : { status: 200, body: { name: "projects/ambermill-kin/messages/1" } },
    );
    const fcm = yield* makeFcmTransport(loaded.success).pipe(
      Effect.provideService(HttpClient.HttpClient, google.client),
    );
    const push = {
      token,
      data: { title: "Finance · Update", message: "Hi" },
      priority: "HIGH",
    } as const;
    assert.deepStrictEqual(yield* fcm.send(push), { status: 200, reason: undefined });

    const [exchange, sent] = google.requests;
    assert.strictEqual(exchange?.url, FCM_TOKEN_URL);
    const form = new URLSearchParams(exchange?.body);
    assert.strictEqual(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [header, claims, signature] = (form.get("assertion") ?? "").split(".") as [
      string,
      string,
      string,
    ];
    assert.deepStrictEqual(decodePart(header), { alg: "RS256", typ: "JWT" });
    assert.deepStrictEqual(decodePart(claims), {
      iss: "kin-push@ambermill-kin.iam.gserviceaccount.example",
      scope: FCM_SCOPE,
      aud: FCM_TOKEN_URL,
      iat: NOW / 1000,
      exp: NOW / 1000 + 3600,
    });
    assert.isTrue(
      NodeCrypto.verify(
        "sha256",
        Buffer.from(`${header}.${claims}`),
        file.publicKey,
        Buffer.from(signature, "base64url"),
      ),
    );
    assert.strictEqual(sent?.url, send);
    assert.strictEqual(sent?.authorization, "Bearer access-1");
    assert.deepStrictEqual(JSON.parse(sent?.body ?? ""), {
      message: { token, data: push.data, android: { priority: "HIGH" } },
    });

    // Kept for the hour less five minutes, then exchanged again.
    yield* TestClock.adjust("54 minutes");
    yield* fcm.send(push);
    yield* TestClock.adjust("2 minutes");
    yield* fcm.send(push);
    const exchanges = () => google.requests.filter((one) => one.url === FCM_TOKEN_URL).length;
    assert.strictEqual(exchanges(), 2);
    assert.strictEqual(google.requests.at(-1)?.authorization, "Bearer access-2");

    // A token Google stopped taking is renewed once, and the push goes with the new one.
    refuse = true;
    assert.deepStrictEqual(yield* fcm.send(push), { status: 200, reason: undefined });
    assert.strictEqual(exchanges(), 3);
    assert.deepStrictEqual(
      google.requests.slice(-3).map((one) => [one.url, one.authorization]),
      [
        [send, "Bearer access-2"],
        [FCM_TOKEN_URL, undefined],
        [send, "Bearer access-3"],
      ],
    );
  }),
);

it.effect(
  "reads FCM's error code, retries Google's own trouble once, and says when it refuses",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const file = yield* keyFile;
      const loaded = yield* load({ KIN_FCM_SERVICE_ACCOUNT_FILE: file.good });
      if (loaded._tag !== "Success") return assert.fail("no credentials");
      const answers = [
        {
          status: 404,
          body: {
            error: {
              status: "NOT_FOUND",
              details: [
                {
                  "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError",
                  errorCode: "UNREGISTERED",
                },
              ],
            },
          },
        },
        { status: 503, body: { error: { status: "UNAVAILABLE" } } },
        { status: 503, body: { error: { status: "UNAVAILABLE" } } },
      ];
      const google = fakeGoogle((url) =>
        url === FCM_TOKEN_URL
          ? { status: 200, body: { access_token: "access", expires_in: 3600 } }
          : (answers.shift() ?? { status: 200, body: {} }),
      );
      const fcm = yield* makeFcmTransport(loaded.success).pipe(
        Effect.provideService(HttpClient.HttpClient, google.client),
      );
      const push = { token, data: { body: "{}" }, priority: "NORMAL" } as const;
      assert.deepStrictEqual(yield* fcm.send(push), { status: 404, reason: "UNREGISTERED" });
      assert.deepStrictEqual(yield* fcm.send(push), { status: 503, reason: "UNAVAILABLE" });
      assert.strictEqual(google.requests.filter((one) => one.url !== FCM_TOKEN_URL).length, 3);

      // A service account Google refuses sends nothing and asks Google again next time.
      const refused = fakeGoogle(() => ({ status: 400, body: { error: "invalid_grant" } }));
      const off = yield* makeFcmTransport(loaded.success).pipe(
        Effect.provideService(HttpClient.HttpClient, refused.client),
      );
      assert.deepStrictEqual(yield* off.send(push), { status: 0, reason: "auth" });
      assert.deepStrictEqual(yield* off.send(push), { status: 0, reason: "auth" });
      assert.deepStrictEqual(
        refused.requests.map((one) => one.url),
        [FCM_TOKEN_URL, FCM_TOKEN_URL],
      );
    }),
);
