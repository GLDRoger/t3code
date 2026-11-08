import * as NodeCrypto from "node:crypto";

import { p256 } from "@noble/curves/nist";
import { computeDpopJwkThumbprint } from "@t3tools/shared/dpop";
import { DpopPublicJwk } from "@t3tools/shared/dpopCommon";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { derEcdsaSignatureToCompact } from "./derSignature";
import { InvalidApprovalPublicKeyError, publicJwkFromNativePublicKey } from "./publicJwk";

const decodeJwk = Schema.decodeUnknownSync(DpopPublicJwk);

function nodeP256Key() {
  const { publicKey, privateKey } = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const spki = new Uint8Array(publicKey.export({ format: "der", type: "spki" }));
  return { publicKey, privateKey, spki, x963: spki.subarray(26) };
}

describe("publicJwkFromNativePublicKey", () => {
  it("builds the same JWK from Android's SPKI and iOS's X9.63 export", () => {
    const { publicKey, spki, x963 } = nodeP256Key();
    const expected = publicKey.export({ format: "jwk" });

    const fromSpki = publicJwkFromNativePublicKey(spki);
    const fromX963 = publicJwkFromNativePublicKey(x963);

    expect(fromSpki).toEqual({ kty: "EC", crv: "P-256", x: expected.x, y: expected.y });
    expect(fromX963).toEqual(fromSpki);
    expect(decodeJwk(fromSpki)).toEqual(fromSpki);
    expect(computeDpopJwkThumbprint(fromSpki)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("produces a JWK that verifies a converted signature the way the server will", () => {
    const { privateKey, spki } = nodeP256Key();
    const signingInput = "eyJ0eXAiOiJraW4tZ3JhbnQrandzIn0.eyJ2IjoxfQ";
    const bytes = new TextEncoder().encode(signingInput);
    const der = new Uint8Array(
      NodeCrypto.sign("sha256", bytes, { key: privateKey, dsaEncoding: "der" }),
    );

    const jwk = publicJwkFromNativePublicKey(spki);
    const point = Uint8Array.from([
      0x04,
      ...Result.getOrThrow(Base64Url.decode(jwk.x)),
      ...Result.getOrThrow(Base64Url.decode(jwk.y)),
    ]);
    const verified = p256.verify(
      derEcdsaSignatureToCompact(der),
      NodeCrypto.hash("sha256", bytes, "buffer"),
      point,
      { prehash: false, format: "compact" },
    );
    expect(verified).toBe(true);
  });

  it("rejects keys that are not uncompressed P-256 points", () => {
    const { spki, x963 } = nodeP256Key();
    const p384 = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-384" }).publicKey.export({
      format: "der",
      type: "spki",
    });
    const offCurve = Uint8Array.from(x963);
    offCurve[64] = (offCurve[64] ?? 0) ^ 1;
    const compressed = p256.ProjectivePoint.fromHex(x963).toRawBytes(true);
    const wrongPrefix = Uint8Array.from(spki);
    wrongPrefix[20] = 0x02;

    for (const key of [
      new Uint8Array(),
      compressed,
      Uint8Array.from([0x05, ...x963.subarray(1)]),
      offCurve,
      new Uint8Array(p384),
      wrongPrefix,
      Uint8Array.from([...spki, 0x00]),
    ]) {
      expect(() => publicJwkFromNativePublicKey(key)).toThrow(InvalidApprovalPublicKeyError);
    }
  });
});
