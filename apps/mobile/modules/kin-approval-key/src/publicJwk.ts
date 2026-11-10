import type { DpopPublicJwk } from "@t3tools/shared/dpopCommon";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Schema from "effect/Schema";

// SubjectPublicKeyInfo DER header for id-ecPublicKey / prime256v1 with an uncompressed point.
const P256_SPKI_PREFIX = Uint8Array.from([
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a,
  0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
]);
const UNCOMPRESSED_POINT_BYTES = 65;
// P-256 field prime and curve constant b (SEC 2); the curve is y² = x³ − 3x + b.
const P256_P = 2n ** 256n - 2n ** 224n + 2n ** 192n + 2n ** 96n - 1n;
const P256_B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;

const toBigInt = (bytes: Uint8Array) =>
  bytes.reduce((value, byte) => (value << 8n) | BigInt(byte), 0n);

function isOnP256(point: Uint8Array): boolean {
  const x = toBigInt(point.subarray(1, 33));
  const y = toBigInt(point.subarray(33, 65));
  if (x >= P256_P || y >= P256_P) return false;
  return (y * y - (x * x * x - 3n * x + P256_B)) % P256_P === 0n;
}

export class InvalidApprovalPublicKeyError extends Schema.TaggedError<InvalidApprovalPublicKeyError>()(
  "InvalidApprovalPublicKeyError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

function uncompressedPoint(publicKey: Uint8Array): Uint8Array {
  if (publicKey.length === UNCOMPRESSED_POINT_BYTES) return publicKey;
  if (
    publicKey.length === P256_SPKI_PREFIX.length + UNCOMPRESSED_POINT_BYTES &&
    P256_SPKI_PREFIX.every((byte, index) => publicKey[index] === byte)
  ) {
    return publicKey.subarray(P256_SPKI_PREFIX.length);
  }
  throw new InvalidApprovalPublicKeyError({
    message:
      "Approval public key is neither an uncompressed P-256 point nor a P-256 SubjectPublicKeyInfo.",
  });
}

/**
 * Builds the JWK for the native key's public half: iOS exports an X9.63 uncompressed point,
 * Android a SubjectPublicKeyInfo. The point must lie on P-256.
 */
export function publicJwkFromNativePublicKey(publicKey: Uint8Array): DpopPublicJwk {
  const point = uncompressedPoint(publicKey);
  if (point[0] !== 0x04) {
    throw new InvalidApprovalPublicKeyError({
      message: "Approval public key is not an uncompressed point.",
    });
  }
  if (!isOnP256(point)) {
    throw new InvalidApprovalPublicKeyError({ message: "Approval public key is not on P-256." });
  }
  return {
    kty: "EC",
    crv: "P-256",
    x: Base64Url.encode(point.subarray(1, 33)),
    y: Base64Url.encode(point.subarray(33, 65)),
  };
}
