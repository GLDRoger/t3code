import { EnvironmentId, KinPushError } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createKinPushRefusals, kinPushPermissionStep } from "./kinPushRegistration";

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
