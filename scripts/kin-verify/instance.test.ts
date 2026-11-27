// @effect-diagnostics nodeBuiltinImport:off - runs the provider stubs kin-verify puts on PATH.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

import { parseSsListenerPids, scriptedSettings, withoutRealModels } from "./instance.ts";
import { chromePath } from "./web.ts";

describe("kin-verify instance", () => {
  it.effect("reads process IDs from ss listener output", () =>
    Effect.sync(() => {
      assert.deepStrictEqual(
        parseSsListenerPids(
          'LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=4242,fd=20))',
        ),
        [4242],
      );
      assert.deepStrictEqual(parseSsListenerPids(""), []);
    }),
  );

  it.effect.runIf(HostProcess.Platform.defaultValue() === "linux")(
    "finds Chrome in the Linux Playwright cache without an override",
    () =>
      Effect.sync(() => {
        const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kin-verify-chrome-"));
        try {
          vi.stubEnv("HOME", home);
          vi.stubEnv("KIN_VERIFY_CHROME", undefined);
          const binary = NodePath.join(
            home,
            ".cache",
            "ms-playwright",
            "chromium_headless_shell-1234",
            "chrome-headless-shell-linux64",
            "chrome-headless-shell",
          );
          NodeFS.mkdirSync(NodePath.dirname(binary), { recursive: true });
          NodeFS.writeFileSync(binary, "", { mode: 0o755 });
          assert.strictEqual(chromePath(), binary);
        } finally {
          vi.unstubAllEnvs();
          NodeFS.rmSync(home, { recursive: true, force: true });
        }
      }),
  );

  it("starts the server where every provider CLI fails and no provider key is set", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kin-verify-stubs-"));
    try {
      const base = {
        PATH: process.env.PATH,
        ANTHROPIC_API_KEY: "sk-ambermill-test",
        ANTHROPIC_AUTH_TOKEN: "ambermill-token",
        ANTHROPIC_BASE_URL: "https://gateway.example",
      };
      const env = withoutRealModels(base, NodePath.join(dir, "no-models"));
      assert.isUndefined(env.ANTHROPIC_API_KEY);
      assert.isUndefined(env.ANTHROPIC_AUTH_TOKEN);
      assert.isUndefined(env.ANTHROPIC_BASE_URL);
      const kept = { kinBackgroundModelSelection: { instanceId: "claudeAgent", model: "any" } };
      assert.isNull(scriptedSettings({}, false).kinBackgroundModelSelection);
      assert.isNull(scriptedSettings(kept, false).kinBackgroundModelSelection);
      assert.notProperty(scriptedSettings({}, true), "kinBackgroundModelSelection");
      assert.strictEqual(
        scriptedSettings(kept, true).kinBackgroundModelSelection,
        kept.kinBackgroundModelSelection,
      );
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
