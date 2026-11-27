// @effect-diagnostics nodeBuiltinImport:off - Exercises the CLI and its OS signal handling with a fake Java executable.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

const run = NodeUtil.promisify(NodeChildProcess.execFile);
const script = NodePath.join(import.meta.dirname, "kin-model.ts");

it.effect.each([
  { mode: "pass", keep: false, status: 0 },
  { mode: "fail", keep: false, status: 1 },
  { mode: "interrupt", keep: false, status: 143 },
  { mode: "pass", keep: true, status: 0 },
])("handles TLC scratch after $mode (keep=$keep)", ({ mode, keep, status }) =>
  Effect.promise(async () => {
    const fixture = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kin-tlc-test-"));
    try {
      const otherRun = "kin-model-send-other";
      await NodeFSP.mkdir(NodePath.join(fixture, otherRun));
      await NodeFSP.writeFile(NodePath.join(fixture, "tla2tools-1.7.4.jar"), "");
      await NodeFSP.writeFile(
        NodePath.join(fixture, "java"),
        `#!${process.execPath}
const fs = require("node:fs");
if (process.argv.includes("-version")) {
  console.error('openjdk version "21.0.0"');
} else {
  fs.writeFileSync(process.env.TMPDIR + "/used", process.cwd());
  fs.writeFileSync("tlc-output", "scratch contents");
  if (process.env.TEST_TLC_MODE === "interrupt") {
    process.kill(process.ppid, "SIGTERM");
  } else if (process.env.TEST_TLC_MODE === "fail") {
    console.error("fake TLC crashed");
    process.exitCode = 2;
  } else {
    console.log("Model checking completed. No error has been found.");
  }
}
`,
        { mode: 0o755 },
      );
      const result = await run(process.execPath, [script, "send", ...(keep ? ["--keep"] : [])], {
        env: {
          PATH: fixture,
          TMPDIR: fixture,
          KIN_MODEL_CACHE: fixture,
          TEST_TLC_MODE: mode,
        },
      }).then(
        ({ stdout }) => ({ stdout, status: 0 }),
        (error: NodeChildProcess.ExecFileException & { stdout: string }) => ({
          stdout: error.stdout,
          status: error.code,
        }),
      );
      const scratch = await NodeFSP.readFile(NodePath.join(fixture, "used"), "utf8");
      const folders = (await NodeFSP.readdir(fixture)).filter((name) =>
        name.startsWith("kin-model-send-"),
      );
      assert.include(folders, otherRun);
      if (keep) {
        assert.include(result.stdout, scratch);
        assert.equal(
          await NodeFSP.readFile(NodePath.join(scratch, "tlc-output"), "utf8"),
          "scratch contents",
        );
      } else {
        assert.deepEqual(folders, [otherRun]);
      }
      assert.equal(result.status, status);
    } finally {
      await NodeFSP.rm(fixture, { recursive: true, force: true });
    }
  }),
);
