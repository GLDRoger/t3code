// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no generateKeyPairSync.
import * as NodeCrypto from "node:crypto";
import * as PlatformCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import { signRelayJwt, RELAY_HOOK_DELIVERY_TYP } from "@t3tools/shared/relayJwt";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { CLOUD_MINT_PUBLIC_KEY, RELAY_ISSUER_SECRET } from "../../cloud/config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as RelayDeliveryProof from "../../scheduledTasks/RelayDeliveryProof.ts";

it.effect(
  "verifies a relay-signed delivery using Kin's header names and returns receivedAt",
  () => {
    const keys = NodeCrypto.generateKeyPairSync("ed25519", {
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
      publicKeyEncoding: { format: "pem", type: "spki" },
    });
    const environmentId = EnvironmentId.make("env-contract");
    const issuer = "https://relay.example.test";
    const secrets = new Map([
      [CLOUD_MINT_PUBLIC_KEY, keys.publicKey],
      [RELAY_ISSUER_SECRET, issuer],
    ]);
    return Effect.gen(function* () {
      const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      const receivedAt = "1970-01-01T00:00:00.000Z";
      const proof = yield* signRelayJwt({
        privateKey: keys.privateKey,
        typ: RELAY_HOOK_DELIVERY_TYP,
        payload: {
          iss: issuer,
          aud: `t3-env:${environmentId}`,
          sub: environmentId,
          jti: "proof-contract",
          iat: now,
          exp: now + 3600,
          environmentId,
          deliveryId: "relay-contract",
          receivedAt,
          hookId: "kin-github",
        },
      });
      const verifier = yield* RelayDeliveryProof.RelayDeliveryProof;
      const headers = {
        "x-t3-relay-delivery": proof,
        "x-t3-relay-delivery-id": "relay-contract",
        "x-t3-relay-received-at": receivedAt,
      };
      assert.deepEqual(
        yield* verifier.verify({ hookId: "kin-github", headers }),
        Option.some({ deliveryId: "relay-contract", receivedAt }),
      );
      assert.deepEqual(
        yield* verifier.verify({
          hookId: "kin-github",
          headers: { ...headers, "x-t3-relay-received-at": "1970-01-01T00:01:00.000Z" },
        }),
        Option.none(),
      );
    }).pipe(
      Effect.provide(
        RelayDeliveryProof.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              Layer.mock(ServerSecretStore.ServerSecretStore)({
                get: (name) =>
                  Effect.succeed(
                    Option.map(Option.fromUndefinedOr(secrets.get(name)), (value) =>
                      new TextEncoder().encode(value),
                    ),
                  ),
              }),
              Layer.mock(ServerEnvironment.ServerEnvironment)({
                getEnvironmentId: Effect.succeed(environmentId),
              }),
              PlatformCrypto.layerSignature,
            ),
          ),
        ),
      ),
    );
  },
);
