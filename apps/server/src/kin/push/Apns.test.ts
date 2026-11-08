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

/** A local APNs over cleartext HTTP/2. Answers requests in order; "hang" never answers. */
const fakeApns = (answers: ReadonlyArray<Answer>) =>
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
        stream.respond({ ":status": answer.status });
        stream.end(answer.body === undefined ? undefined : JSON.stringify(answer.body));
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

it.effect("replaces a dead APNs connection and renews a refused provider token", () =>
  Effect.gen(function* () {
    const apns = yield* fakeApns([
      "hang",
      { status: 403, body: { reason: "ExpiredProviderToken" } },
      { status: 200 },
      { status: 200 },
      { status: 410, body: { reason: "Unregistered", timestamp: 1_794_000_000_000 } },
    ]);
    const credentials = {
      keyId: "ABC123DEFG",
      teamId: "TEAM123456",
      topic: "codes.kin.app",
      key: NodeCrypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey,
    };
    const transport = yield* makeApnsTransport(credentials, () => apns.origin);

    // The first connection takes the request and never answers.
    const stalled = yield* Effect.forkChild(transport.send(push));
    yield* Effect.promise(() => apns.hung);
    yield* TestClock.adjust("10 seconds");
    assert.deepStrictEqual(yield* Fiber.join(stalled), { status: 0, reason: "transport" });

    // The next push opens a new connection instead of waiting on the dead one.
    assert.deepStrictEqual(yield* transport.send(push), {
      status: 403,
      reason: "ExpiredProviderToken",
    });
    assert.deepStrictEqual(yield* transport.send(push), { status: 200, reason: undefined });
    yield* transport.send(push);
    assert.deepStrictEqual(yield* transport.send(push), {
      status: 410,
      reason: "Unregistered",
      timestamp: 1_794_000_000_000,
    });
    const [first, refused, renewed, cached] = apns.seen;
    assert.deepStrictEqual(
      apns.seen.map((request) => request.session),
      [0, 1, 1, 1, 1],
    );
    assert.strictEqual(refused?.authorization, first?.authorization);
    assert.notStrictEqual(renewed?.authorization, refused?.authorization);
    assert.strictEqual(cached?.authorization, renewed?.authorization);
  }).pipe(Effect.scoped),
);
