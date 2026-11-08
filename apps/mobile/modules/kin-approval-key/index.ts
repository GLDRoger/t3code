import type { DpopPublicJwk } from "@t3tools/shared/dpopCommon";
import * as Base64 from "effect/encoding/Base64";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Result from "effect/Result";
import { CodedError, requireOptionalNativeModule } from "expo";

import { derEcdsaSignatureToCompact } from "./src/derSignature";
import { publicJwkFromNativePublicKey } from "./src/publicJwk";

export type KinApprovalKeyHardware = "secure_enclave" | "strongbox" | "tee";

const ERROR_CODES = [
  "E_MODULE_UNAVAILABLE",
  "E_NO_SECURE_HARDWARE",
  "E_UNSUPPORTED_OS",
  "E_BIOMETRY_UNAVAILABLE",
  "E_BIOMETRY_LOCKOUT",
  "E_KEY_EXISTS",
  "E_KEY_NOT_FOUND",
  "E_KEY_INVALIDATED",
  "E_USER_CANCELED",
  "E_AUTH_FAILED",
  "E_BUSY",
  "E_NOT_A_GRANT",
  "E_NO_ACTIVITY",
  "E_OBSCURED",
  "E_ATTESTATION_FAILED",
  "E_INVALID_INPUT",
  "E_KEYCHAIN",
  "E_KEYSTORE",
] as const;
const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set(ERROR_CODES);

/** Codes on errors this module throws or the native side rejects with; see README.md. */
export type KinApprovalKeyErrorCode = (typeof ERROR_CODES)[number];

export function isKinApprovalKeyError(
  error: unknown,
): error is Error & { readonly code: KinApprovalKeyErrorCode } {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    KNOWN_ERROR_CODES.has(error.code)
  );
}

const invalidInput = (message: string) => new CodedError("E_INVALID_INPUT", message);

export type KinApprovalKeyAttestation =
  | {
      readonly format: "android-key";
      /** Leaf first, base64 (not base64url) DER, as in a JWS `x5c`. */
      readonly certificateChain: ReadonlyArray<string>;
    }
  | {
      /** Its client data hash is `sha256(challenge ‖ 0x04 ‖ x ‖ y)` of the new key. */
      readonly format: "apple-app-attest";
      /** Base64: the SHA-256 of the App Attest key's public key. */
      readonly keyId: string;
      /** Base64 CBOR attestation object from `DCAppAttestService.attestKey`. */
      readonly attestationObject: string;
    };

export interface KinApprovalKey {
  readonly publicJwk: DpopPublicJwk;
  readonly hardware: KinApprovalKeyHardware;
  readonly attestation?: KinApprovalKeyAttestation;
}

interface NativeKinApprovalKey {
  createKey(attestationChallenge: string): Promise<{
    readonly publicKey: string;
    readonly hardware: KinApprovalKeyHardware;
    readonly attestationChain?: ReadonlyArray<string>;
    readonly appAttest?: { readonly keyId: string; readonly attestationObject: string };
  }>;
  signDer(signingInput: string): Promise<string>;
  hasKey(): Promise<boolean>;
  deleteKey(): Promise<void>;
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const SIGNING_INPUT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MIN_CHALLENGE_BYTES = 16;
const MAX_CHALLENGE_BYTES = 128;

function native(): NativeKinApprovalKey {
  const module = requireOptionalNativeModule<NativeKinApprovalKey>("KinApprovalKey");
  if (!module)
    throw new CodedError(
      "E_MODULE_UNAVAILABLE",
      "KinApprovalKey is not in this build; install a current dev client.",
    );
  return module;
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const APP_ATTEST_KEY_ID_BYTES = 32;

function decodeBase64(value: unknown, label: string): Uint8Array {
  const decoded =
    typeof value === "string" && BASE64.test(value) ? Base64.decode(value) : undefined;
  if (!decoded || Result.isFailure(decoded) || decoded.success.length === 0)
    throw invalidInput(`${label} is not base64.`);
  return decoded.success;
}

function attestationOf(created: Awaited<ReturnType<NativeKinApprovalKey["createKey"]>>) {
  if (created.attestationChain) {
    for (const certificate of created.attestationChain) decodeBase64(certificate, "certificate");
    return { format: "android-key", certificateChain: created.attestationChain } as const;
  }
  if (created.appAttest) {
    const { keyId, attestationObject } = created.appAttest;
    if (decodeBase64(keyId, "keyId").length !== APP_ATTEST_KEY_ID_BYTES)
      throw invalidInput("keyId is not a SHA-256 hash.");
    decodeBase64(attestationObject, "attestationObject");
    return { format: "apple-app-attest", keyId, attestationObject } as const;
  }
  return undefined;
}

function decodeBase64Url(value: string, label: string): Uint8Array {
  const decoded = BASE64URL.test(value) ? Base64Url.decode(value) : undefined;
  if (!decoded || Result.isFailure(decoded)) throw invalidInput(`${label} is not base64url.`);
  return decoded.success;
}

/**
 * Creates the approval key; `E_KEY_EXISTS` rather than replacing one the server may trust.
 * `attestationChallenge` is the server's nonce (base64url, 16 to 128 bytes), bound into the
 * Keystore chain or App Attest client data. No `attestation`: the server won't activate the key.
 */
export async function createKey(attestationChallenge: string): Promise<KinApprovalKey> {
  const challenge = decodeBase64Url(attestationChallenge, "attestationChallenge");
  if (challenge.length < MIN_CHALLENGE_BYTES || challenge.length > MAX_CHALLENGE_BYTES)
    throw invalidInput("attestationChallenge must encode 16 to 128 bytes.");
  const created = await native().createKey(attestationChallenge);
  const publicJwk = publicJwkFromNativePublicKey(decodeBase64Url(created.publicKey, "publicKey"));
  const attestation = attestationOf(created);
  return { publicJwk, hardware: created.hardware, ...(attestation ? { attestation } : {}) };
}

/**
 * `signingInput` is the grant's JWS signing input as-is (spec section 5): unpadded base64url of
 * the `stableStringify` header and payload, joined by "."; the key signs its ASCII bytes after a
 * biometric. Natively: non-grants get `E_NOT_A_GRANT`, the prompt is written from the payload, and
 * a second call before the first settles gets `E_BUSY`. Resolves to the low-S `r‖s`, base64url.
 */
export async function sign(signingInput: string): Promise<string> {
  if (!SIGNING_INPUT.test(signingInput))
    throw invalidInput("signingInput must be two unpadded base64url parts joined by one dot.");
  const der = await native().signDer(signingInput);
  return Base64Url.encode(derEcdsaSignatureToCompact(decodeBase64Url(der, "signature")));
}

export function hasKey(): Promise<boolean> {
  return native().hasKey();
}

export function deleteKey(): Promise<void> {
  return native().deleteKey();
}
