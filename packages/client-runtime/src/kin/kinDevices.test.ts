// @effect-diagnostics globalDate:off - Fixtures build ISO times relative to a fixed clock.
import {
  AuthSessionId,
  EnvironmentId,
  KinInviteId,
  type ExecutionEnvironmentDescriptor,
  type KinPersonDevice,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { describe, expect, it } from "@effect/vitest";

import { BearerConnectionCredential, type ConnectionCredential } from "../connection/catalog.ts";
import { ConnectionCredentialStore } from "../connection/credentialStore.ts";
import { BearerConnectionTarget, type PreparedConnection } from "../connection/model.ts";

import {
  renewKinTeammateDevice,
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

describe("renewKinTeammateDevice", () => {
  const environmentId = EnvironmentId.make("kin-host");
  const prepared = (served: string): PreparedConnection => ({
    environmentId,
    label: "Kin",
    httpBaseUrl: "http://192.168.1.20:3774",
    socketUrl: "ws://192.168.1.20:3774/ws",
    httpAuthorization: { _tag: "Bearer", token: "old" },
    target: new BearerConnectionTarget({ environmentId, label: "Kin", connectionId: "kin" }),
    descriptor: { environmentId: EnvironmentId.make(served) } as ExecutionEnvironmentDescriptor,
  });
  const run = Effect.fn("test.renew")(function* (
    connection: PreparedConnection,
    onRequest: (stored: Map<string, ConnectionCredential>) => void = () => undefined,
  ) {
    const stored = new Map<string, ConnectionCredential>([
      ["kin", new BearerConnectionCredential({ token: "old" })],
    ]);
    const authorized: Array<string> = [];
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        authorized.push(request.headers.authorization ?? "");
        onRequest(stored);
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ accessToken: "new", expiresAt: "2026-12-18T10:00:00.000Z" }),
        );
      }),
    );
    const renewed = yield* renewKinTeammateDevice(connection).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.provideService(
        ConnectionCredentialStore,
        ConnectionCredentialStore.of({
          get: (id) => Effect.sync(() => Option.fromNullishOr(stored.get(id))),
          put: (id, credential) => Effect.sync(() => void stored.set(id, credential)),
          remove: (id) => Effect.sync(() => void stored.delete(id)),
        }),
      ),
    );
    const token = (stored.get("kin") as BearerConnectionCredential | undefined)?.token;
    return [renewed, authorized, token] as const;
  });

  it.effect("renews through the prepared connection and keeps the new token", () =>
    Effect.map(run(prepared("kin-host")), (result) =>
      expect(result).toEqual([true, ["Bearer old"], "new"]),
    ),
  );

  it.effect("sends nothing when the address now answers as another environment", () =>
    Effect.map(run(prepared("someone-else")), (result) =>
      expect(result).toEqual([false, [], "old"]),
    ),
  );

  it.effect("keeps a re-join's token that landed while the renewal was out", () =>
    Effect.map(
      run(prepared("kin-host"), (stored) =>
        stored.set("kin", new BearerConnectionCredential({ token: "rejoined" })),
      ),
      (result) => expect(result).toEqual([false, ["Bearer old"], "rejoined"]),
    ),
  );
});
