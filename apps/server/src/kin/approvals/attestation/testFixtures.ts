// @effect-diagnostics nodeBuiltinImport:off -- test certificates are built and signed with node:crypto.
import * as NodeCrypto from "node:crypto";

import type { KinApproverPublicJwk } from "@t3tools/contracts";

import type { AttestationTrust } from "./verify.ts";

const length = (n: number) =>
  n < 0x80
    ? [n]
    : n < 0x100
      ? [0x81, n]
      : n < 0x10000
        ? [0x82, n >> 8, n & 0xff]
        : [0x83, n >> 16, (n >> 8) & 0xff, n & 0xff];
const tlv = (identifier: ReadonlyArray<number>, content: Uint8Array) =>
  new Uint8Array([...identifier, ...length(content.length), ...content]);
const concat = (parts: ReadonlyArray<Uint8Array>) =>
  new Uint8Array(parts.flatMap((part) => [...part]));

const der = {
  seq: (...parts: ReadonlyArray<Uint8Array>) => tlv([0x30], concat(parts)),
  set: (...parts: ReadonlyArray<Uint8Array>) => tlv([0x31], concat(parts)),
  int: (n: number) => {
    const bytes: number[] = [];
    let rest = n;
    do {
      bytes.unshift(rest % 256);
      rest = Math.floor(rest / 256);
    } while (rest > 0);
    if (bytes[0]! & 0x80) bytes.unshift(0);
    return tlv([0x02], new Uint8Array(bytes));
  },
  serial: (bytes: Uint8Array) =>
    tlv([0x02], bytes[0]! & 0x80 ? new Uint8Array([0, ...bytes]) : bytes),
  enumerated: (n: number) => tlv([0x0a], new Uint8Array([n])),
  bool: (value: boolean) => tlv([0x01], new Uint8Array([value ? 0xff : 0])),
  null: () => tlv([0x05], new Uint8Array()),
  octet: (bytes: Uint8Array) => tlv([0x04], bytes),
  utf8: (text: string) => tlv([0x0c], new Uint8Array(Buffer.from(text))),
  bits: (bytes: Uint8Array) => tlv([0x03], new Uint8Array([0, ...bytes])),
  utcTime: (text: string) => tlv([0x17], new Uint8Array(Buffer.from(text))),
  oid: (dotted: string) => {
    const [a, b, ...rest] = dotted.split(".").map(Number);
    const out = [a! * 40 + b!];
    for (const arc of rest) {
      const chunk = [arc & 0x7f];
      let value = arc >> 7;
      while (value > 0) {
        chunk.unshift((value & 0x7f) | 0x80);
        value >>= 7;
      }
      out.push(...chunk);
    }
    return tlv([0x06], new Uint8Array(out));
  },
  /** `[tag] EXPLICIT`, high tag numbers included. */
  explicit: (tag: number, inner: Uint8Array) => {
    if (tag < 31) return tlv([0xa0 | tag], inner);
    const digits = [tag & 0x7f];
    for (let value = tag >> 7; value > 0; value >>= 7) digits.unshift((value & 0x7f) | 0x80);
    return tlv([0xbf, ...digits], inner);
  },
};

type KeyPair = {
  readonly publicKey: NodeCrypto.KeyObject;
  readonly privateKey: NodeCrypto.KeyObject;
};
export const newKey = (): KeyPair => NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });

const name = (cn: string) => der.seq(der.set(der.seq(der.oid("2.5.4.3"), der.utf8(cn))));
const ECDSA_SHA256 = der.seq(der.oid("1.2.840.10045.4.3.2"));

export type CertificateSpec = {
  readonly subject: string;
  readonly issuer: string;
  readonly subjectKey: NodeCrypto.KeyObject;
  readonly issuerKey: NodeCrypto.KeyObject;
  readonly ca?: boolean;
  readonly extensions?: ReadonlyArray<{ readonly oid: string; readonly value: Uint8Array }>;
  readonly notBefore?: string;
  readonly notAfter?: string;
  readonly serial?: Uint8Array;
};

function certificate(spec: CertificateSpec): Uint8Array {
  const extensions = [
    ...(spec.ca
      ? [der.seq(der.oid("2.5.29.19"), der.bool(true), der.octet(der.seq(der.bool(true))))]
      : []),
    ...(spec.extensions ?? []).map((extension) =>
      der.seq(der.oid(extension.oid), der.octet(extension.value)),
    ),
  ];
  const tbs = der.seq(
    der.explicit(0, der.int(2)),
    der.serial(spec.serial ?? new Uint8Array(NodeCrypto.randomBytes(8))),
    ECDSA_SHA256,
    name(spec.issuer),
    der.seq(
      der.utcTime(spec.notBefore ?? "250101000000Z"),
      der.utcTime(spec.notAfter ?? "400101000000Z"),
    ),
    name(spec.subject),
    new Uint8Array(spec.subjectKey.export({ type: "spki", format: "der" })),
    ...(extensions.length > 0 ? [der.explicit(3, der.seq(...extensions))] : []),
  );
  const signature = NodeCrypto.sign("sha256", tbs, spec.issuerKey);
  return der.seq(tbs, ECDSA_SHA256, der.bits(new Uint8Array(signature)));
}

