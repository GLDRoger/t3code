import { p256 } from "@noble/curves/nist";
import type { DpopPublicJwk } from "@t3tools/shared/dpopCommon";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Schema from "effect/Schema";

// SubjectPublicKeyInfo DER header for id-ecPublicKey / prime256v1 with an uncompressed point.
const P256_SPKI_PREFIX = Uint8Array.from([
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a,
  0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
]);
const UNCOMPRESSED_POINT_BYTES = 65;

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
  try {
    p256.ProjectivePoint.fromHex(point).assertValidity();
  } catch (cause) {
    throw new InvalidApprovalPublicKeyError({
      message: "Approval public key is not on P-256.",
      cause,
    });
  }
  return {
    kty: "EC",
    crv: "P-256",
    x: Base64Url.encode(point.subarray(1, 33)),
    y: Base64Url.encode(point.subarray(33, 65)),
  };
}
