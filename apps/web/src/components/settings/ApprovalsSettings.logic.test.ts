import { KinApprovalsListKeysResult } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { approvalPhones } from "./ApprovalsSettings.logic";

const NOW = Date.parse("2026-11-12T09:30:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;
const jwk = {
  kty: "EC",
  crv: "P-256",
  x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
  y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0",
};
const thumb = (n: number) => `${String(n).repeat(43)}`.slice(0, 43);
const key = (n: number, state: string, createdAt: number, extra: object = {}) => ({
  orgId: "org_01",
  thumbprint: thumb(n),
  publicJwk: jwk,
  humanId: "kin-default-owner",
  deviceLabel: `Phone ${n}`,
  platform: "android",
  hardware: "strongbox",
  attested: true,
  state,
  createdAt: iso(createdAt),
  ...extra,
});
const decode = Schema.decodeUnknownSync(KinApprovalsListKeysResult);

describe("approvalPhones", () => {
  it("sorts keys into waiting, allowed and ran out, as of now", () => {
    const result = decode({
      keys: [
        key(1, "active", NOW - 3 * 24 * 60 * MIN, { confirmedAt: iso(NOW - 3 * 24 * 60 * MIN) }),
        key(2, "pending", NOW - MIN),
        // Its request is listed but ended since the list was read.
        key(3, "pending", NOW - 11 * MIN),
        // Ran out within the day; and one from before that, no longer shown.
        key(4, "pending", NOW - 2 * 60 * MIN),
        key(5, "pending", NOW - 25 * 60 * MIN),
        key(6, "pending", NOW - MIN, { attested: false, hardware: "software" }),
        key(7, "revoked", NOW - MIN, { revokedAt: iso(NOW) }),
      ],
      requests: [
        { thumbprint: thumb(2), matchCode: "482913", expiresAt: iso(NOW + 9 * MIN) },
        { thumbprint: thumb(3), matchCode: "100200", expiresAt: iso(NOW - MIN) },
      ],
    });
    const { waiting, allowed, expired } = approvalPhones(result, NOW);
    expect(waiting.map((phone) => [phone.name, phone.matchCode])).toEqual([["Phone 2", "482913"]]);
    expect(allowed.map((phone) => phone.name)).toEqual(["Phone 1"]);
    expect(expired.map((phone) => phone.name)).toEqual(["Phone 3", "Phone 4"]);
  });
});
