// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no KeyObject, generateKeyPairSync, or sign.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- reads the APPR-6 fixture synchronously at collection time.
import * as NodeFS from "node:fs";

import { assert, describe, it } from "@effect/vitest";
import type { KinApproverPublicJwk, KinGrantHeader, KinGrantPayload } from "@t3tools/contracts";

import { computeDpopJwkThumbprint } from "./dpop.ts";
import {
  decodeKinGrant,
  encodeGrantSigningInput,
  verifyKinGrant,
  type KinGrantVerification,
} from "./kinGrant.ts";
import { stableStringify } from "./relaySigning.ts";

const P256_N = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
const NOW = 1_798_761_600;

function makeKey() {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const publicJwk = { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y } as KinApproverPublicJwk;
  return { privateKey, publicJwk, kid: computeDpopJwkThumbprint(publicJwk) };
}

const toBigInt = (bytes: Uint8Array) => BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
const fromBigInt = (value: bigint) => Buffer.from(value.toString(16).padStart(64, "0"), "hex");

/** r‖s with s forced low or high; Node itself returns either. */
function signRaw(privateKey: NodeCrypto.KeyObject, signingInput: string, high = false) {
  const raw = NodeCrypto.sign("sha256", Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  const s = toBigInt(raw.subarray(32));
  const low = s > P256_N / 2n ? P256_N - s : s;
  return Buffer.concat([raw.subarray(0, 32), fromBigInt(high ? P256_N - low : low)]).toString(
    "base64url",
  );
}

const b64 = (text: string) => Buffer.from(text).toString("base64url");
const signText = (privateKey: NodeCrypto.KeyObject, header: string, payload: string) => {
  const input = `${b64(header)}.${b64(payload)}`;
  return `${input}.${signRaw(privateKey, input)}`;
};

function grantFor(kid: string, overrides: Partial<KinGrantPayload> = {}) {
  const header = { typ: "kin-grant+jws", alg: "ES256", kid } as KinGrantHeader;
  const payload = {
    v: 1,
    orgId: "org_01",
    actionId: "act_01JD7Z00000000000000000000",
    revision: 2,
    nonce: "c2VydmVyLW5vbmNlLTMyLWJ5dGVzLWJhc2U2NHVybA",
    jti: "ZGV2aWNlLWp0aS0xNi1ieXRlcw",
    kind: "merge_pull_request",
    targetDigest: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    target: {
      _tag: "pull_request",
      host: "github.com",
      repo: "GLDRoger/t3code",
      number: 212,
      mergeMethod: "squash",
      deleteBranchAfter: false,
    },
    headSha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    base: "main",
    mergeMethod: "squash",
    approver: { humanId: "h_owner", kid },
    decision: "approve",
    iat: NOW - 10,
    exp: NOW + 590,
    ...overrides,
  } as KinGrantPayload;
  return { header, payload };
}

function signedGrant(key: ReturnType<typeof makeKey>, overrides: Partial<KinGrantPayload> = {}) {
  const { header, payload } = grantFor(key.kid, overrides);
  const signingInput = encodeGrantSigningInput(header, payload);
  return {
    header,
    payload,
    signingInput,
    compact: `${signingInput}.${signRaw(key.privateKey, signingInput)}`,
  };
}

describe("verifyKinGrant", () => {
  const key = makeKey();
  const verify = (compact: string, nowEpochSeconds = NOW, publicJwk = key.publicJwk) =>
    verifyKinGrant({ compact, publicJwk, nowEpochSeconds });

  it("accepts a grant signed with a P-256 key and returns its payload", () => {
    const { compact, payload } = signedGrant(key);
    const result = verify(compact);
    assert.isTrue(result.ok);
    if (result.ok) assert.deepStrictEqual(result.grant.payload, payload);
  });

  it("signs canonical JSON with sorted keys in both parts", () => {
    const { signingInput } = signedGrant(key);
    const [header, payload] = signingInput.split(".") as [string, string];
    assert.strictEqual(
      Buffer.from(header, "base64url").toString(),
      `{"alg":"ES256","kid":"${key.kid}","typ":"kin-grant+jws"}`,
    );
    assert.match(Buffer.from(payload, "base64url").toString(), /^\{"actionId":.*,"v":1\}$/);
  });

  it("rejects tampering with typed reasons", () => {
    const other = makeKey();
    const { compact, payload, signingInput } = signedGrant(key);
    const [headerPart, , signature] = compact.split(".") as [string, string, string];
    const headerText = Buffer.from(headerPart, "base64url").toString();
    const jwkHeader = stableStringify({ ...JSON.parse(headerText), jwk: key.publicJwk });
    const sortedPayload = Buffer.from(signingInput.split(".")[1]!, "base64url").toString();

    const cases: ReadonlyArray<
      readonly [string, string, Extract<KinGrantVerification, { ok: false }>["reason"], number?]
    > = [
      [
        "a payload byte",
        `${headerPart}.${b64(sortedPayload.replace("212", "213"))}.${signature}`,
        "bad_signature",
      ],
      ["a header carrying a jwk", signText(key.privateKey, jwkHeader, sortedPayload), "malformed"],
      [
        "the wrong typ",
        signText(key.privateKey, headerText.replace("kin-grant+jws", "dpop+jwt"), sortedPayload),
        "malformed",
      ],
      [
        "non-canonical whitespace",
        signText(key.privateKey, headerText, JSON.stringify(JSON.parse(sortedPayload), null, 1)),
        "malformed",
      ],
      [
        "unsorted payload keys",
        signText(
          key.privateKey,
          headerText,
          JSON.stringify({ v: 1, ...JSON.parse(sortedPayload) }),
        ),
        "malformed",
      ],
      [
        "approver.kid differing from the header kid",
        signedGrant(key, { approver: { humanId: payload.approver.humanId, kid: other.kid } })
          .compact,
        "unknown_key",
      ],
      [
        "a high-S twin of a valid signature",
        `${signingInput}.${signRaw(key.privateKey, signingInput, true)}`,
        "bad_signature",
      ],
      ["an expired grant", compact, "time_window", payload.exp],
      ["an iat more than 300 s off", compact, "time_window", payload.iat + 301],
      [
        "exp more than 900 s after iat",
        signedGrant(key, { exp: NOW - 10 + 901 }).compact,
        "time_window",
      ],
      ["exp not after iat", signedGrant(key, { exp: NOW - 10 }).compact, "time_window"],
      [
        "exp already past, with iat and lifetime in range",
        signedGrant(key, { iat: NOW - 100, exp: NOW + 50 }).compact,
        "time_window",
        NOW + 100,
      ],
      [
        "exp before iat, with now before both",
        signedGrant(key, { iat: NOW + 100, exp: NOW + 50 }).compact,
        "time_window",
      ],
      ["a clock that isn't a number", compact, "time_window", Number.NaN],
      [
        "an id that decodes differently from its signed bytes",
        signedGrant(key, { orgId: " org_01" as KinGrantPayload["orgId"] }).compact,
        "malformed",
      ],
      [
        "an extra field nested in approver",
        signText(
          key.privateKey,
          headerText,
          stableStringify({ ...payload, approver: { ...payload.approver, extra: "x" } }),
        ),
        "malformed",
      ],
    ];
    for (const [name, tampered, reason, now] of cases) {
      assert.deepStrictEqual(verify(tampered, now), { ok: false, reason }, name);
    }
  });

  it("rejects a grant checked against another key", () => {
    assert.deepStrictEqual(verify(signedGrant(key).compact, NOW, makeKey().publicJwk), {
      ok: false,
      reason: "unknown_key",
    });
  });

  it("rejects a valid signature from a key whose thumbprint is in the header but not the signer", () => {
    const other = makeKey();
    const { signingInput } = signedGrant(key);
    assert.deepStrictEqual(verify(`${signingInput}.${signRaw(other.privateKey, signingInput)}`), {
      ok: false,
      reason: "bad_signature",
    });
  });
});

type GrantVector = {
  readonly name: string;
  readonly header?: string;
  readonly payload?: string;
  readonly signingInput?: string;
  readonly error?: string;
};

describe("APPR-6 grant vectors", () => {
  const vectors: { readonly now: number; readonly cases: ReadonlyArray<GrantVector> } = JSON.parse(
    NodeFS.readFileSync(
      new URL(
        "../../../apps/mobile/modules/kin-approval-key/fixtures/grant-vectors.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const zeroSignature = Buffer.alloc(64).toString("base64url");
  // Where the server's decoder rightly differs from the device's parser.
  const DEVICE_ONLY = new Set([
    // Prompt length is a display rule; the server shows no prompt.
    "a long repo and branch over 200 characters are refused",
    "a prompt of 201 characters is refused, not cut",
    // Time windows fail in verifyKinGrant as time_window, not in the decoder.
    "exp more than 900 s after iat",
    "exp not after iat",
    "iat 301 s ahead of the device clock",
  ]);

  it("encodes every accepted grant to the exact bytes the device signs", () => {
    for (const vector of vectors.cases.filter((c) => !c.error)) {
      const input = encodeGrantSigningInput(
        JSON.parse(vector.header!),
        JSON.parse(vector.payload!),
      );
      assert.strictEqual(input, `${b64(vector.header!)}.${b64(vector.payload!)}`, vector.name);
    }
  });

  it("decodes what the device signs and refuses what it refuses", () => {
    for (const vector of vectors.cases) {
      const input = vector.signingInput ?? `${b64(vector.header!)}.${b64(vector.payload!)}`;
      const decoded = decodeKinGrant(`${input}.${zeroSignature}`) !== null;
      const expected = DEVICE_ONLY.has(vector.name) || !vector.error;
      assert.strictEqual(decoded, expected, vector.name);
    }
  });
});
