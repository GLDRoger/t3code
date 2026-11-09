// @effect-diagnostics extendsNativeError:off -- thrown and caught inside the pure parsers only.
/**
 * A strict DER reader for the few structures attestation needs. Node's X509Certificate verifies
 * signatures but doesn't expose extensions. Anything not canonical DER throws.
 */
export class DerError extends Error {}

export type Tlv = {
  /** 0 universal, 1 application, 2 context, 3 private. */
  readonly cls: number;
  readonly constructed: boolean;
  readonly tag: number;
  readonly value: Uint8Array;
  /** The whole element, header included. */
  readonly raw: Uint8Array;
};

const UNIVERSAL = 0;
export const CONTEXT = 2;
const T_BOOLEAN = 1;
const T_INTEGER = 2;
const T_OCTET_STRING = 4;
const T_OID = 6;
const T_ENUMERATED = 10;
const T_SEQUENCE = 16;
export const T_SET = 17;

const fail = (message: string): never => {
  throw new DerError(message);
};

function readOne(bytes: Uint8Array, start: number): { tlv: Tlv; end: number } {
  let offset = start;
  const next = () => (offset < bytes.length ? bytes[offset++]! : fail("truncated DER"));
  const first = next();
  const cls = first >> 6;
  const constructed = (first & 0x20) !== 0;
  let tag = first & 0x1f;
  if (tag === 0x1f) {
    tag = 0;
    let byte = next();
    if (byte === 0x80) fail("non-minimal tag");
    for (;;) {
      tag = tag * 128 + (byte & 0x7f);
      if (tag > 0xffff) fail("tag too large");
      if ((byte & 0x80) === 0) break;
      byte = next();
    }
    if (tag < 0x1f) fail("non-minimal tag");
  }
  const lengthByte = next();
  let length = lengthByte;
  if (lengthByte === 0x80) fail("indefinite length");
  if (lengthByte > 0x80) {
    const count = lengthByte & 0x7f;
    if (count > 4) fail("length too large");
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + next();
    if (length < 0x80 || (count > 1 && length < 256 ** (count - 1))) fail("non-minimal length");
  }
  const end = offset + length;
  if (end > bytes.length) fail("truncated DER");
  return {
    tlv: {
      cls,
      constructed,
      tag,
      value: bytes.subarray(offset, end),
      raw: bytes.subarray(start, end),
    },
    end,
  };
}

/** Exactly one element filling `bytes`. */
export function parse(bytes: Uint8Array): Tlv {
  const { tlv, end } = readOne(bytes, 0);
  if (end !== bytes.length) fail("trailing bytes after DER");
  return tlv;
}

export function children(tlv: Tlv): ReadonlyArray<Tlv> {
  if (!tlv.constructed) fail("expected a constructed element");
  const out: Tlv[] = [];
  let offset = 0;
  while (offset < tlv.value.length) {
    const { tlv: child, end } = readOne(tlv.value, offset);
    out.push(child);
    offset = end;
  }
  return out;
}

export function expect(tlv: Tlv | undefined, tag: number, cls = UNIVERSAL): Tlv {
  if (tlv === undefined) return fail(`missing element with tag ${tag}`);
  if (tlv.cls !== cls || tlv.tag !== tag)
    fail(`expected tag ${cls}:${tag}, got ${tlv.cls}:${tlv.tag}`);
  return tlv;
}

export function sequence(tlv: Tlv | undefined): ReadonlyArray<Tlv> {
  return children(expect(tlv, T_SEQUENCE));
}

/** INTEGER or ENUMERATED as a safe non-negative number. */
export function integer(tlv: Tlv | undefined, tag = T_INTEGER): number {
  const { value, constructed } = expect(tlv, tag);
  if (constructed || value.length === 0) fail("bad integer");
  if (value.length > 1 && value[0] === 0 && (value[1]! & 0x80) === 0) fail("non-minimal integer");
  if (value.length > 1 && value[0] === 0xff && (value[1]! & 0x80) !== 0)
    fail("non-minimal integer");
  if ((value[0]! & 0x80) !== 0) fail("negative integer");
  let n = 0;
  for (const byte of value) n = n * 256 + byte;
  if (!Number.isSafeInteger(n)) fail("integer too large");
  return n;
}

export function enumerated(tlv: Tlv | undefined): number {
  return integer(tlv, T_ENUMERATED);
}

export function octets(tlv: Tlv | undefined): Uint8Array {
  const element = expect(tlv, T_OCTET_STRING);
  if (element.constructed) fail("constructed octet string");
  return element.value;
}

export function boolean(tlv: Tlv | undefined): boolean {
  const { value } = expect(tlv, T_BOOLEAN);
  if (value.length !== 1 || (value[0] !== 0 && value[0] !== 0xff)) fail("bad boolean");
  return value[0] === 0xff;
}

/** An OID's content bytes in hex, for comparison with constants. */
function oidHex(tlv: Tlv | undefined): string {
  return Buffer.from(expect(tlv, T_OID).value).toString("hex");
}

export type Extension = { readonly critical: boolean; readonly value: Uint8Array };

/** `tbsCertificate.extensions` keyed by OID content hex. Duplicate OIDs throw. */
export function certificateExtensions(certificateDer: Uint8Array): ReadonlyMap<string, Extension> {
  const [tbs] = sequence(parse(certificateDer));
  const fields = sequence(tbs);
  const wrapper = fields.find((field) => field.cls === CONTEXT && field.tag === 3);
  const out = new Map<string, Extension>();
  if (wrapper === undefined) return out;
  const [list] = children(wrapper);
  for (const extension of sequence(list)) {
    const parts = sequence(extension);
    const oid = oidHex(parts[0]);
    const critical = parts.length === 3 ? boolean(parts[1]) : false;
    if (parts.length !== 2 && parts.length !== 3) fail("bad extension");
    if (out.has(oid)) fail("duplicate extension");
    out.set(oid, { critical, value: octets(parts[parts.length - 1]) });
  }
  return out;
}
