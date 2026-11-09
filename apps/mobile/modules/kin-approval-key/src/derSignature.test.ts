import * as NodeCrypto from "node:crypto";

import { p256 } from "@noble/curves/nist";
import { describe, expect, it } from "vite-plus/test";

import { derEcdsaSignatureToCompact, MalformedDerSignatureError } from "./derSignature";

const N = p256.CURVE.n;
const message = new TextEncoder().encode("eyJhbGciOiJFUzI1NiJ9.eyJ2IjoxfQ");

function bytesToBigInt(bytes: Uint8Array) {
  return BigInt(`0x${Buffer.from(bytes).toString("hex") || "0"}`);
}

function bigIntTo32(value: bigint) {
  return Uint8Array.from(Buffer.from(value.toString(16).padStart(64, "0"), "hex"));
}

function derInteger(value: bigint) {
  const digits = value.toString(16);
  const magnitude = Buffer.from(digits.length % 2 ? `0${digits}` : digits, "hex");
  const bytes = (magnitude[0] ?? 0) & 0x80 ? [0, ...magnitude] : [...magnitude];
  return Uint8Array.from([0x02, bytes.length, ...bytes]);
}

function derSignature(r: bigint, s: bigint) {
  const body = [...derInteger(r), ...derInteger(s)];
  return Uint8Array.from([0x30, body.length, ...body]);
}

function nodeKeyPair() {
  return NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
}

function rawPublicKey(publicKey: NodeCrypto.KeyObject) {
  return new Uint8Array(publicKey.export({ format: "der", type: "spki" }).subarray(26));
}

function verifiesEverywhere(publicKey: NodeCrypto.KeyObject, compact: Uint8Array) {
  const node = NodeCrypto.verify(
    "sha256",
    message,
    { key: publicKey, dsaEncoding: "ieee-p1363" },
    compact,
  );
  const noble = p256.verify(
    compact,
    NodeCrypto.hash("sha256", message, "buffer"),
    rawPublicKey(publicKey),
    // The server's settings (approvals spec, section 5): high-S signatures are refused.
    { prehash: false, format: "compact", lowS: true },
  );
  return { node, noble };
}

