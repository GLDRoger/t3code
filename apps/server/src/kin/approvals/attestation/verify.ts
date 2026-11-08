// @effect-diagnostics nodeBuiltinImport:off extendsNativeError:off -- node:crypto X.509; errors stay inside `run`.
import * as NodeCrypto from "node:crypto";

import type { KinApproverKeyHardware, KinApproverPublicJwk } from "@t3tools/contracts";

import * as Der from "./der.ts";

/** Pinned roots, allowlists and Google's revocation list (approvals spec section 4). */
export type AttestationTrust = {
  readonly googleRoots: ReadonlyArray<NodeCrypto.X509Certificate>;
  /** Lowercase hex serials without leading zeros, as Google's status list keys them. */
  readonly androidRevokedSerials: ReadonlySet<string>;
  readonly androidApps: ReadonlyArray<{
    readonly packageName: string;
    /** Lowercase hex SHA-256 of each release signing certificate. */
    readonly signingCertSha256: ReadonlyArray<string>;
  }>;
  readonly appleRoot: NodeCrypto.X509Certificate;
  /** `<teamId>.<bundleId>`. */
  readonly appleAppIds: ReadonlyArray<string>;
  readonly appleEnvironments: ReadonlyArray<"production" | "development">;
};

export type AttestationResult =
  | { readonly attested: true; readonly hardware: Exclude<KinApproverKeyHardware, "software"> }
  | { readonly attested: false; readonly reason: string };

class Refused extends Error {}
const refuse = (reason: string): never => {
  throw new Refused(reason);
};
const check = (condition: boolean, reason: string) => {
  if (!condition) refuse(reason);
};

const run = (body: () => AttestationResult): AttestationResult => {
  try {
    return body();
  } catch (error) {
    if (error instanceof Refused) return { attested: false, reason: error.message };
    if (error instanceof Der.DerError)
      return { attested: false, reason: `malformed: ${error.message}` };
    return { attested: false, reason: "malformed attestation" };
  }
};

const sha256 = (...parts: ReadonlyArray<Uint8Array>) => {
  const hash = NodeCrypto.createHash("sha256");
  for (const part of parts) hash.update(part);
  return new Uint8Array(hash.digest());
};
const equalBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && NodeCrypto.timingSafeEqual(a, b);
const spki = (certificate: NodeCrypto.X509Certificate) =>
  new Uint8Array(certificate.publicKey.export({ type: "spki", format: "der" }));
const decodeBase64 = (value: string) => {
  check(/^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length % 4 === 0, "certificate isn't base64");
  return new Uint8Array(Buffer.from(value, "base64"));
};
const parseCertificate = (der: Uint8Array) => {
  try {
    return new NodeCrypto.X509Certificate(der);
  } catch {
    return refuse("certificate doesn't parse");
  }
};
const withinValidity = (certificate: NodeCrypto.X509Certificate, now: number) =>
  Date.parse(certificate.validFrom) <= now && now <= Date.parse(certificate.validTo);

/** Each certificate is signed by the next one. */
function verifyLinks(chain: ReadonlyArray<NodeCrypto.X509Certificate>, now: number) {
  for (const [index, certificate] of chain.entries()) {
    check(withinValidity(certificate, now), `certificate ${index} is outside its validity`);
    const issuer = chain[index + 1];
    if (issuer === undefined) continue;
    check(
      certificate.checkIssued(issuer) && certificate.verify(issuer.publicKey),
      `certificate ${index} isn't signed by the next one`,
    );
  }
}

const pointBytes = (jwk: { readonly x?: string; readonly y?: string }) => {
  check(typeof jwk.x === "string" && typeof jwk.y === "string", "not an EC key");
  return new Uint8Array([
    0x04,
    ...Buffer.from(jwk.x!, "base64url"),
    ...Buffer.from(jwk.y!, "base64url"),
  ]);
};
const jwkPoint = (jwk: KinApproverPublicJwk) => pointBytes(jwk);
const certificatePoint = (certificate: NodeCrypto.X509Certificate) => {
  const jwk = certificate.publicKey.export({ format: "jwk" });
  check(jwk.kty === "EC" && jwk.crv === "P-256", "attested key isn't P-256");
  return pointBytes(jwk);
};

