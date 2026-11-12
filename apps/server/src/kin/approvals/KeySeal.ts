// @effect-diagnostics nodeBuiltinImport:off -- synchronous HMAC-SHA256 and constant-time compares.
import * as NodeCrypto from "node:crypto";

import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";

const SECRET_NAME = "kin-approver-key-seal";
// Kept in the secret store, not SQLite, so a database write can't make the server adopt keys again.
const ADOPTED_MARKER = "kin-approver-key-seal-adopted";

/** What activating a key vouches for. A key whose row no longer matches its seal is refused. */
export type KinSealedKeyFields = {
  readonly orgId: string;
  readonly thumbprint: string;
  readonly publicJwkJson: string;
  readonly humanId: string;
  readonly hardware: string;
  /** The `since` bound for session revocations, so moving it can't hide a repaired revoke. */
  readonly createdAt: number;
};

/**
 * An HMAC the server writes when it activates an attested approver key. The key is a server
 * secret, so a row inserted or edited in SQLite never carries a valid seal.
 */
export class KinKeySeal extends Context.Service<
  KinKeySeal,
  {
    readonly seal: (key: KinSealedKeyFields) => string;
    readonly verify: (key: KinSealedKeyFields, seal: string | null) => boolean;
    /** Runs `adopt` on the first start after the seal shipped, and never again once it succeeds. */
    readonly adoptOnce: <E, R>(adopt: Effect.Effect<number, E, R>) => Effect.Effect<void, E, R>;
  }
>()("t3/kin/approvals/KeySeal/KinKeySeal") {}

const make = (
  secret: Uint8Array,
  marker: { readonly adopted: Effect.Effect<boolean>; readonly markAdopted: Effect.Effect<void> },
) => {
  const mac = (fields: Record<string, string | number | null>) =>
    NodeCrypto.createHmac("sha256", secret).update(stableStringify(fields)).digest("base64url");
  const keyFields = (key: KinSealedKeyFields) => ({
    orgId: key.orgId,
    thumbprint: key.thumbprint,
    publicJwkJson: key.publicJwkJson,
    humanId: key.humanId,
    hardware: key.hardware,
    createdAt: key.createdAt,
  });
  const seal = (key: KinSealedKeyFields) =>
    mac({ v: 1, use: "kin-approver-key", ...keyFields(key) });
  const same = (expected: string, stored: string) => {
    const left = Buffer.from(expected);
    const right = Buffer.from(stored);
    return left.length === right.length && NodeCrypto.timingSafeEqual(left, right);
  };
  return KinKeySeal.of({
    seal,
    verify: (key, stored) => stored !== null && same(seal(key), stored),
    adoptOnce: Effect.fn("KinKeySeal.adoptOnce")(function* <E, R>(
      adopt: Effect.Effect<number, E, R>,
    ) {
      if (yield* marker.adopted) return;
      const count = yield* adopt;
      yield* marker.markAdopted;
      yield* Effect.logInfo("Kin sealed the approver keys that were active before the seal.", {
        count,
      });
    }),
  });
};

/** Brings its own secret store; the server's is the same files, read through the same layer. */
export const layer = Layer.effect(
  KinKeySeal,
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const secret = yield* secrets.getOrCreateRandom(SECRET_NAME, 32);
    return make(secret, {
      adopted: secrets.get(ADOPTED_MARKER).pipe(Effect.map(Option.isSome), Effect.orDie),
      markAdopted: secrets.set(ADOPTED_MARKER, new Uint8Array([1])).pipe(Effect.orDie),
    });
  }),
).pipe(Layer.provide(ServerSecretStore.layer));

/** A fixed secret; `adopted: false` acts as the first start after an upgrade. */
export const layerTest = (options: { readonly adopted?: boolean } = {}) =>
  Layer.sync(KinKeySeal, () => {
    let adopted = options.adopted ?? true;
    return make(new Uint8Array(32).fill(7), {
      adopted: Effect.sync(() => adopted),
      markAdopted: Effect.sync(() => {
        adopted = true;
      }),
    });
  });
