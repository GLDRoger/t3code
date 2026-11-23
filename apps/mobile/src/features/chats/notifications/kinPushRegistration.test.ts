import { EnvironmentId, KinOrgId, KinPersonId, KinPushError } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createKinPushFence,
  createKinPushRefusals,
  kinPushHost,
  kinPushLeaveOrgs,
  kinPushLeaveNotice,
  kinPushLeaveOutcome,
  kinPushPermissionStep,
  kinPushRegisterInput,
  kinPushToken,
} from "./kinPushRegistration";

const env = EnvironmentId.make("env-1");
const refusal = (reason: KinPushError["reason"]) => new KinPushError({ reason, message: reason });

describe("createKinPushRefusals", () => {
  it("keeps a token registered to someone else out of that org for this person, noting it once", () => {
    const refusals = createKinPushRefusals();
    const target = { environmentId: env, orgId: "org-a", personId: "p-1", token: "abc" };
    expect(refusals.note(target, refusal("registered_to_someone_else"))).toBe(true);
    expect(refusals.isRefused(target)).toBe(true);
    // A later session hits the same answer without logging again.
    expect(refusals.note(target, refusal("registered_to_someone_else"))).toBe(false);
    // Another org, or a new token, still registers.
    expect(refusals.isRefused({ ...target, orgId: "org-b" })).toBe(false);
    expect(refusals.isRefused({ ...target, token: "def" })).toBe(false);
    // So does the same token once another person signs in on that host.
    expect(refusals.isRefused({ ...target, personId: "p-2" })).toBe(false);
  });

  it.each(["unavailable", "disabled", "not_member"] as const)("retries after %s", (reason) => {
    const refusals = createKinPushRefusals();
    const target = { environmentId: env, orgId: "org-a", personId: "p-1", token: "abc" };
    expect(refusals.note(target, refusal(reason))).toBe(false);
    expect(refusals.isRefused(target)).toBe(false);
  });
});

describe("kinPushPermissionStep", () => {
  const undecided = { granted: false, canAskAgain: true };
  it("never prompts on connect; asks only once a Kin moment wants notifications", () => {
    expect(kinPushPermissionStep(undecided, { wanted: false, asked: false })).toBe("wait");
    expect(kinPushPermissionStep(undecided, { wanted: true, asked: false })).toBe("ask");
    expect(kinPushPermissionStep(undecided, { wanted: true, asked: true })).toBe("wait");
  });

  it("registers whenever permission is already granted, and never asks after a refusal", () => {
    const granted = { granted: true, canAskAgain: true };
    expect(kinPushPermissionStep(granted, { wanted: false, asked: false })).toBe("register");
    const refused = { granted: false, canAskAgain: false };
    expect(kinPushPermissionStep(refused, { wanted: true, asked: false })).toBe("wait");
  });
});

describe("kinPushHost", () => {
  const orgs = { orgs: [], me: [] };
  const ready = { _tag: "ready", orgs } as const;
  it("registers with the usual host, never with one standing in for it", () => {
    const usual = { _tag: "host", environmentId: env, connected: true, probe: ready } as const;
    expect(kinPushHost(usual)).toEqual({ environmentId: env, orgs });
    const other = EnvironmentId.make("env-2");
    expect(kinPushHost({ ...usual, environmentId: other, standInFor: env })).toBeNull();
    expect(kinPushHost({ ...usual, connected: false })).toBeNull();
  });
});

describe("kinPushLeaveOrgs", () => {
  const me = (orgId: string) => ({
    orgId: KinOrgId.make(orgId),
    personId: KinPersonId.make(`p-${orgId}`),
  });
  const host = (environmentId: EnvironmentId, orgIds: ReadonlyArray<string>) =>
    ({
      _tag: "host",
      environmentId,
      connected: true,
      probe: { _tag: "ready", orgs: { orgs: [], me: orgIds.map(me) } },
    }) as const;

  it("takes the token back from every org the leaving host names, live or saved", () => {
    const cached = { orgs: [], me: [me("org-b"), me("org-c")] };
    expect(kinPushLeaveOrgs(host(env, ["org-a", "org-b"]), env, cached)).toEqual([
      "org-a",
      "org-b",
      "org-c",
    ]);
    // A team this phone holds but isn't showing goes by its saved answer only.
    const other = EnvironmentId.make("env-2");
    expect(kinPushLeaveOrgs(host(other, ["org-x"]), env, cached)).toEqual(["org-b", "org-c"]);
    expect(kinPushLeaveOrgs({ _tag: "searching" }, env, null)).toEqual([]);
  });
});

