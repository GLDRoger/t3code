import { describe, expect, it } from "vite-plus/test";

import { kinGate, kinPermission } from "./kinAccess.ts";

describe("kinPermission", () => {
  it.each([
    ["scopes not known yet", false, false, undefined, "owner_level", "unknown"],
    ["scopes not known yet, for a call anyone may make", false, false, null, "person", "unknown"],
    ["scopes known and lacking", true, false, "owner", "owner_level", "refused"],
    ["a call anyone may make", true, true, undefined, "person", "granted"],
    ["kind not known yet", true, true, undefined, "owner_level", "unknown"],
    ["the owner", true, true, "owner", "org_owner", "granted"],
    ["a co-owner on an owner-level call", true, true, "co_owner", "owner_level", "granted"],
    ["a co-owner on an owner-only call", true, true, "co_owner", "org_owner", "refused"],
    ["a member", true, true, "member", "owner_level", "refused"],
    ["someone the host has no kind for", true, true, null, "owner_level", "refused"],
  ] as const)("%s", (_name, sessionKnown, scopesGranted, kind, access, expected) => {
    expect(kinPermission({ sessionKnown, scopesGranted, kind, access, failed: false })).toBe(
      expected,
    );
  });

  it.each([
    ["the scopes' read failed", false, false, undefined, "person", "failed"],
    ["the kind's read failed", true, true, undefined, "owner_level", "failed"],
    [
      "the kind's read failed on a call anyone may make",
      true,
      true,
      undefined,
      "person",
      "granted",
    ],
    [
      "a read failed, but the scopes already lack it",
      true,
      false,
      undefined,
      "owner_level",
      "refused",
    ],
  ] as const)("%s", (_name, sessionKnown, scopesGranted, kind, access, expected) => {
    expect(kinPermission({ sessionKnown, scopesGranted, kind, access, failed: true })).toBe(
      expected,
    );
  });
});

describe("kinGate", () => {
  it.each([
    ["unknown", "connecting", "loading"],
    ["unknown", "connected", "loading"],
    ["unknown", "offline", "offline"],
    ["failed", "connected", "failed"],
    ["failed", "connecting", "failed"],
    ["failed", "offline", "offline"],
    ["refused", "connecting", "refused"],
    ["refused", "offline", "refused"],
    ["granted", "connecting", null],
    ["granted", "offline", null],
  ] as const)("a permission %s on a link %s shows %s", (permission, link, gate) => {
    expect(kinGate(permission, link)).toBe(gate);
  });
});
