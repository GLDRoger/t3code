import { p256 } from "@noble/curves/nist";
import { sha256 } from "@noble/hashes/sha2";
import {
  KIN_GRANT_MAX_CLOCK_SKEW_SECONDS,
  KIN_GRANT_MAX_LIFETIME_SECONDS,
  KinGrantHeader,
  KinGrantPayload,
  type KinApproverPublicJwk,
  type KinGrantRejectionReason,
} from "@t3tools/contracts";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { computeDpopJwkThumbprint } from "./dpop.ts";
import { stableStringify } from "./relaySigning.ts";

const MAX_COMPACT_LENGTH = 16_384;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
// Spec section 5: a jti is 16+ random bytes, a nonce exactly 32. The device parsers check the same.
const JTI = /^[A-Za-z0-9_-]{22,}$/;
const NONCE = /^[A-Za-z0-9_-]{43}$/;
const strict = { onExcessProperty: "error" } as const;
const decodeHeader = Schema.decodeUnknownExit(KinGrantHeader, strict);
const decodePayload = Schema.decodeUnknownExit(KinGrantPayload, strict);
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

const encodePart = (value: unknown) => Base64Url.encode(encoder.encode(stableStringify(value)));

/** The ASCII JWS signing input `b64url(header).b64url(payload)`, each part canonical JSON. */
export function encodeGrantSigningInput(header: KinGrantHeader, payload: KinGrantPayload): string {
  return `${encodePart(header)}.${encodePart(payload)}`;
}

/** Unpadded base64url with zero trailing bits only: one byte string has one spelling. */
function strictBase64Url(segment: string): Uint8Array | null {
  if (!BASE64URL.test(segment)) return null;
  const decoded = Base64Url.decode(segment);
  if (Result.isFailure(decoded) || Base64Url.encode(decoded.success) !== segment) return null;
  return decoded.success;
}

/** Bytes that are UTF-8 JSON equal to their own `stableStringify`, or null. */
function canonicalJson(segment: string): unknown {
  const bytes = strictBase64Url(segment);
  if (bytes === null) return null;
  try {
    const text = utf8.decode(bytes);
    const value: unknown = JSON.parse(text);
    return stableStringify(value) === text ? value : null;
  } catch {
    return null;
  }
}

export type DecodedKinGrant = {
  readonly header: KinGrantHeader;
  readonly payload: KinGrantPayload;
  readonly signingInput: string;
  readonly signature: Uint8Array;
};

/** Approvals spec section 5 check 1: shape and canonical bytes. Null means `malformed`. */
export function decodeKinGrant(compact: string): DecodedKinGrant | null {
  if (compact.length > MAX_COMPACT_LENGTH) return null;
  const parts = compact.split(".");
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const header = decodeHeader(canonicalJson(headerPart));
  const payload = decodePayload(canonicalJson(payloadPart));
  const signature = strictBase64Url(signaturePart);
  if (Exit.isFailure(header) || Exit.isFailure(payload) || signature?.length !== 64) return null;
  if (!JTI.test(payload.value.jti) || !NONCE.test(payload.value.nonce)) return null;
  const signingInput = `${headerPart}.${payloadPart}`;
  // A schema that trims or otherwise transforms a value would make the decoded grant differ from
  // the signed bytes; one signed string must have exactly one meaning.
  if (encodeGrantSigningInput(header.value, payload.value) !== signingInput) return null;
  return {
    header: header.value,
    payload: payload.value,
    signingInput,
    signature,
  };
}

function publicKeyBytes(jwk: KinApproverPublicJwk): Uint8Array | null {
  const x = strictBase64Url(jwk.x);
  const y = strictBase64Url(jwk.y);
  if (x?.length !== 32 || y?.length !== 32) return null;
  const key = new Uint8Array(65);
  key[0] = 0x04;
  key.set(x, 1);
  key.set(y, 33);
  return key;
}

export type KinGrantVerification =
  | { readonly ok: true; readonly grant: DecodedKinGrant }
  | {
      readonly ok: false;
      readonly reason: Extract<
        KinGrantRejectionReason,
        "malformed" | "unknown_key" | "bad_signature" | "time_window"
      >;
    };

/**
 * Spec section 5 checks 1, 3, 8 and check 2's kid binding: pure, `now` comes in. Passing isn't
 * approval: APPR-4's GrantVerifier looks the kid up in the key registry (active, same org) and
 * runs checks 4-7, 9 and 10 (owner, session, action state and nonce, live head, jti replay).
 */
export function verifyKinGrant(input: {
  readonly compact: string;
  readonly publicJwk: KinApproverPublicJwk;
  readonly nowEpochSeconds: number;
}): KinGrantVerification {
  const grant = decodeKinGrant(input.compact);
  if (grant === null) return { ok: false, reason: "malformed" };
  const { header, payload } = grant;
  if (
    header.kid !== computeDpopJwkThumbprint(input.publicJwk) ||
    payload.approver.kid !== header.kid
  ) {
    return { ok: false, reason: "unknown_key" };
  }
  const key = publicKeyBytes(input.publicJwk);
  let verified = false;
  try {
    verified =
      key !== null &&
      p256.verify(grant.signature, sha256(encoder.encode(grant.signingInput)), key, {
        prehash: false,
        format: "compact",
        lowS: true,
      });
  } catch {
    verified = false;
  }
  if (!verified) return { ok: false, reason: "bad_signature" };
  const now = input.nowEpochSeconds;
  if (
    !Number.isFinite(now) ||
    Math.abs(now - payload.iat) > KIN_GRANT_MAX_CLOCK_SKEW_SECONDS ||
    payload.exp <= payload.iat ||
    payload.exp - payload.iat > KIN_GRANT_MAX_LIFETIME_SECONDS ||
    now >= payload.exp
  ) {
    return { ok: false, reason: "time_window" };
  }
  return { ok: true, grant };
}