/** 1.3.6.1.4.1.11129.2.1.17 */
const KEY_DESCRIPTION_OID = "2b06010401d679020111";
const SECURITY_LEVEL = { trustedEnvironment: 1, strongBox: 2 } as const;
const TAG = {
  purpose: 1,
  algorithm: 2,
  keySize: 3,
  digest: 5,
  ecCurve: 10,
  noAuthRequired: 503,
  userAuthType: 504,
  authTimeout: 505,
  allApplications: 600,
  origin: 702,
  rootOfTrust: 704,
  attestationApplicationId: 709,
} as const;
const PURPOSE_SIGN = 2;
const ALGORITHM_EC = 3;
const DIGEST_SHA_2_256 = 4;
const EC_CURVE_P_256 = 1;
const AUTH_FINGERPRINT = 2;
const ORIGIN_GENERATED = 0;
const BOOT_VERIFIED = 0;

function authorizationList(tlv: Der.Tlv | undefined): ReadonlyMap<number, Der.Tlv> {
  const out = new Map<number, Der.Tlv>();
  for (const entry of Der.sequence(tlv)) {
    check(entry.cls === Der.CONTEXT && entry.constructed, "malformed authorization list");
    check(!out.has(entry.tag), "duplicate authorization tag");
    const inner = Der.children(entry);
    check(inner.length === 1, "malformed authorization entry");
    out.set(entry.tag, inner[0]!);
  }
  return out;
}

const integerSet = (tlv: Der.Tlv | undefined) =>
  Der.children(Der.expect(tlv, Der.T_SET)).map((element) => Der.integer(element));
const exactly = (values: ReadonlyArray<number>, expected: number) =>
  values.length === 1 && values[0] === expected;

const normalizeSerial = (serial: string) => serial.toLowerCase().replace(/^0+(?=.)/, "");

