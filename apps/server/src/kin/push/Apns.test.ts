// @effect-diagnostics nodeBuiltinImport:off -- a throwaway P-256 key on disk, as Apple's .p8 is.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import type { KinPushToken } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";

import { apnsProviderToken, apnsRequestHeaders, loadApnsCredentials } from "./Apns.ts";

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
  }).pipe(Effect.scoped),
);
