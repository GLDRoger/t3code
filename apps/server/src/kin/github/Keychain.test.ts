import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { describe } from "vite-plus/test";

import * as Keychain from "./Keychain.ts";

const keychain = (platform: string, reachable: boolean) => {
  let probes = 0;
  const service = Keychain.make({
    platform,
    secretServiceReachable: Effect.sync(() => {
      probes++;
      return reachable;
    }),
  });
  return { service, probes: () => probes };
};

describe("KinKeychain", () => {
  it.effect("refuses every Linux operation when no Secret Service answers", () =>
    Effect.gen(function* () {
      const { service, probes } = keychain("linux", false);
      const failures = yield* Effect.all([
        service.ready("kin-github-app").pipe(Effect.flip),
        service.get("kin-owner-merge", "org").pipe(Effect.flip),
        service.set("kin-github-app", "1", Redacted.make("secret")).pipe(Effect.flip),
        service.remove("kin-owner-merge", "org").pipe(Effect.flip),
      ]);
      for (const failure of failures) {
        assert.deepInclude(failure, { _tag: "KinKeychainError", operation: "secret_service" });
        assert.include(failure.message, "org.freedesktop.secrets");
      }
      assert.strictEqual(probes(), 4);
    }),
  );

  it("stores values as base64 a keyring file can't reinterpret, and still reads raw ones", () => {
    const json = JSON.stringify({ privateKey: "-----BEGIN KEY-----\nabc\n-----END KEY-----\n" });
    const stored = Keychain.encodeSecret(json);
    assert.match(stored, /^kin-b64:[A-Za-z0-9+/=]+$/);
    assert.strictEqual(Keychain.decodeSecret(stored), json);
    assert.strictEqual(Keychain.decodeSecret(json), json);
  });

  it.effect("checks for a Secret Service only on Linux", () =>
    Effect.gen(function* () {
      const linux = keychain("linux", true);
      yield* linux.service.ready("kin-github-app");
      assert.strictEqual(linux.probes(), 1);

      const mac = keychain("darwin", false);
      yield* mac.service.ready("kin-github-app");
      assert.strictEqual(mac.probes(), 0);
    }),
  );
});