export function verifyAndroidKeyAttestation(input: {
  readonly certificateChain: ReadonlyArray<string>;
  readonly challenge: Uint8Array;
  readonly publicJwk: KinApproverPublicJwk;
  readonly trust: AttestationTrust;
  /** Epoch milliseconds. */
  readonly now: number;
}): AttestationResult {
  return run(() => {
    const ders = input.certificateChain.map(decodeBase64);
    check(ders.length >= 2, "attestation chain is too short");
    const chain = ders.map(parseCertificate);
    // The sent root only names a pinned key: Google reissued roots with the same key, so the
    // pinned certificate, with its own validity, takes its place before the links are checked.
    const rootKey = spki(chain[chain.length - 1]!);
    const pinned = input.trust.googleRoots.find((root) => equalBytes(spki(root), rootKey));
    check(pinned !== undefined, "chain doesn't end at a Google hardware attestation root");
    verifyLinks([...chain.slice(0, -1), pinned!], input.now);
    for (const certificate of chain) {
      check(
        !input.trust.androidRevokedSerials.has(normalizeSerial(certificate.serialNumber)),
        "a certificate in the chain is revoked",
      );
    }
    check(
      equalBytes(certificatePoint(chain[0]!), jwkPoint(input.publicJwk)),
      "attested key isn't the registered key",
    );
    const descriptions = ders.map((der) => Der.certificateExtensions(der).get(KEY_DESCRIPTION_OID));
    check(descriptions[0] !== undefined, "leaf has no key description");
    check(
      descriptions.slice(1).every((extension) => extension === undefined),
      "key description outside the leaf",
    );

    const fields = Der.sequence(Der.parse(descriptions[0]!.value));
    check(fields.length >= 8, "malformed key description");
    const attestationLevel = Der.enumerated(fields[1]);
    const keyMintLevel = Der.enumerated(fields[3]);
    const hardwareLevels: ReadonlyArray<number> = [
      SECURITY_LEVEL.trustedEnvironment,
      SECURITY_LEVEL.strongBox,
    ];
    check(
      hardwareLevels.includes(attestationLevel) && hardwareLevels.includes(keyMintLevel),
      "attestation isn't from secure hardware",
    );
    check(equalBytes(Der.octets(fields[4]), input.challenge), "attestation challenge mismatch");
    const software = authorizationList(fields[6]);
    const hardware = authorizationList(fields[7]);

    check(exactly(integerSet(hardware.get(TAG.purpose)), PURPOSE_SIGN), "purpose isn't SIGN only");
    check(Der.integer(hardware.get(TAG.algorithm)) === ALGORITHM_EC, "algorithm isn't EC");
    check(Der.integer(hardware.get(TAG.ecCurve)) === EC_CURVE_P_256, "curve isn't P-256");
    check(Der.integer(hardware.get(TAG.keySize)) === 256, "key size isn't 256");
    check(exactly(integerSet(hardware.get(TAG.digest)), DIGEST_SHA_2_256), "digest isn't SHA-256");
    check(
      Der.integer(hardware.get(TAG.userAuthType)) === AUTH_FINGERPRINT,
      "user auth isn't biometric only",
    );
    for (const list of [software, hardware]) {
      check(!list.has(TAG.authTimeout), "key has an auth timeout");
      check(!list.has(TAG.noAuthRequired), "key needs no auth");
      check(!list.has(TAG.allApplications), "key is usable by every app");
    }
    check(
      Der.integer(hardware.get(TAG.origin)) === ORIGIN_GENERATED,
      "key wasn't generated in hardware",
    );
    const rootOfTrust = Der.sequence(hardware.get(TAG.rootOfTrust));
    check(rootOfTrust.length >= 3, "malformed root of trust");
    check(Der.boolean(rootOfTrust[1]), "bootloader is unlocked");
    check(Der.enumerated(rootOfTrust[2]) === BOOT_VERIFIED, "verified boot state isn't Verified");

    // Keystore, not KeyMint, fills this in, so it is usually software-enforced.
    const applicationId =
      hardware.get(TAG.attestationApplicationId) ?? software.get(TAG.attestationApplicationId);
    const [packages, digests] = Der.sequence(Der.parse(Der.octets(applicationId)));
    const packageInfos = Der.children(Der.expect(packages, Der.T_SET));
    check(packageInfos.length === 1, "attestation names more than one package");
    const packageName = Buffer.from(Der.octets(Der.sequence(packageInfos[0])[0])).toString("utf8");
    const app = input.trust.androidApps.find((candidate) => candidate.packageName === packageName);
    check(app !== undefined, "package isn't on the allowlist");
    const signers = Der.children(Der.expect(digests, Der.T_SET)).map((digest) =>
      Buffer.from(Der.octets(digest)).toString("hex"),
    );
    const allowed = new Set(app!.signingCertSha256);
    check(
      allowed.size > 0 &&
        new Set(signers).size === signers.length &&
        signers.length === allowed.size &&
        signers.every((digest) => allowed.has(digest)),
      "signing certificates don't match the allowlist",
    );

    return {
      attested: true,
      hardware: attestationLevel === SECURITY_LEVEL.strongBox ? "strongbox" : "tee",
    };
  });
}

/** 1.2.840.113635.100.8.2 */
const APPLE_NONCE_OID = "2a864886f763640802";
const AAGUID = {
  production: new Uint8Array([...Buffer.from("appattest"), 0, 0, 0, 0, 0, 0, 0]),
  development: new Uint8Array(Buffer.from("appattestdevelop")),
} as const;

type Cbor = number | string | Uint8Array | ReadonlyArray<Cbor> | ReadonlyMap<Cbor, Cbor>;

