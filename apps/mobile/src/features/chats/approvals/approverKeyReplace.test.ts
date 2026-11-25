import { EnvironmentId, KinKeyThumbprint, KinOrgId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createKinApproverKeyCleanup,
  createKinApproverKeyEnrolment,
  type KinApproverKeyRef,
  type KinRevokeAnswer,
} from "./approverKeyReplace";

const ref = (environmentId: string, thumbprint: string): KinApproverKeyRef => ({
  environmentId: EnvironmentId.make(environmentId),
  orgId: KinOrgId.make("org"),
  thumbprint: KinKeyThumbprint.make(thumbprint.repeat(43)),
});
const oldKey = ref("env-a", "a");

function setup(options: {
  record?: KinApproverKeyRef | null;
  accepts?: boolean;
  revoke?: KinRevokeAnswer;
  hold?: Promise<void>;
}) {
  const steps: Array<string> = [];
  const pending: Array<KinApproverKeyRef> = [];
  const enrol = createKinApproverKeyEnrolment<string, string, string>({
    readRecord: async () => (options.record === undefined ? oldKey : options.record),
    begin: async () => {
      steps.push("challenge");
      await options.hold;
      return { ok: true, value: "challenge" };
    },
    discardLocal: async () => void steps.push("delete local"),
    finish: async () => {
      steps.push("register");
      return options.accepts === false ? { ok: false, failure: "too many phones" } : { ok: true };
    },
    revoke: async (key) => {
      steps.push(`revoke ${key.environmentId}`);
      return options.revoke ?? "done";
    },
    addPending: async (key) => void pending.push(key),
  });
  return { enrol, steps, pending };
}

describe("replacing this phone's approval key", () => {
  it("revokes nothing on the old Kin when the new one refuses the phone", async () => {
    const { enrol, steps, pending } = setup({ accepts: false });
    expect(await enrol({ target: "env-b", replace: { confirmed: oldKey } })).toEqual({
      _tag: "stopped",
      failure: "too many phones",
    });
    expect(steps).toEqual(["challenge", "delete local", "register"]);
    expect(pending).toEqual([]);
  });

  it("revokes the old key only after the new Kin has it, and keeps it pending when unanswered", async () => {
    const done = setup({});
    expect(await done.enrol({ target: "env-b", replace: { confirmed: oldKey } })).toMatchObject({
      _tag: "done",
      cleanup: "done",
    });
    expect(done.steps).toEqual(["challenge", "delete local", "register", "revoke env-a"]);
    for (const answer of ["retry", "final"] as const) {
      const offline = setup({ revoke: answer });
      expect(await offline.enrol({ target: "env-b", replace: { confirmed: oldKey } })).toEqual({
        _tag: "done",
        cleanup: "pending",
        replaced: oldKey,
      });
      expect(offline.pending).toEqual([oldKey]);
    }
  });

  it("changes nothing when the key is no longer the one the person confirmed", async () => {
    const { enrol, steps } = setup({ record: ref("env-b", "b") });
    expect(await enrol({ target: "env-b", replace: { confirmed: oldKey } })).toEqual({
      _tag: "changed",
    });
    expect(steps).toEqual([]);
  });

  it("runs one setup at a time on the phone", async () => {
    let release = () => {};
    const hold = new Promise<void>((resolve) => (release = resolve));
    const { enrol, steps } = setup({ hold });
    const first = enrol({ target: "env-b", replace: { confirmed: oldKey } });
    expect(await enrol({ target: "env-b", replace: { confirmed: oldKey } })).toEqual({
      _tag: "busy",
    });
    release();
    expect(await first).toMatchObject({ _tag: "done" });
    expect(steps.filter((step) => step === "challenge")).toHaveLength(1);
    expect(await enrol({ target: "env-b", replace: null })).toMatchObject({
      _tag: "done",
      cleanup: "none",
    });
  });
});

describe("cleaning up a replaced key", () => {
  it("asks each connected host again and forgets a key once its host has answered", async () => {
    const onA = oldKey;
    const onB = ref("env-b", "b");
    let pending = [onA, onB];
    const answers: Record<string, KinRevokeAnswer> = { "env-a": "retry" };
    const asked: Array<string> = [];
    const cleanup = createKinApproverKeyCleanup({
      pending: async () => pending,
      connected: (environmentId) => environmentId === "env-a",
      revoke: async (key) => {
        asked.push(key.environmentId);
        return answers[key.environmentId] ?? "done";
      },
      removePending: async (key) => {
        pending = pending.filter((one) => one !== key);
      },
    });
    await cleanup();
    expect([asked, pending]).toEqual([["env-a"], [onA, onB]]);
    answers["env-a"] = "done";
    await cleanup();
    expect(pending).toEqual([onB]);
  });
});
