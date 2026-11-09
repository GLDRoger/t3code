import { EnvironmentId, KinPushError } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createKinPushRefusals } from "./kinPushRegistration";

const env = EnvironmentId.make("env-1");
const refusal = (reason: KinPushError["reason"]) => new KinPushError({ reason, message: reason });

describe("createKinPushRefusals", () => {
  it("keeps a token registered to someone else out of that org for good, noting it once", () => {
    const refusals = createKinPushRefusals();
    const target = { environmentId: env, orgId: "org-a", token: "abc" };
    expect(refusals.note(target, refusal("registered_to_someone_else"))).toBe(true);
    expect(refusals.isRefused(target)).toBe(true);
    // A later session hits the same answer without logging again.
    expect(refusals.note(target, refusal("registered_to_someone_else"))).toBe(false);
    // Another org, or a new token, still registers.
    expect(refusals.isRefused({ ...target, orgId: "org-b" })).toBe(false);
    expect(refusals.isRefused({ ...target, token: "def" })).toBe(false);
  });

  it.each(["unavailable", "disabled", "not_member"] as const)("retries after %s", (reason) => {
    const refusals = createKinPushRefusals();
    const target = { environmentId: env, orgId: "org-a", token: "abc" };
    expect(refusals.note(target, refusal(reason))).toBe(false);
    expect(refusals.isRefused(target)).toBe(false);
  });
});
