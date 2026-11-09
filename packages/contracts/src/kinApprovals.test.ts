import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  BranchName,
  KinApprovalsRegisterKeyInput,
  KinApproverPublicJwk,
  KinContentPath,
} from "./kinApprovals.ts";

const accepts = (schema: Schema.Top, value: unknown) =>
  Schema.is(schema as Schema.Codec<unknown>)(value);

describe("approval names", () => {
  it.each(["main", "feature/kin-1", "release/v1.2", "a+b_c-d"])("accepts branch %s", (name) => {
    expect(accepts(BranchName, name)).toBe(true);
  });
  it.each([
    "../../x",
    "x/../y",
    "/main",
    "main/",
    "a//b",
    ".hidden",
    "a/.b",
    "x.lock",
    "a/b.lock",
    "main.",
  ])("refuses branch %s", (name) => {
    expect(accepts(BranchName, name)).toBe(false);
  });
  it.each(["rules.md", "memory/people/priya.md", ".kin/rules.md"])("accepts path %s", (path) => {
    expect(accepts(KinContentPath, path)).toBe(true);
  });
  it.each(["../../.ssh/authorized_keys", "a/../b", "/etc/passwd", "a//b", "./rules.md", "a/"])(
    "refuses path %s",
    (path) => {
      expect(accepts(KinContentPath, path)).toBe(false);
    },
  );
  it("caps each attestation certificate", () => {
    const input = (cert: string) => ({
      orgId: "org_01",
      publicJwk: {
        kty: "EC",
        crv: "P-256",
        x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
        y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0",
      },
      platform: "android",
      challenge: "abc",
      attestation: { format: "android-key", certificateChain: [cert] },
      deviceLabel: "Phone",
    });
    const decode = Schema.decodeUnknownExit(KinApprovalsRegisterKeyInput);
    expect(decode(input("A".repeat(8192)))._tag).toBe("Success");
    expect(decode(input("A".repeat(8193)))._tag).toBe("Failure");
  });
});

describe("KinApproverPublicJwk", () => {
  it("accepts only the canonical spelling of each coordinate", () => {
    const is = Schema.is(KinApproverPublicJwk);
    const jwk = {
      kty: "EC",
      crv: "P-256",
      x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
      y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0",
    };
    expect(is(jwk)).toBe(true);
    // "U" and "V" differ only in a padding bit: the same 32 bytes under a second thumbprint.
    expect(is({ ...jwk, x: `${jwk.x.slice(0, 42)}V` })).toBe(false);
  });
});
