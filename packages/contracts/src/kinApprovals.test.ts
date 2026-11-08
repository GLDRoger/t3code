import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { KinApproverPublicJwk } from "./kinApprovals.ts";

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
