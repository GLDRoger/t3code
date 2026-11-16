import { assert, describe, it } from "@effect/vitest";

import { compare, finding, gates } from "./kin-release-check.ts";

describe("kin release check", () => {
  it("gives the same failure the same fingerprint across runs, and a different one elsewhere", () => {
    const first = finding(
      "lifecycle",
      "run-all",
      "send-card-once",
      "-",
      'second confirm sent mail 2 times (expected "Card k3x9qa")',
    );
    const again = finding(
      "lifecycle",
      "run-all",
      "send-card-once",
      "-",
      'second confirm sent mail 3 times (expected "Card p0m2zz")',
    );
    assert.strictEqual(first.fingerprint, again.fingerprint);
    assert.notStrictEqual(
      first.fingerprint,
      finding("migrate", "lifecycle", "send-card-once", "-", first.message).fingerprint,
    );
    assert.notStrictEqual(
      finding("ui-fuzz", "property", "privacyMoney", "member", "violated").fingerprint,
      finding("ui-fuzz", "property", "privacyMoney", "lead", "violated").fingerprint,
    );
  });

  it("splits NEW, FIXED and STILL PRESENT, and never calls a stage that didn't run FIXED", () => {
    const kept = finding("models", "send", "SentOnce", "-", "rule broken");
    const gone = finding("properties", "teamView", "hides private", "-", "falsified");
    const fuzz = finding("ui-fuzz", "property", "noDeadControls", "owner", "violated");
    const fresh = finding("lifecycle", "run-all", "member-no-money", "-", "saw ₹47,200");
    const diff = compare([kept, fresh], [kept, gone, fuzz], ["models", "properties", "lifecycle"]);
    assert.deepStrictEqual(diff.new, [fresh]);
    assert.deepStrictEqual(diff.fixed, [gone]);
    assert.deepStrictEqual(diff.still, [kept]);
  });

  it("fails on any deterministic finding, and on a fuzz finding only when it is NEW", () => {
    const model = finding("models", "send", "SentOnce", "-", "rule broken");
    const fuzz = finding("ui-fuzz", "property", "noDeadControls", "owner", "violated");
    assert.isTrue(gates(model, false));
    assert.isTrue(gates(fuzz, true));
    assert.isFalse(gates(fuzz, false));
  });
});
