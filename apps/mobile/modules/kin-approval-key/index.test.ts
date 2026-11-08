import * as NodeCrypto from "node:crypto";

import { p256 } from "@noble/curves/nist";
import { describe, expect, it, vi } from "vite-plus/test";

import { createKey, sign } from "./index";
import { MalformedDerSignatureError } from "./src/derSignature";

const mocks = vi.hoisted(() => ({
  signDer: vi.fn<(signingInput: string) => Promise<string>>(),
  createKey:
    vi.fn<
      (
        challenge: string,
      ) => Promise<{ publicKey: string; hardware: "tee"; attestationChain: string[] }>
    >(),
}));

vi.mock("expo", () => ({
  requireOptionalNativeModule: () => ({ signDer: mocks.signDer, createKey: mocks.createKey }),
}));

function setup() {
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
    expect(mocks.signDer).not.toHaveBeenCalled();
  });

  it("rejects malformed DER from the native module", async () => {
    setup();
    mocks.signDer.mockResolvedValueOnce(b64(new Uint8Array(64).fill(1)));
    await expect(sign(signingInput)).rejects.toThrow(MalformedDerSignatureError);
    mocks.signDer.mockResolvedValueOnce("not base64url!");
    await expect(sign(signingInput)).rejects.toThrow("signature is not base64url");
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
    expect(mocks.createKey).not.toHaveBeenCalled();
  });
});
