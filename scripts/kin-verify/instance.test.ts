// @effect-diagnostics nodeBuiltinImport:off - runs the provider stubs kin-verify puts on PATH.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import { withoutRealModels } from "./instance.ts";

describe("kin-verify instance", () => {
  it("starts the server where every provider CLI fails and no provider key is set", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kin-verify-stubs-"));
    try {
      const base = { PATH: process.env.PATH, ANTHROPIC_API_KEY: "sk-ambermill-test" };
      const env = withoutRealModels(base, NodePath.join(dir, "no-models"));
      assert.isUndefined(env.ANTHROPIC_API_KEY);
      const claude = NodeChildProcess.spawnSync("claude", ["-p", "hello"], {
        env,
        encoding: "utf8",
      });
      assert.strictEqual(claude.status, 1);
      assert.include(claude.stderr, "real models are off");
      assert.strictEqual(
        NodeFS.readFileSync(NodePath.join(dir, "no-models", "calls.log"), "utf8"),
        "claude -p hello\n",
      );
      const counted = withoutRealModels(
        { ...base, KIN_VERIFY_NO_MODELS: "/release/no-models" },
        NodePath.join(dir, "own"),
      );
      assert.isTrue(counted.PATH?.startsWith(`/release/no-models${NodePath.delimiter}`));
      assert.isFalse(NodeFS.existsSync(NodePath.join(dir, "own")));
      const asked = { ...base, KIN_VERIFY_REAL_MODELS: "1" };
      assert.strictEqual(withoutRealModels(asked, NodePath.join(dir, "kept")), asked);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});