const publicJwkOf = (key: NodeCrypto.KeyObject): KinApproverPublicJwk => {
  const jwk = key.export({ format: "jwk" });
  return { kty: "EC", crv: "P-256", x: jwk.x!, y: jwk.y! };
};
const point = (key: NodeCrypto.KeyObject) => {
  const jwk = key.export({ format: "jwk" });
  return new Uint8Array([
    4,
    ...Buffer.from(jwk.x!, "base64url"),
    ...Buffer.from(jwk.y!, "base64url"),
  ]);
};
const sha256 = (...parts: ReadonlyArray<Uint8Array>) => {
  const hash = NodeCrypto.createHash("sha256");
  for (const part of parts) hash.update(part);
  return new Uint8Array(hash.digest());
};
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

const ANDROID_PACKAGE = "com.gldroger.kin";
const ANDROID_SIGNER = "ab".repeat(32);
const APPLE_APP_ID = "TEAM123456.com.gldroger.kin";

export function makeTrustFixture() {
  const googleRoot = newKey();
  const appleRoot = newKey();
  const googleRootDer = certificate({
    subject: "Test Google Root",
    issuer: "Test Google Root",
    subjectKey: googleRoot.publicKey,
    issuerKey: googleRoot.privateKey,
    ca: true,
  });
  const appleRootDer = certificate({
    subject: "Test Apple Root",
    issuer: "Test Apple Root",
    subjectKey: appleRoot.publicKey,
    issuerKey: appleRoot.privateKey,
    ca: true,
  });
  const trust: AttestationTrust = {
    googleRoots: [new NodeCrypto.X509Certificate(googleRootDer)],
    androidRevokedSerials: new Set(),
    androidApps: [{ packageName: ANDROID_PACKAGE, signingCertSha256: [ANDROID_SIGNER] }],
    appleRoot: new NodeCrypto.X509Certificate(appleRootDer),
    appleAppIds: [APPLE_APP_ID],
    appleEnvironments: ["production"],
  };
  return { trust, googleRoot, googleRootDer, appleRoot };
}
export type TrustFixture = ReturnType<typeof makeTrustFixture>;

export type KeyDescriptionSpec = {
  readonly attestationLevel?: number;
  readonly keyMintLevel?: number;
  readonly challenge: Uint8Array;
  readonly purposes?: ReadonlyArray<number>;
  readonly algorithm?: number;
  readonly ecCurve?: number;
  readonly digests?: ReadonlyArray<number>;
  readonly userAuthType?: number;
  readonly authTimeout?: number;
  readonly noAuthRequiredInSoftware?: boolean;
  readonly origin?: number;
  readonly deviceLocked?: boolean;
  readonly bootState?: number;
  readonly packages?: ReadonlyArray<string>;
  readonly signers?: ReadonlyArray<string>;
};

function keyDescription(spec: KeyDescriptionSpec): Uint8Array {
  const appId = der.seq(
    der.set(
      ...(spec.packages ?? [ANDROID_PACKAGE]).map((pkg) =>
        der.seq(der.octet(new Uint8Array(Buffer.from(pkg))), der.int(7)),
      ),
    ),
    der.set(
      ...(spec.signers ?? [ANDROID_SIGNER]).map((hex) =>
        der.octet(new Uint8Array(Buffer.from(hex, "hex"))),
      ),
    ),
  );
  const software = der.seq(
    ...(spec.noAuthRequiredInSoftware ? [der.explicit(503, der.null())] : []),
    der.explicit(709, der.octet(appId)),
  );
  const hardware = der.seq(
    der.explicit(1, der.set(...(spec.purposes ?? [2]).map(der.int))),
    der.explicit(2, der.int(spec.algorithm ?? 3)),
    der.explicit(3, der.int(256)),
    der.explicit(5, der.set(...(spec.digests ?? [4]).map(der.int))),
    der.explicit(10, der.int(spec.ecCurve ?? 1)),
    der.explicit(504, der.int(spec.userAuthType ?? 2)),
    ...(spec.authTimeout === undefined ? [] : [der.explicit(505, der.int(spec.authTimeout))]),
    der.explicit(702, der.int(spec.origin ?? 0)),
    der.explicit(
      704,
      der.seq(
        der.octet(new Uint8Array(32)),
        der.bool(spec.deviceLocked ?? true),
        der.enumerated(spec.bootState ?? 0),
        der.octet(new Uint8Array(32)),
      ),
    ),
  );
  return der.seq(
    der.int(300),
    der.enumerated(spec.attestationLevel ?? 2),
    der.int(300),
    der.enumerated(spec.keyMintLevel ?? 2),
    der.octet(spec.challenge),
    der.octet(new Uint8Array()),
    software,
    hardware,
  );
}

export type AndroidChainSpec = KeyDescriptionSpec & {
  /** The approval key the leaf certifies; a fresh one when omitted. */
  readonly approvalKey?: KeyPair;
  readonly descriptionInIntermediate?: boolean;
  readonly leafSignedByStranger?: boolean;
  readonly leafNotAfter?: string;
  readonly leafSerial?: Uint8Array;
  readonly root?: KeyPair;
};

