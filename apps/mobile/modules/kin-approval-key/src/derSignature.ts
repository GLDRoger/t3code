import * as Schema from "effect/Schema";

const P256_ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const HALF_ORDER = P256_ORDER >> 1n;
const SCALAR_BYTES = 32;

export class MalformedDerSignatureError extends Schema.TaggedError<MalformedDerSignatureError>()(
  "MalformedDerSignatureError",
  { reason: Schema.String },
) {
  override get message(): string {
    return `Malformed DER ECDSA signature: ${this.reason}.`;
  }
}

function fail(reason: string): never {
  throw new MalformedDerSignatureError({ reason });
}

function readScalar(der: Uint8Array, offset: number, label: string) {
  if (der[offset] !== 0x02) fail(`${label} is not an INTEGER`);
  const length = der[offset + 1];
  if (length === undefined || length === 0) fail(`${label} has no length`);
  if (length > SCALAR_BYTES + 1) fail(`${label} is longer than 33 bytes`);
  const start = offset + 2;
  const end = start + length;
  if (end > der.length) fail(`${label} runs past the end`);
  const first = der[start] ?? 0;
  if (first & 0x80) fail(`${label} is negative`);
  if (first === 0x00 && length > 1 && ((der[start + 1] ?? 0) & 0x80) === 0) {
    fail(`${label} has a non-minimal leading zero`);
  }
  const magnitude = first === 0x00 ? der.subarray(start + 1, end) : der.subarray(start, end);
  if (magnitude.length > SCALAR_BYTES) fail(`${label} is wider than 32 bytes`);

  let value = 0n;
  for (const byte of magnitude) value = (value << 8n) | BigInt(byte);
  if (value === 0n || value >= P256_ORDER) fail(`${label} is outside [1, n-1]`);

  return { value, end };
}

function scalarBytes(value: bigint): Uint8Array {
  const bytes = new Uint8Array(SCALAR_BYTES);
  let rest = value;
  for (let index = SCALAR_BYTES - 1; index >= 0; index--, rest >>= 8n)
    bytes[index] = Number(rest & 0xffn);
  return bytes;
}

/**
 * Converts a strict-DER P-256 ECDSA signature (what the Secure Enclave and Android Keystore return)
 * into the 64-byte `r‖s` form JWS ES256 uses, with `s` normalised to the low half of the group
 * order. Anything that isn't canonical DER is rejected.
 */
export function derEcdsaSignatureToCompact(der: Uint8Array): Uint8Array {
  if (der.length < 8) fail("too short");
  if (der[0] !== 0x30) fail("not a SEQUENCE");
  // P-256 signatures are at most 72 bytes, so the length is always short form.
  const sequenceLength = der[1] ?? 0;
  if (sequenceLength & 0x80) fail("long-form length");
  if (sequenceLength !== der.length - 2) fail("SEQUENCE length does not match");

  const r = readScalar(der, 2, "r");
  const s = readScalar(der, r.end, "s");
  if (s.end !== der.length) fail("trailing bytes");

  // (r, s) and (r, n − s) both verify; the server accepts only low-S, so one grant has one signature.
  const lowS = s.value > HALF_ORDER ? P256_ORDER - s.value : s.value;
  const compact = new Uint8Array(SCALAR_BYTES * 2);
  compact.set(scalarBytes(r.value), 0);
  compact.set(scalarBytes(lowS), SCALAR_BYTES);
  return compact;
}