describe("leaving a host", () => {
  it("lets a registration already sent land before the unregister, and sends no new one", async () => {
    const fence = createKinPushFence();
    const order: Array<string> = [];
    let land = () => {};
    const sent = new Promise<void>((resolve) => {
      land = () => {
        order.push("registered");
        resolve();
      };
    });
    expect(fence.allows(env)).toBe(true);
    fence.track(env, sent);
    const fenced = fence.fence(env).then(() => order.push("unregister"));
    expect(fence.allows(env)).toBe(false);
    expect(fence.allows(EnvironmentId.make("env-2"))).toBe(true);
    land();
    await fenced;
    expect(order).toEqual(["registered", "unregister"]);
    // Joining the same host again registers as before.
    fence.release(env);
    expect(fence.allows(env)).toBe(true);
  });

  it("says the alerts stopped only when every org there answered", () => {
    expect(kinPushLeaveOutcome({ orgs: 0, answers: null })).toBe("nothing");
    expect(kinPushLeaveOutcome({ orgs: 2, answers: [true, true] })).toBe("confirmed");
    // Refused, timed out, or not sent because the host was offline.
    expect(kinPushLeaveOutcome({ orgs: 2, answers: [true, false] })).toBe("unconfirmed");
    expect(kinPushLeaveOutcome({ orgs: 1, answers: null })).toBe("unconfirmed");

    // Signing out of a team leaves each of its computers: one notice at most, naming who didn't answer.
    const left = [
      { computer: "Studio desktop", outcome: "confirmed" },
      { computer: "Old laptop", outcome: "nothing" },
    ] as const;
    expect(kinPushLeaveNotice({ team: "Ambermill", leaver: "teammate", left })).toBeNull();
    const silent = [
      ...left,
      { computer: "Spare (10.0.0.4:3773)", outcome: "unconfirmed" },
      { computer: "Spare (10.0.0.5:3773)", outcome: "unconfirmed" },
    ] as const;
    expect(kinPushLeaveNotice({ team: "Ambermill", leaver: "teammate", left: silent })).toEqual({
      title: "Ambermill may still notify this phone",
      detail:
        "You're signed out here, but Spare (10.0.0.4:3773) and Spare (10.0.0.5:3773) didn't answer, so Kin couldn't stop their notices. Ask whoever runs your Kin to remove this phone from your devices.",
    });
    const one = [...left, { computer: "Spare", outcome: "unconfirmed" }] as const;
    expect(kinPushLeaveNotice({ team: "Ambermill", leaver: "owner", left: one })?.detail).toBe(
      "You're signed out here, but Spare didn't answer, so Kin couldn't stop its notices. To stop them, remove this phone under Authorized clients in Settings → Sharing & access on Spare.",
    );
    expect(kinPushLeaveNotice({ team: "Ambermill", leaver: "coOwner", left: one })?.detail).toBe(
      "You're signed out here, but Spare didn't answer, so Kin couldn't stop its notices. To stop them, remove this phone under Your devices from another device.",
    );
  });
});

describe("kinPushRegisterInput", () => {
  it("builds the same registration on Android as on an iPhone, with the platform and its token", () => {
    const orgId = KinOrgId.make("org-a");
    const fcm = "dQw4w9WgXcQ:APA91bH-Mixed_Case-Token";
    expect(kinPushToken("ios", "ABCDEF0123")).toBe("abcdef0123");
    expect(kinPushToken("android", fcm)).toBe(fcm);
    const ios = kinPushRegisterInput({ os: "ios", orgId, token: "abcdef0123", sandbox: true });
    const android = kinPushRegisterInput({ os: "android", orgId, token: fcm, sandbox: true });
    expect(ios).toEqual({
      orgId,
      token: "abcdef0123",
      platform: "ios",
      apsEnvironment: "development",
    });
    expect(android).toEqual({
      ...ios,
      token: fcm,
      platform: "android",
      apsEnvironment: "production",
      // This build has the quiet channel, so quiet hours list pushes there.
      quietChannel: true,
    });
    expect(
      kinPushRegisterInput({ os: "ios", orgId, token: "abcdef0123", sandbox: false })
        .apsEnvironment,
    ).toBe("production");
  });
});