/** Definite-length unsigned ints, byte and text strings, arrays and maps: all App Attest uses. */
function decodeCbor(bytes: Uint8Array): Cbor {
  let offset = 0;
  const take = (count: number) => {
    check(offset + count <= bytes.length, "malformed: truncated CBOR");
    const out = bytes.subarray(offset, offset + count);
    offset += count;
    return out;
  };
  const argument = (info: number): number => {
    if (info < 24) return info;
    const width =
      info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : refuse("malformed: CBOR length");
    let n = 0;
    for (const byte of take(width)) n = n * 256 + byte;
    return n;
  };
  const item = (depth: number): Cbor => {
    check(depth < 8, "malformed: CBOR too deep");
    const [initial] = take(1);
    const major = initial! >> 5;
    const value = argument(initial! & 0x1f);
    switch (major) {
      case 0:
        return value;
      case 2:
        return take(value);
      case 3:
        return new TextDecoder("utf-8", { fatal: true }).decode(take(value));
      case 4:
        return Array.from({ length: value }, () => item(depth + 1));
      case 5: {
        const map = new Map<Cbor, Cbor>();
        for (let i = 0; i < value; i++) {
          const key = item(depth + 1);
          check(typeof key === "string" && !map.has(key), "malformed: CBOR map key");
          map.set(key, item(depth + 1));
        }
        return map;
      }
      default:
        return refuse("malformed: unsupported CBOR");
    }
  };
  const out = item(0);
  check(offset === bytes.length, "malformed: trailing CBOR");
  return out;
}

const field = (map: Cbor, key: string) =>
  map instanceof Map ? (map.get(key) as Cbor | undefined) : refuse("malformed: expected a map");
const bytesOf = (value: Cbor | undefined) =>
  value instanceof Uint8Array ? value : refuse("malformed: expected bytes");

export function verifyAppleAppAttest(input: {
  readonly keyId: string;
  readonly attestationObject: string;
  readonly challenge: Uint8Array;
  readonly publicJwk: KinApproverPublicJwk;
  readonly trust: AttestationTrust;
  /** Epoch milliseconds. */
  readonly now: number;
}): AttestationResult {
  return run(() => {
    const keyId = decodeBase64(input.keyId);
    check(keyId.length === 32, "keyId isn't a SHA-256");
    const object = decodeCbor(decodeBase64(input.attestationObject));
    check(field(object, "fmt") === "apple-appattest", "attestation format isn't apple-appattest");
    const statement = field(object, "attStmt");
    const x5c = field(statement ?? 0, "x5c");
    check(Array.isArray(x5c) && x5c.length >= 2, "attestation chain is too short");
    const chain = (x5c as ReadonlyArray<Cbor>).map((der) => parseCertificate(bytesOf(der)));
    verifyLinks(chain, input.now);
    const top = chain[chain.length - 1]!;
    const root = input.trust.appleRoot;
    check(
      withinValidity(root, input.now) && top.checkIssued(root) && top.verify(root.publicKey),
      "chain doesn't end at the Apple App Attest root",
    );

    const authData = bytesOf(field(object, "authData"));
    check(authData.length >= 55, "authenticator data is too short");
    const clientDataHash = sha256(input.challenge, jwkPoint(input.publicJwk));
    const nonce = sha256(authData, clientDataHash);
    const credCert = bytesOf((x5c as ReadonlyArray<Cbor>)[0]);
    const extension = Der.certificateExtensions(credCert).get(APPLE_NONCE_OID);
    check(extension !== undefined, "credential certificate has no nonce");
    const [wrapped] = Der.sequence(Der.parse(extension!.value));
    check(wrapped?.cls === Der.CONTEXT && wrapped.tag === 1, "malformed nonce extension");
    const [nonceElement] = Der.children(wrapped!);
    check(equalBytes(Der.octets(nonceElement), nonce), "nonce doesn't bind this key and challenge");
    check(equalBytes(sha256(certificatePoint(chain[0]!)), keyId), "keyId isn't the attested key");

    const rpIdHash = authData.subarray(0, 32);
    check(
      input.trust.appleAppIds.some((appId) => equalBytes(sha256(Buffer.from(appId)), rpIdHash)),
      "app isn't on the allowlist",
    );
    const counter = Buffer.from(authData.subarray(33, 37)).readUInt32BE(0);
    check(counter === 0, "attestation counter isn't 0");
    const aaguid = authData.subarray(37, 53);
    check(
      input.trust.appleEnvironments.some((environment) => equalBytes(AAGUID[environment], aaguid)),
      "App Attest environment isn't allowed",
    );
    const credentialIdLength = Buffer.from(authData.subarray(53, 55)).readUInt16BE(0);
    check(
      equalBytes(authData.subarray(55, 55 + credentialIdLength), keyId),
      "credential id isn't keyId",
    );
    return { attested: true, hardware: "secure_enclave" };
  });
}
