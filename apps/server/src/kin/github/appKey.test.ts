import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { ServerConfig } from "../../config.ts";
import { appKeyName, make } from "./appKey.ts";
import { KinKeychain, KinKeychainError } from "./Keychain.ts";

const KEY = '{"privateKeyPem":"invented"}';
const text = (bytes: Option.Option<Uint8Array>) =>
  Option.map(bytes, (value) => new TextDecoder().decode(value));

/** The App key over a real secret store, with a keyring that answers as `keyring` says. */
const setup = (keyring: "item" | "empty" | "unreachable") =>
  Effect.gen(function* () {
    let keyringReads = 0;
    const store = yield* ServerSecretStore.ServerSecretStore;
    const key = yield* make.pipe(
      Effect.provideService(KinKeychain, {
        appSecret: () =>
          Effect.suspend(() => {
            keyringReads++;
            return keyring === "item"
              ? Effect.succeedSome(Redacted.make(KEY))
              : keyring === "empty"
                ? Effect.succeedNone
                : Effect.fail(
                    new KinKeychainError({ operation: "secret_service", cause: "no answer" }),
                  );
          }),
      }),
    );
    return { key, store, keyringReads: () => keyringReads };
  });

const layer = ServerSecretStore.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-github-app-key-" })),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);

describe("where Kin's GitHub App key is kept", () => {
  it.effect("in the secret store: read from there, the keyring never asked", () =>
    Effect.gen(function* () {
      const { key, store, keyringReads } = yield* setup("unreachable");
      yield* key.set("9100", Redacted.make(KEY));
      assert.deepStrictEqual(Option.map(yield* key.get("9100"), Redacted.value), Option.some(KEY));
      assert.strictEqual(keyringReads(), 0);
      yield* key.remove("9100");
      assert.isTrue(Option.isNone(yield* store.get(appKeyName("9100"))));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("only in an older host's keyring: read there once, copied into the store", () =>
    Effect.gen(function* () {
      const { key, store, keyringReads } = yield* setup("item");
      assert.deepStrictEqual(Option.map(yield* key.get("9001"), Redacted.value), Option.some(KEY));
      assert.deepStrictEqual(text(yield* store.get(appKeyName("9001"))), Option.some(KEY));
      assert.deepStrictEqual(Option.map(yield* key.get("9001"), Redacted.value), Option.some(KEY));
      assert.strictEqual(keyringReads(), 1);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("in neither, or no keyring at all: no key, and nothing stored", () =>
    Effect.gen(function* () {
      for (const keyring of ["empty", "unreachable"] as const) {
        const { key, store } = yield* setup(keyring);
        assert.isTrue(Option.isNone(yield* key.get("9002")));
        assert.isTrue(Option.isNone(yield* store.get(appKeyName("9002"))));
      }
    }).pipe(Effect.provide(layer)),
  );
});