export function androidChain(fixture: TrustFixture, spec: AndroidChainSpec) {
  const approvalKey = spec.approvalKey ?? newKey();
  const root = spec.root ?? fixture.googleRoot;
  const rootDer = spec.root
    ? certificate({
        subject: "Other Root",
        issuer: "Other Root",
        subjectKey: root.publicKey,
        issuerKey: root.privateKey,
        ca: true,
      })
    : fixture.googleRootDer;
  const intermediate = newKey();
  const description = { oid: "1.3.6.1.4.1.11129.2.1.17", value: keyDescription(spec) };
  const intermediateDer = certificate({
    subject: "Test Attestation Intermediate",
    issuer: spec.root ? "Other Root" : "Test Google Root",
    subjectKey: intermediate.publicKey,
    issuerKey: root.privateKey,
    ca: true,
    ...(spec.descriptionInIntermediate ? { extensions: [description] } : {}),
  });
  const leafDer = certificate({
    subject: "Android Keystore Key",
    issuer: "Test Attestation Intermediate",
    subjectKey: approvalKey.publicKey,
    issuerKey: spec.leafSignedByStranger ? newKey().privateKey : intermediate.privateKey,
    extensions: [description],
    ...(spec.leafNotAfter ? { notAfter: spec.leafNotAfter } : {}),
    ...(spec.leafSerial ? { serial: spec.leafSerial } : {}),
  });
  return {
    publicJwk: publicJwkOf(approvalKey.publicKey),
    approvalKey,
    certificateChain: [leafDer, intermediateDer, rootDer].map(b64),
  };
}

const cborHead = (major: number, n: number) =>
  n < 24
    ? [(major << 5) | n]
    : n < 0x100
      ? [(major << 5) | 24, n]
      : [(major << 5) | 25, n >> 8, n & 0xff];
const cbor = {
  bytes: (value: Uint8Array) => new Uint8Array([...cborHead(2, value.length), ...value]),
  text: (value: string) => {
    const bytes = Buffer.from(value);
    return new Uint8Array([...cborHead(3, bytes.length), ...bytes]);
  },
  array: (items: ReadonlyArray<Uint8Array>) =>
    new Uint8Array([...cborHead(4, items.length), ...concat(items)]),
  map: (entries: ReadonlyArray<readonly [string, Uint8Array]>) =>
    new Uint8Array([
      ...cborHead(5, entries.length),
      ...concat(entries.flatMap(([key, value]) => [cbor.text(key), value])),
    ]),
};

export type AppleSpec = {
  readonly challenge: Uint8Array;
  readonly approvalKey?: KeyPair;
  /** The key the nonce binds, when it differs from the registered one. */
  readonly boundKey?: KeyPair;
  readonly appId?: string;
  readonly counter?: number;
  readonly aaguid?: string;
  readonly wrongKeyId?: boolean;
  readonly root?: KeyPair;
};

export function appleAttestation(fixture: TrustFixture, spec: AppleSpec) {
  const approvalKey = spec.approvalKey ?? newKey();
  const appAttestKey = newKey();
  const keyId = sha256(point(appAttestKey.publicKey));
  const aaguid = Buffer.alloc(16);
  Buffer.from(spec.aaguid ?? "appattest").copy(aaguid);
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(spec.counter ?? 0);
  const authData = new Uint8Array([
    ...sha256(Buffer.from(spec.appId ?? APPLE_APP_ID)),
    0x40,
    ...counter,
    ...aaguid,
    0,
    32,
    ...keyId,
    0xa0,
  ]);
  const clientDataHash = sha256(spec.challenge, point((spec.boundKey ?? approvalKey).publicKey));
  const nonce = sha256(authData, clientDataHash);
  const root = spec.root ?? fixture.appleRoot;
  const intermediate = newKey();
  const intermediateDer = certificate({
    subject: "Test App Attest CA",
    issuer: "Test Apple Root",
    subjectKey: intermediate.publicKey,
    issuerKey: root.privateKey,
    ca: true,
  });
  const credCert = certificate({
    subject: "App Attest Key",
    issuer: "Test App Attest CA",
    subjectKey: appAttestKey.publicKey,
    issuerKey: intermediate.privateKey,
    extensions: [
      { oid: "1.2.840.113635.100.8.2", value: der.seq(der.explicit(1, der.octet(nonce))) },
    ],
  });
  const attestationObject = cbor.map([
    ["fmt", cbor.text("apple-appattest")],
    [
      "attStmt",
      cbor.map([
        ["x5c", cbor.array([cbor.bytes(credCert), cbor.bytes(intermediateDer)])],
        ["receipt", cbor.bytes(new Uint8Array([1]))],
      ]),
    ],
    ["authData", cbor.bytes(authData)],
  ]);
  return {
    publicJwk: publicJwkOf(approvalKey.publicKey),
    approvalKey,
    keyId: b64(spec.wrongKeyId ? sha256(keyId) : keyId),
    attestationObject: b64(attestationObject),
  };
}
