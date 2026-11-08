import * as NodeCrypto from "node:crypto";

import { p256 } from "@noble/curves/nist";
import { describe, expect, it, vi } from "vite-plus/test";

import { createKey, isKinApprovalKeyError, sign } from "./index";
import { MalformedDerSignatureError } from "./src/derSignature";

const mocks = vi.hoisted(() => ({
  installed: true,
  signDer: vi.fn<(signingInput: string) => Promise<string>>(),
  createKey: vi.fn<
    (challenge: string) => Promise<{
      publicKey: string;
      hardware: "tee" | "secure_enclave";
      attestationChain?: string[];
      appAttest?: { keyId: string; attestationObject: string };
    }>
  >(),
}));

vi.mock("expo", () => ({
  // expo's CodedError, which can't be imported here without React Native.
  CodedError: class CodedError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
  requireOptionalNativeModule: () =>
    mocks.installed ? { signDer: mocks.signDer, createKey: mocks.createKey } : null,
}));

function setup() {
  mocks.installed = true;
  mocks.signDer.mockReset();
  mocks.createKey.mockReset();
}

const b64 = (value: string | Uint8Array) => Buffer.from(value).toString("base64url");
const signingInput = `${b64('{"alg":"ES256","kid":"k","typ":"kin-grant+jws"}')}.${b64('{"v":1}')}`;

describe("sign", () => {
  it("signs the signing input as given and returns a low-S compact signature", async () => {
    setup();
    const { publicKey, privateKey } = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    mocks.signDer.mockImplementation(async (input) =>
      b64(NodeCrypto.sign("sha256", Buffer.from(input), { key: privateKey, dsaEncoding: "der" })),
    );

    const signature = await sign(signingInput);

    expect(mocks.signDer).toHaveBeenCalledWith(signingInput);
    const raw = publicKey.export({ format: "der", type: "spki" }).subarray(26);
    const digest = NodeCrypto.hash("sha256", signingInput, "buffer");
    expect(
      p256.verify(Buffer.from(signature, "base64url"), digest, raw, {
        prehash: false,
        format: "compact",
        lowS: true,
      }),
    ).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["one part", b64("x")],
    ["three parts", `${signingInput}.${b64("sig")}`],
    ["an empty part", `${b64("x")}.`],
    ["padding", `${b64("x")}==.${b64("y")}`],
    ["standard base64", "a+b.c/d"],
    ["whitespace", ` ${signingInput}`],
  ])("rejects %s before reaching the native module", async (_name, input) => {
    setup();
    await expect(sign(input)).rejects.toThrow("two unpadded base64url parts");
    await expect(sign(input)).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
    expect(mocks.signDer).not.toHaveBeenCalled();
  });

  it("rejects malformed DER from the native module", async () => {
    setup();
    mocks.signDer.mockResolvedValueOnce(b64(new Uint8Array(64).fill(1)));
    await expect(sign(signingInput)).rejects.toThrow(MalformedDerSignatureError);
    mocks.signDer.mockResolvedValueOnce("not base64url!");
    await expect(sign(signingInput)).rejects.toThrow("signature is not base64url");
  });

  it("rejects with E_MODULE_UNAVAILABLE when the build has no native module", async () => {
    setup();
    mocks.installed = false;
    await expect(sign(signingInput)).rejects.toMatchObject({ code: "E_MODULE_UNAVAILABLE" });
  });
});

describe("isKinApprovalKeyError", () => {
  it("is true for the module's codes, from JS or native, and false otherwise", async () => {
    setup();
    const thrown = await sign("").catch((error: unknown) => error);
    expect(isKinApprovalKeyError(thrown) && thrown.code).toBe("E_INVALID_INPUT");
    const native = Object.assign(new Error("busy"), { code: "E_BUSY" });
    mocks.signDer.mockRejectedValueOnce(native);
    const rejected = await sign(signingInput).catch((error: unknown) => error);
    expect(isKinApprovalKeyError(rejected) && rejected.code).toBe("E_BUSY");
    expect(isKinApprovalKeyError(new Error("plain"))).toBe(false);
    expect(isKinApprovalKeyError(Object.assign(new Error("x"), { code: "ERR_OTHER" }))).toBe(false);
    expect(isKinApprovalKeyError({ code: "E_BUSY", message: "not an Error" })).toBe(false);
  });
});

describe("createKey", () => {
  it.each([
    ["15 bytes", b64(new Uint8Array(15))],
    ["129 bytes", b64(new Uint8Array(129))],
    ["padded", Buffer.from(new Uint8Array(32)).toString("base64")],
  ])("refuses an attestation challenge that is %s", async (_name, challenge) => {
    setup();
    await expect(createKey(challenge)).rejects.toThrow("attestationChallenge");
    await expect(createKey(challenge)).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
    expect(mocks.createKey).not.toHaveBeenCalled();
  });

  const challenge = b64(new Uint8Array(32).fill(7));
  const point = p256.getPublicKey(p256.utils.randomPrivateKey(), false);
  const keyId = Buffer.alloc(32, 1).toString("base64");

  it.each([
    [
      "an App Attest object",
      { appAttest: { keyId, attestationObject: "o2NmbXQ=" } },
      {
        attestation: { format: "apple-app-attest", keyId, attestationObject: "o2NmbXQ=" },
      },
    ],
    [
      "a Keystore chain",
      { attestationChain: ["MIIB", "MIIC"] },
      {
        attestation: { format: "android-key", certificateChain: ["MIIB", "MIIC"] },
      },
    ],
    ["no attestation", {}, {}],
  ])("returns %s as the attestation", async (_name, native, expected) => {
    setup();
    mocks.createKey.mockResolvedValueOnce({
      publicKey: b64(point),
      hardware: "secure_enclave",
      ...native,
    });
    const created = await createKey(challenge);
    expect(mocks.createKey).toHaveBeenCalledWith(challenge);
    expect({ ...created, publicJwk: undefined }).toEqual({
      publicJwk: undefined,
      hardware: "secure_enclave",
      ...expected,
    });
  });

  it.each([
    [
      "a keyId that isn't 32 bytes",
      { keyId: Buffer.alloc(16).toString("base64"), attestationObject: "o2NmbXQ=" },
    ],
    [
      "a base64url keyId",
      { keyId: Buffer.alloc(32, 0xff).toString("base64url"), attestationObject: "o2NmbXQ=" },
    ],
    ["an empty attestation object", { keyId, attestationObject: "" }],
  ])("refuses an App Attest result with %s", async (_name, appAttest) => {
    setup();
    mocks.createKey.mockResolvedValueOnce({
      publicKey: b64(point),
      hardware: "secure_enclave",
      appAttest,
    });
    await expect(createKey(challenge)).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
  });
});
