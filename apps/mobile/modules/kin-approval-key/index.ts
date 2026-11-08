import type { DpopPublicJwk } from "@t3tools/shared/dpopCommon";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Result from "effect/Result";
import { requireOptionalNativeModule } from "expo";

import { derEcdsaSignatureToCompact } from "./src/derSignature";
import { publicJwkFromNativePublicKey } from "./src/publicJwk";

export type KinApprovalKeyHardware = "secure_enclave" | "strongbox" | "tee";

/** Codes on errors the native side rejects with; see README.md. */
export type KinApprovalKeyErrorCode =
  | "E_NO_SECURE_HARDWARE"
  | "E_UNSUPPORTED_OS"
  | "E_BIOMETRY_UNAVAILABLE"
  | "E_BIOMETRY_LOCKOUT"
  | "E_KEY_EXISTS"
  | "E_KEY_NOT_FOUND"
  | "E_KEY_INVALIDATED"
  | "E_USER_CANCELED"
  | "E_AUTH_FAILED"
  | "E_BUSY"
  | "E_NOT_A_GRANT"
  | "E_NO_ACTIVITY"
  | "E_OBSCURED"
  | "E_INVALID_INPUT"
  | "E_KEYCHAIN"
  | "E_KEYSTORE";

export interface KinApprovalKeyAttestation {
  readonly format: "android-key";
  /** Leaf first, base64 (not base64url) DER, as in a JWS `x5c`. */
  readonly certificateChain: ReadonlyArray<string>;
}

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
    throw new Error("KinApprovalKey is not in this build; install a current dev client.");
  return module;
}

function decodeBase64Url(value: string, label: string): Uint8Array {
  const decoded = BASE64URL.test(value) ? Base64Url.decode(value) : undefined;
  if (!decoded || Result.isFailure(decoded)) throw new Error(`${label} is not base64url.`);
  return decoded.success;
}

/**
 * Creates the device's approval key in the Secure Enclave or Android Keystore. Fails with
 * `E_KEY_EXISTS` rather than replacing a key the server may already trust.
 * `attestationChallenge` is the server's registration nonce as unpadded base64url of 16 to 128
 * bytes. Android binds it into the attestation chain; iOS has no attestation yet and ignores it.
 */
export async function createKey(attestationChallenge: string): Promise<KinApprovalKey> {
  const challenge = decodeBase64Url(attestationChallenge, "attestationChallenge");
  if (challenge.length < MIN_CHALLENGE_BYTES || challenge.length > MAX_CHALLENGE_BYTES)
    throw new Error("attestationChallenge must encode 16 to 128 bytes.");
  const created = await native().createKey(attestationChallenge);
  const publicJwk = publicJwkFromNativePublicKey(decodeBase64Url(created.publicKey, "publicKey"));
  return {
    publicJwk,
    hardware: created.hardware,
    ...(created.attestationChain
      ? { attestation: { format: "android-key", certificateChain: created.attestationChain } }
      : {}),
  };
}

/**
 * `signingInput` is the grant's JWS signing input as-is (spec section 5): unpadded base64url of
 * the `stableStringify` header and payload, joined by "."; the key signs its ASCII bytes after a
 * biometric. Natively: non-grants get `E_NOT_A_GRANT`, the prompt is written from the payload, and
 * a second call before the first settles gets `E_BUSY`. Resolves to the low-S `r‖s`, base64url.
 */
export async function sign(signingInput: string): Promise<string> {
  if (!SIGNING_INPUT.test(signingInput))
    throw new Error("signingInput must be two unpadded base64url parts joined by one dot.");
  const der = await native().signDer(signingInput);
  return Base64Url.encode(derEcdsaSignatureToCompact(decodeBase64Url(der, "signature")));
}

export function hasKey(): Promise<boolean> {
  return native().hasKey();
}

export function deleteKey(): Promise<void> {
  return native().deleteKey();
}