describe("derEcdsaSignatureToCompact", () => {
  it("converts node:crypto DER signatures to compact signatures both verifiers accept", () => {
    const { publicKey, privateKey } = nodeKeyPair();
    for (let i = 0; i < 64; i++) {
      const der = new Uint8Array(
        NodeCrypto.sign("sha256", message, { key: privateKey, dsaEncoding: "der" }),
      );
      const compact = derEcdsaSignatureToCompact(der);
      expect(compact).toHaveLength(64);
      expect(verifiesEverywhere(publicKey, compact)).toEqual({ node: true, noble: true });
    }
  });

  it("normalises s to the low half of the order, so a grant has one signature", () => {
    const { publicKey, privateKey } = nodeKeyPair();
    for (let i = 0; i < 16; i++) {
      const compact = derEcdsaSignatureToCompact(
        new Uint8Array(NodeCrypto.sign("sha256", message, { key: privateKey, dsaEncoding: "der" })),
      );
      const r = bytesToBigInt(compact.subarray(0, 32));
      const s = bytesToBigInt(compact.subarray(32));
      expect(s <= N >> 1n).toBe(true);
      const fromHighS = derEcdsaSignatureToCompact(derSignature(r, N - s));
      expect(Buffer.from(fromHighS)).toEqual(Buffer.from(compact));
      expect(verifiesEverywhere(publicKey, fromHighS)).toEqual({ node: true, noble: true });
    }
    const half = N >> 1n;
    expect(bytesToBigInt(derEcdsaSignatureToCompact(derSignature(1n, half)).subarray(32))).toBe(
      half,
    );
    expect(
      bytesToBigInt(derEcdsaSignatureToCompact(derSignature(1n, half + 1n)).subarray(32)),
    ).toBe(N - half - 1n);
  });

  it("left-pads short scalars and strips the sign byte from high-bit scalars", () => {
    const { publicKey, privateKey } = nodeKeyPair();
    const der = new Uint8Array(
      NodeCrypto.sign("sha256", message, { key: privateKey, dsaEncoding: "der" }),
    );
    const compact = derEcdsaSignatureToCompact(der);
    const r = bytesToBigInt(compact.subarray(0, 32));
    const s = bytesToBigInt(compact.subarray(32));

    // (r, n - s) is the other valid signature for the same message. One of s and n - s has its
    // high bit set, so this always exercises the 33-byte INTEGER with a 0x00 sign byte.
    for (const candidateS of [s, N - s]) {
      const reencoded = derSignature(r, candidateS);
      const converted = derEcdsaSignatureToCompact(reencoded);
      expect(Buffer.from(converted.subarray(32))).toEqual(Buffer.from(bigIntTo32(s)));
      expect(verifiesEverywhere(publicKey, converted)).toEqual({ node: true, noble: true });
    }
    expect(derInteger(s >> 255n ? s : N - s)[1]).toBe(33);
  });

  it("verifies real signatures whose r or s needs fewer than 32 bytes", () => {
    const privateKey = p256.utils.randomPrivateKey();
    const publicKey = NodeCrypto.createPublicKey({
      key: Buffer.concat([
        Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex"),
        Buffer.from(p256.getPublicKey(privateKey, false)),
      ]),
      format: "der",
      type: "spki",
    });
    const digest = NodeCrypto.hash("sha256", message, "buffer");
    let found = 0;
    // Each scalar is short with probability 1/256; 20k tries find one with overwhelming odds.
    for (let i = 0; i < 20_000 && found < 2; i++) {
      const signature = p256.sign(digest, privateKey, { prehash: false, extraEntropy: true });
      if (signature.r >= 1n << 248n && signature.s >= 1n << 248n) continue;
      found++;
      const der = signature.toDERRawBytes();
      const compact = derEcdsaSignatureToCompact(der);
      expect(Buffer.from(compact)).toEqual(Buffer.from(signature.normalizeS().toCompactRawBytes()));
      expect(verifiesEverywhere(publicKey, compact)).toEqual({ node: true, noble: true });
    }
    expect(found).toBe(2);
  });

  it("keeps the smallest scalars at the right of their 32-byte slot", () => {
    const compact = derEcdsaSignatureToCompact(derSignature(1n, 0x80n));
    expect(Buffer.from(compact).toString("hex")).toBe(`${"00".repeat(31)}01${"00".repeat(31)}80`);
    const maxScalars = derEcdsaSignatureToCompact(derSignature(N - 1n, N - 1n));
    expect(Buffer.from(maxScalars.subarray(0, 32))).toEqual(Buffer.from(bigIntTo32(N - 1n)));
  });

  const valid = derSignature(0x1234n, 0x5678n);
  const hex = (value: string) => Uint8Array.from(Buffer.from(value.replaceAll(" ", ""), "hex"));
  const malformed: ReadonlyArray<readonly [string, string, Uint8Array]> = [
    ["empty", "too short", new Uint8Array()],
    ["compact instead of DER", "not a SEQUENCE", new Uint8Array(64).fill(1)],
    ["SET instead of SEQUENCE", "not a SEQUENCE", Uint8Array.from([0x31, ...valid.subarray(1)])],
    [
      "sequence length too long",
      "SEQUENCE length",
      Uint8Array.from([0x30, valid.length - 1, ...valid.subarray(2)]),
    ],
    [
      "sequence length too short",
      "SEQUENCE length",
      Uint8Array.from([0x30, valid.length - 3, ...valid.subarray(2)]),
    ],
    [
      "trailing bytes",
      "trailing bytes",
      Uint8Array.from([0x30, valid.length - 1, ...valid.subarray(2), 0x00]),
    ],
    [
      "long-form length",
      "long-form",
      Uint8Array.from([0x30, 0x81, valid.length - 2, ...valid.subarray(2)]),
    ],
    ["r not an INTEGER", "r is not an INTEGER", hex("3008 0402 1234 0202 5678")],
    ["zero-length r", "r has no length", hex("3006 0200 0202 5678")],
    ["negative r", "r is negative", hex("3008 0202 9234 0202 5678")],
    ["non-minimal r", "r has a non-minimal", hex("3009 0203 001234 0202 5678")],
    ["r = 0", "r is outside", hex("3007 0201 00 0202 5678")],
    ["r = n", "r is outside", derSignature(N, 1n)],
    ["s > n", "s is outside", derSignature(1n, N + 5n)],
    [
      "33-byte r without sign byte",
      "r is wider than 32",
      Uint8Array.from([
        0x30,
        0x26,
        0x02,
        0x21,
        0x01,
        ...new Uint8Array(32).fill(1),
        0x02,
        0x01,
        0x01,
      ]),
    ],
    [
      "34-byte r",
      "r is longer than 33",
      Uint8Array.from([
        0x30,
        0x27,
        0x02,
        0x22,
        0x00,
        0x00,
        ...new Uint8Array(32).fill(0x80),
        0x02,
        0x01,
        0x01,
      ]),
    ],
    ["missing s", "s is not an INTEGER", hex("3006 0204 12345678")],
    ["s runs past the end", "s runs past", hex("3008 0202 1234 0204 5678")],
    ["a third INTEGER", "trailing bytes", hex("300b 0202 1234 0202 5678 0201 01")],
  ];

  it.each(malformed)("rejects %s", (_name, reason, der) => {
    expect(() => derEcdsaSignatureToCompact(der)).toThrow(MalformedDerSignatureError);
    expect(() => derEcdsaSignatureToCompact(der)).toThrow(reason);
  });
});
