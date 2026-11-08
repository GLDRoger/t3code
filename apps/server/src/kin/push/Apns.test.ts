// @effect-diagnostics nodeBuiltinImport:off -- a throwaway P-256 key on disk, as Apple's .p8 is, and a local HTTP/2 APNs.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp2 from "node:http2";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import type { KinPushToken } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import {
  apnsProviderToken,
  apnsRequestHeaders,
  loadApnsCredentials,
  makeApnsTransport,
} from "./Apns.ts";

const keyFile = Effect.acquireRelease(
  Effect.sync(() => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kin-apns-"));
    const pair = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const ec = NodePath.join(dir, "AuthKey_TEST.p8");
    NodeFS.writeFileSync(ec, pair.privateKey.export({ type: "pkcs8", format: "pem" }));
    const rsa = NodePath.join(dir, "rsa.pem");
    NodeFS.writeFileSync(
      rsa,
      NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
        type: "pkcs8",
        format: "pem",
      }),
    );
    return { dir, ec, rsa, publicKey: pair.publicKey };
  }),
  ({ dir }) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
);

const load = (env: Record<string, string>) =>
  Effect.result(loadApnsCredentials()).pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
  );

it.effect("loads the .p8 only when fully configured, and signs a token APNs can verify", () =>
  Effect.gen(function* () {
    const file = yield* keyFile;
    const full = {
      KIN_APNS_KEY_FILE: file.ec,
      KIN_APNS_KEY_ID: "ABC123DEFG",
      KIN_APNS_TEAM_ID: "TEAM123456",
      KIN_APNS_TOPIC: "codes.kin.app",
    };
    const failures = [
      [{}, "no APNs key is configured"],
      [{ KIN_APNS_KEY_ID: "ABC123DEFG" }, "set all of"],
      [{ ...full, KIN_APNS_KEY_FILE: NodePath.join(file.dir, "missing.p8") }, "isn't a readable"],
      [{ ...full, KIN_APNS_KEY_FILE: file.rsa }, "isn't an APNs (P-256) key"],
    ] as const;
    for (const [env, reason] of failures) {
      const result = yield* load(env);
      assert.isTrue(result._tag === "Failure" && result.failure.includes(reason), reason);
    }

    const loaded = yield* load(full);
    assert.strictEqual(loaded._tag, "Success");
    if (loaded._tag !== "Success") return;
    const jwt = apnsProviderToken(loaded.success, Date.parse("2026-11-08T00:00:00Z"));
    const [header, claims, signature] = jwt.split(".") as [string, string, string];
    assert.deepStrictEqual(JSON.parse(Buffer.from(header, "base64url").toString()), {
      alg: "ES256",
      kid: "ABC123DEFG",
    });
    assert.deepStrictEqual(JSON.parse(Buffer.from(claims, "base64url").toString()), {
      iss: "TEAM123456",
      iat: 1_794_096_000,
    });
    assert.isTrue(
      NodeCrypto.verify(
        "sha256",
        Buffer.from(`${header}.${claims}`),
        { key: file.publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(signature, "base64url"),
      ),
    );
    const token = "a".repeat(64) as KinPushToken;
    assert.deepStrictEqual(
      apnsRequestHeaders(loaded.success, { token, environment: "development", payload: {} }, jwt),
      {
        ":method": "POST",
        ":path": `/3/device/${token}`,
        authorization: `bearer ${jwt}`,
        "apns-topic": "codes.kin.app",
        "apns-push-type": "alert",
        "apns-priority": "10",
        "content-type": "application/json",
      },
    );
    assert.include(
      apnsRequestHeaders(
        loaded.success,
        { token, environment: "development", payload: {}, collapseId: "kin:abc" },
        jwt,
      ),
      { "apns-collapse-id": "kin:abc" },
    );
  }).pipe(Effect.scoped),
);

type Answer = { readonly status: number; readonly body?: object } | "hang";

/**
 * A local APNs over cleartext HTTP/2. Answers requests in order; "hang" never answers.
 * With `hold`, requests from index `from` are answered only once `until` have arrived.
 */
const fakeApns = (
  answers: ReadonlyArray<Answer>,
  hold: { readonly from: number; readonly until: number } = { from: 0, until: 0 },
) =>
  Effect.acquireRelease(
    Effect.callback<{
      readonly origin: string;
      readonly seen: Array<{ readonly session: number; readonly authorization: string }>;
      readonly hung: Promise<void>;
      readonly server: NodeHttp2.Http2Server;
    }>((resume) => {
      const server = NodeHttp2.createServer();
      const seen: Array<{ session: number; authorization: string }> = [];
      const sessions: Array<NodeHttp2.ServerHttp2Session> = [];
      const held: Array<() => void> = [];
      let markHung = () => {};
      const hung = new Promise<void>((resolve) => (markHung = resolve));
      server.on("session", (session) => sessions.push(session));
      server.on("stream", (stream, headers) => {
        seen.push({
          session: sessions.indexOf(stream.session as NodeHttp2.ServerHttp2Session),
          authorization: String(headers.authorization),
        });
        const answer = answers[seen.length - 1] ?? { status: 200 };
        if (answer === "hang") return markHung();
        const reply = () => {
          stream.respond({ ":status": answer.status });
          stream.end(answer.body === undefined ? undefined : JSON.stringify(answer.body));
        };
        if (seen.length - 1 < hold.from) return reply();
        held.push(reply);
        if (seen.length >= hold.until) held.splice(0).forEach((send) => send());
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        resume(Effect.succeed({ origin: `http://127.0.0.1:${port}`, seen, hung, server }));
      });
    }),
    ({ server }) => Effect.sync(() => server.close()),
  );

const push = {
  token: "a".repeat(64) as KinPushToken,
  environment: "production",
  payload: {},
} as const;

const credentials = {
  keyId: "ABC123DEFG",
  teamId: "TEAM123456",
  topic: "codes.kin.app",
  key: NodeCrypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey,
};

it.effect("retries once on a new connection after no answer or a 5xx, never after a 429", () =>
  Effect.gen(function* () {
    const apns = yield* fakeApns([
      "hang",
      { status: 200 },
      { status: 500 },
      { status: 200 },
      { status: 503 },
      { status: 503 },
      { status: 429, body: { reason: "TooManyRequests" } },
      { status: 200 },
    ]);
    const transport = yield* makeApnsTransport(credentials, () => apns.origin);

    // The first connection takes the request and never answers; the retry opens a new one.
    const stalled = yield* Effect.forkChild(transport.send(push));
    yield* Effect.promise(() => apns.hung);
    yield* TestClock.adjust("10 seconds");
    assert.deepStrictEqual(yield* Fiber.join(stalled), { status: 200, reason: undefined });
    assert.deepStrictEqual(yield* transport.send(push), { status: 200, reason: undefined });
    // Only one retry: a second 503 is the answer.
    assert.deepStrictEqual(yield* transport.send(push), { status: 503, reason: undefined });
    assert.deepStrictEqual(yield* transport.send(push), {
      status: 429,
      reason: "TooManyRequests",
    });
    // A connection that answered 5xx is dropped too, and one idle five minutes is replaced.
    yield* TestClock.adjust("5 minutes");
    yield* transport.send(push);
    assert.deepStrictEqual(
      apns.seen.map((request) => request.session),
      [0, 1, 1, 2, 2, 3, 4, 5],
    );
  }).pipe(Effect.scoped),
);

it.effect("renews an expired provider token at most every 20 minutes and keeps a refused one", () =>
  Effect.gen(function* () {
    const apns = yield* fakeApns([
      { status: 403, body: { reason: "ExpiredProviderToken" } },
      { status: 403, body: { reason: "ExpiredProviderToken" } },
      { status: 200 },
      { status: 403, body: { reason: "InvalidProviderToken" } },
      { status: 200 },
      { status: 410, body: { reason: "Unregistered", timestamp: 1_794_000_000_000 } },
    ]);
    const transport = yield* makeApnsTransport(credentials, () => apns.origin);

    // A token APNs calls expired right after signing isn't renewed: that would be throttled.
    assert.deepStrictEqual(yield* transport.send(push), {
      status: 403,
      reason: "ExpiredProviderToken",
    });
    // Twenty minutes in, it is renewed and the push retried with the new one.
    yield* TestClock.adjust("20 minutes");
    assert.deepStrictEqual(yield* transport.send(push), { status: 200, reason: undefined });
    // A refused token is a configuration problem; signing again on every push won't fix it.
    assert.deepStrictEqual(yield* transport.send(push), {
      status: 403,
      reason: "InvalidProviderToken",
    });
    yield* transport.send(push);
    assert.deepStrictEqual(yield* transport.send(push), {
      status: 410,
      reason: "Unregistered",
      timestamp: 1_794_000_000_000,
    });
    const [first, expired, renewed, refused, kept] = apns.seen.map(
      (request) => request.authorization,
    );
    assert.strictEqual(expired, first);
    assert.notStrictEqual(renewed, expired);
    assert.strictEqual(refused, renewed);
    assert.strictEqual(kept, renewed);
  }).pipe(Effect.scoped),
);

it.effect("two sends that hit an expired token together renew it once", () =>
  Effect.gen(function* () {
    const expired = { status: 403, body: { reason: "ExpiredProviderToken" } } as const;
    const apns = yield* fakeApns([{ status: 200 }, expired, expired], { from: 1, until: 3 });
    const transport = yield* makeApnsTransport(credentials, () => apns.origin);
    yield* transport.send(push);
    yield* TestClock.adjust("20 minutes");
    // Both hold the old token when APNs calls it expired; only one may sign a new one.
    const both = yield* Effect.all([transport.send(push), transport.send(push)], {
      concurrency: 2,
    });
    assert.deepStrictEqual(both, [
      { status: 200, reason: undefined },
      { status: 200, reason: undefined },
    ]);
    const tokens = new Set(apns.seen.slice(1).map((request) => request.authorization));
    assert.strictEqual(apns.seen.length, 5);
    assert.strictEqual(tokens.size, 2);
  }).pipe(Effect.scoped),
);
