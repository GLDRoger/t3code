// @effect-diagnostics globalDate:off - Fixtures build ISO times relative to a fixed clock.
import { AuthSessionId, KinInviteId, type KinPersonDevice } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  kinActiveDevices,
  kinDeviceJustLinked,
  kinDeviceLinkLeft,
  kinDevicesLinkedFrom,
  kinRemoveDeviceCopy,
} from "./kinDevices.ts";

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

describe("kinDeviceJustLinked", () => {
  const link = KinInviteId.make("link-2");
  it.each([
    [
      "names the device that joined with this link",
      "new",
      [device("old", { linkId: KinInviteId.make("link-1") }), device("new", { linkId: link })],
    ],
    [
      "never another device, however recent",
      null,
      [device("other", { boundAt: "2026-11-18T09:59:00.000Z" })],
    ],
  ] as const)("%s", (_name, label, devices) => {
    expect(kinDeviceJustLinked(devices, link)?.label ?? null).toBe(label);
  });
});

describe("kinRemoveDeviceCopy", () => {
  it("names the devices under one that already lapsed, and not the lapsed one", () => {
    const devices = [
      device("phone"),
      device("tablet", {
        linkedFrom: AuthSessionId.make("phone"),
        expiresAt: "2026-11-10T09:00:00.000Z",
      }),
      device("laptop", { linkedFrom: AuthSessionId.make("tablet") }),
    ];
    expect(kinRemoveDeviceCopy(devices[0]!, true, devices, now).detail).toContain(
      " laptop, linked from it, is signed out too.",
    );
  });

  it.each([
    ["no key", undefined, undefined, undefined, null],
    ["none left", 0, 0, 0, null],
    ["one key", 1, undefined, undefined, "This also ends the coding-agent key made on it."],
    ["two keys", 2, 0, 0, "This also ends the coding-agent keys made on it."],
    ["one below", 0, 1, 0, "This also ends the coding-agent key made on these devices."],
    ["here and below", 1, 2, 0, "This also ends the coding-agent keys made on these devices."],
    [
      "only on one signed out below",
      0,
      0,
      1,
      "This also ends the coding-agent key made on it or on devices linked from it.",
    ],
    [
      "here and on one signed out below",
      1,
      undefined,
      1,
      "This also ends the coding-agent keys made on it or on devices linked from it.",
    ],
  ] as const)(
    "says the keys it ends only when it made some: %s",
    (_name, keysMade, belowMade, lapsedMade, sentence) => {
      const phone = device("phone", keysMade === undefined ? {} : { keysMade });
      const laptop = device("laptop", {
        linkedFrom: phone.sessionId,
        ...(belowMade === undefined ? {} : { keysMade: belowMade }),
      });
      // Run out already: the dialog doesn't name it, but its keys end too.
      const old = device("old", {
        linkedFrom: phone.sessionId,
        expiresAt: "2026-11-10T09:00:00.000Z",
        ...(lapsedMade === undefined ? {} : { keysMade: lapsedMade }),
      });
      const detail = kinRemoveDeviceCopy(phone, true, [phone, laptop, old], now).detail;
      expect(detail.match(/This also ends .*?\./)?.[0] ?? null).toBe(sentence);
    },
  );
});

describe("kinDevicesLinkedFrom", () => {
  it("finds every device down the line, and none above or beside", () => {
    const devices = [
      device("phone"),
      device("laptop", { linkedFrom: AuthSessionId.make("phone") }),
      device("tablet", { linkedFrom: AuthSessionId.make("laptop") }),
      device("watch", { linkedFrom: AuthSessionId.make("phone") }),
    ];
    expect(kinDevicesLinkedFrom(devices[1]!, devices).map((held) => held.label)).toEqual([
      "tablet",
    ]);
    expect(kinDevicesLinkedFrom(devices[0]!, devices).map((held) => held.label)).toEqual([
      "laptop",
      "tablet",
      "watch",
    ]);
  });
});
