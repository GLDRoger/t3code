// @effect-diagnostics nodeBuiltinImport:off -- random challenges for fixtures.
import * as NodeCrypto from "node:crypto";

import { assert, describe, it } from "@effect/vitest";

import {
  androidChain,
  appleAttestation,
  makeTrustFixture,
  newKey,
  type AndroidChainSpec,
  type AppleSpec,
} from "./testFixtures.ts";
import { verifyAndroidKeyAttestation, verifyAppleAppAttest } from "./verify.ts";

const NOW = Date.parse("2026-11-08T00:00:00Z");
const challenge = new Uint8Array(NodeCrypto.randomBytes(32));

describe("Android key attestation", () => {
  const fixture = makeTrustFixture();
  const verify = (spec: Partial<AndroidChainSpec> = {}, trust = fixture.trust) => {
    const chain = androidChain(fixture, { challenge, ...spec });
    return verifyAndroidKeyAttestation({
      certificateChain: chain.certificateChain,
      challenge,
      publicJwk: chain.publicJwk,
      trust,
      now: NOW,
    });
  };

  it("accepts a StrongBox key and reads the hardware from the attestation", () => {
    assert.deepStrictEqual(verify(), { attested: true, hardware: "strongbox" });
    assert.deepStrictEqual(verify({ attestationLevel: 1, keyMintLevel: 1 }), {
      attested: true,
      hardware: "tee",
    });
  });

  const rejections: ReadonlyArray<readonly [string, Partial<AndroidChainSpec>, string]> = [
    ["another root", { root: newKey() }, "Google hardware attestation root"],
    ["a forged leaf", { leafSignedByStranger: true }, "isn't signed by the next one"],
    ["an expired leaf", { leafNotAfter: "260101000000Z" }, "outside its validity"],
    ["another challenge", { challenge: new Uint8Array(32) }, "challenge mismatch"],
    ["a software key", { attestationLevel: 0 }, "secure hardware"],
    ["software KeyMint", { keyMintLevel: 0 }, "secure hardware"],
    ["an encrypting key", { purposes: [0, 2] }, "SIGN only"],
    ["an RSA key", { algorithm: 1 }, "algorithm"],
    ["another curve", { ecCurve: 2 }, "P-256"],
    ["a SHA-1 digest", { digests: [2] }, "SHA-256"],
    ["a PIN-gated key", { userAuthType: 1 }, "biometric only"],
    ["an auth timeout", { authTimeout: 30 }, "auth timeout"],
    ["no auth required", { noAuthRequiredInSoftware: true }, "needs no auth"],
    ["an imported key", { origin: 2 }, "generated in hardware"],
    ["an unlocked bootloader", { deviceLocked: false }, "unlocked"],
    ["unverified boot", { bootState: 2 }, "Verified"],
    ["another app", { packages: ["com.evil.app"] }, "package"],
    ["two apps", { packages: ["com.gldroger.kin", "com.evil.app"] }, "more than one package"],
    ["another signer", { signers: ["cd".repeat(32)] }, "signing certificate"],
    ["a key description above the leaf", { descriptionInIntermediate: true }, "outside the leaf"],
  ];
  it.each(rejections)("refuses %s", (_name, spec, reason) => {
    const result = verify(spec);
    assert.isFalse(result.attested);
    assert.include(result.attested ? "" : result.reason, reason);
  });

  it("refuses a chain with a revoked certificate", () => {
    const serial = new Uint8Array([0x0f, 0x1e, 0x2d]);
    const result = verify(
      { leafSerial: serial },
      { ...fixture.trust, androidRevokedSerials: new Set(["f1e2d"]) },
    );
    assert.deepStrictEqual(result, {
      attested: false,
      reason: "a certificate in the chain is revoked",
    });
  });

  it("refuses a chain for another key and malformed input", () => {
    const chain = androidChain(fixture, { challenge });
    const other = androidChain(fixture, { challenge });
    const base = { challenge, trust: fixture.trust, now: NOW };
    const swapped = verifyAndroidKeyAttestation({
      ...base,
      certificateChain: chain.certificateChain,
      publicJwk: other.publicJwk,
    });
    assert.deepStrictEqual(swapped, {
      attested: false,
      reason: "attested key isn't the registered key",
    });
    const garbage = verifyAndroidKeyAttestation({
      ...base,
      certificateChain: ["bm90IGEgY2VydA==", chain.certificateChain[1]!],
      publicJwk: chain.publicJwk,
    });
    assert.isFalse(garbage.attested);
    const short = verifyAndroidKeyAttestation({
      ...base,
      certificateChain: chain.certificateChain.slice(0, 1),
      publicJwk: chain.publicJwk,
    });
    assert.deepStrictEqual(short, { attested: false, reason: "attestation chain is too short" });
  });
});

describe("Apple App Attest", () => {
  const fixture = makeTrustFixture();
  const verify = (spec: Partial<AppleSpec> = {}, trust = fixture.trust) => {
    const attestation = appleAttestation(fixture, { challenge, ...spec });
    return verifyAppleAppAttest({
      keyId: attestation.keyId,
      attestationObject: attestation.attestationObject,
      challenge,
      publicJwk: attestation.publicJwk,
      trust,
      now: NOW,
    });
  };

  it("accepts an attestation over the challenge and the new key", () => {
    assert.deepStrictEqual(verify(), { attested: true, hardware: "secure_enclave" });
    assert.deepStrictEqual(
      verify(
        { aaguid: "appattestdevelop" },
        { ...fixture.trust, appleEnvironments: ["development"] },
      ),
      { attested: true, hardware: "secure_enclave" },
    );
  });

  const rejections: ReadonlyArray<readonly [string, Partial<AppleSpec>, string]> = [
    ["another root", { root: newKey() }, "Apple App Attest root"],
    ["another challenge", { challenge: new Uint8Array(32) }, "nonce"],
    ["a nonce over another approval key", { boundKey: newKey() }, "nonce"],
    ["another app", { appId: "TEAM999999.com.evil" }, "allowlist"],
    ["a used App Attest key", { counter: 1 }, "counter"],
    ["a development build", { aaguid: "appattestdevelop" }, "environment"],
    ["a keyId for another key", { wrongKeyId: true }, "keyId"],
  ];
  it.each(rejections)("refuses %s", (_name, spec, reason) => {
    const result = verify(spec);
    assert.isFalse(result.attested);
    assert.include(result.attested ? "" : result.reason, reason);
  });
});
