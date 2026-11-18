// @effect-diagnostics globalDate:off - Fixtures build ISO times relative to a fixed clock.
import { AuthSessionId, type KinPersonDevice } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { kinActiveDevices, kinDeviceLinkLeft } from "./kinDevices.ts";

const now = Date.parse("2026-11-18T10:00:00Z");
const device = (id: string, change: Partial<KinPersonDevice> = {}): KinPersonDevice => ({
  sessionId: AuthSessionId.make(id),
  label: id,
  deviceType: "mobile",
  boundAt: "2026-11-01T09:00:00.000Z",
  expiresAt: "2026-12-01T09:00:00.000Z",
  revokedAt: null,
  ...change,
});

describe("kinActiveDevices", () => {
  it("keeps signed-in devices, this one first, then the most recently used", () => {
    const devices = [
      device("removed", { revokedAt: "2026-11-10T09:00:00.000Z" }),
      device("ran-out", { expiresAt: "2026-11-18T09:59:00.000Z" }),
      device("no-session", { expiresAt: null }),
      device("old", { lastConnectedAt: "2026-11-02T09:00:00.000Z" }),
      device("recent", { lastConnectedAt: "2026-11-17T09:00:00.000Z" }),
      device("this", { current: true, lastConnectedAt: "2026-11-01T09:00:00.000Z" }),
    ];
    expect(kinActiveDevices(devices, now).map((held) => held.label)).toEqual([
      "this",
      "recent",
      "old",
    ]);
  });
});

describe("kinDeviceLinkLeft", () => {
  it.each([
    [10 * 60_000, false, "10 minutes left"],
    // The minute tick trails the clock, so a fresh code never claims more than its lifetime.
    [10 * 60_000 + 30_000, false, "10 minutes left"],
    [61_000, false, "2 minutes left"],
    [30_000, false, "1 minute left"],
    [0, true, null],
  ] as const)("%d ms before expiry", (before, expired, text) => {
    const left = kinDeviceLinkLeft(new Date(now + before).toISOString(), now);
    expect(left.expired).toBe(expired);
    if (!left.expired) expect(left.text).toContain(text);
  });
});
