import { describe, expect, it } from "@effect/vitest";
import { KinKeyThumbprint, KinOrgId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { keyNoticeBody, kinNoticeDeviceName } from "./executionNotices.ts";

const orgId = Schema.decodeSync(KinOrgId)("org_01");
const thumbprint = Schema.decodeSync(KinKeyThumbprint)(
  "NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs",
);
const change = (deviceLabel: string, kind: "allowed" | "removed" = "allowed") => ({
  orgId,
  thumbprint,
  deviceLabel,
  platform: "ios",
  change: kind,
  at: Date.parse("2026-11-12T09:30:00Z"),
});

describe("key notices", () => {
  it.each([
    ["Nishchay’s iPhone", "Nishchay’s iPhone"],
    ["[Tap here](https://evil.example) to keep it", "Tap here https evil example to keep it"],
    ["**Kin**: all good @owner #general `x`", "Kin all good owner general x"],
    ["evil.example/approve", "evil example approve"],
    ["line\nbreak‮esrever\u0000", "line break esrever"],
    ["<img src=x onerror=alert(1)>", "img src x onerror alert 1"],
    ["   ", "A phone"],
    ["a".repeat(80), "a".repeat(40)],
  ])("a reported name %j shows as %j", (label, shown) => {
    expect(kinNoticeDeviceName(label)).toBe(shown);
  });

  it("names the phone, when, and where to remove it", () => {
    expect(keyNoticeBody(change("[x](https://evil.example)"), "UTC")).toBe(
      '"x https evil example" (iOS) can now approve for Kin. It was allowed on Thu 12 Nov, 09:30 UTC. If that wasn\'t you, remove it in Kin on the web or desktop: Settings, then Approvals.',
    );
    expect(keyNoticeBody(change("Pixel 9", "removed"), "Asia/Kolkata")).toBe(
      '"Pixel 9" (iOS) can no longer approve for Kin. It was removed on Thu 12 Nov, 15:00, and anything it approved that hadn\'t run yet was cancelled.',
    );
  });
});
