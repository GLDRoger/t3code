// @effect-diagnostics nodeBuiltinImport:off - Drives the runner's real child process against a temporary log.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import {
  compare,
  finding,
  firstError,
  gates,
  lookbookFindings,
  modelsRan,
  run,
  stopChildren,
  streamRemote,
  unpackFixture,
} from "./kin-release-check.ts";

const tempDir = (prefix: string) => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
const script = (path: string, body: string) => {
  NodeFS.writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  return path;
};

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

  it("names a refused start by its error, not by a stack frame that moves with the checkout", () => {
    const output = [
      "[12:48:55.321] ERROR (#2): MigrationError: This database's migration history would skip required schema migrations: 70_PeerLinks (recorded: SiteLocalMigration).",
      "    at server.runDefaultServerCommand (file:///Users/a/worktrees/x/node_modules/effect/dist/cli/internal/command.js:12:9)",
      "kin-verify: dev server exited during start.",
    ].join("\n");
    assert.match(
      firstError(output),
      /^MigrationError: This database's migration history would skip/,
    );
  });

  it("runs every lifecycle script: run-all's list is the scripts folder, less the four that aren't", () => {
    const dir = NodePath.resolve(import.meta.dirname, "../.agents/skills/verify-kin/scripts");
    const notLifecycle = ["lib", "run-all", "card-gallery", "provider-conformance"];
    const files = NodeFS.readdirSync(dir)
      .filter((file) => file.endsWith(".sh"))
      .map((file) => file.slice(0, -3))
      .filter((name) => !notLifecycle.includes(name));
    const listed = NodeChildProcess.execFileSync(
      "bash",
      [NodePath.join(dir, "run-all.sh"), "--list"],
      {
        encoding: "utf8",
      },
    )
      .trim()
      .split("\n");
    assert.deepStrictEqual(listed.toSorted(), files.toSorted());
  });

  it("makes each look book screen that changed, is new, is missing or wasn't captured a finding", () => {
    const captured = [
      "captured 41 screens of 31f384d14f in 540 s at /tmp/lookbook/new",
      "could not capture money (narrow): Timeout waiting for the Money place",
    ].join("\n");
    const compared = [
      "same 38 · changed 1 · new 1 · missing 1 · /tmp/lookbook/compare/index.html",
      "changed\ttasks-wide.png",
      "new\tclients-narrow.png",
      "missing\tdocs-wide.png",
    ].join("\n");
    assert.deepStrictEqual(
      lookbookFindings(captured, compared).map((one) => [one.check, one.step]),
      [
        ["capture", "money (narrow)"],
        ["changed", "tasks-wide.png"],
        ["new", "clients-narrow.png"],
        ["missing", "docs-wide.png"],
      ],
    );
    assert.deepStrictEqual(lookbookFindings("captured 41 screens", "same 41 · changed 0"), []);
  });

  it("records a program that can't start as a failed command instead of crashing the check", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kin-release-run-"));
    try {
      const ran = await run(NodePath.join(dir, "stage.log"), "kin-release-no-such-program", []);
      assert.strictEqual(ran.code, 127);
      assert.include(ran.output, "ENOENT");
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("counts a model as checked only when check:changed ran it, not when it skipped without Java", () => {
    const output = [
      "send: skipped: Java not found (install Java 11+ to check this model).",
      "reply: no rule broken",
      "check:changed summary",
      "  pass  kin model send  0.2s",
      "  pass  kin model reply  4.1s",
      "  FAIL  kin model checkin  2.0s",
    ].join("\n");
    assert.deepStrictEqual([...modelsRan(output)].toSorted(), ["checkin", "reply"]);
  });

  it("unpacks a remote run's fixture when this machine has no folder for the commit yet", () => {
    const dir = tempDir("kin-release-fixture-");
    try {
      NodeFS.mkdirSync(NodePath.join(dir, "from", "fixture"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(dir, "from", "fixture", "statev2.sqlite"), "company");
      const tarball = NodeChildProcess.spawnSync("tar", [
        "-C",
        NodePath.join(dir, "from"),
        "-czf",
        "-",
        "fixture",
      ]).stdout;
      const fixture = NodePath.join(dir, "checks", "abcdef123456", "fixture");
      assert.isTrue(unpackFixture(fixture, tarball));
      assert.strictEqual(
        NodeFS.readFileSync(NodePath.join(fixture, "statev2.sqlite"), "utf8"),
        "company",
      );
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stops the ssh run with the other children when the check is cancelled", async () => {
    const dir = tempDir("kin-release-ssh-");
    try {
      const never = NodePath.join(dir, "never");
      NodeChildProcess.spawnSync("mkfifo", [never]);
      // Blocks until someone writes, which nobody does: only a kill ends it.
      const ssh = script(
        NodePath.join(dir, "ssh"),
        `echo $$ > "${dir}/pid"; read -r line < "${never}"`,
      );
      const ran = streamRemote(ssh, [], NodePath.join(dir, "remote.log"));
      stopChildren();
      assert.notStrictEqual((await ran).code, 0);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a second remote run is busy while the first is still taking the lock, and reclaims a dead one", async () => {
    const dir = tempDir("kin-release-lock-");
    try {
      NodeFS.mkdirSync(NodePath.join(dir, "scripts"));
      NodeFS.copyFileSync(
        NodePath.join(import.meta.dirname, "kin-release-remote.sh"),
        NodePath.join(dir, "scripts", "kin-release-remote.sh"),
      );
      const bin = NodePath.join(dir, "bin");
      NodeFS.mkdirSync(bin);
      const held = NodePath.join(dir, "held");
      const go = NodePath.join(dir, "go");
      NodeChildProcess.spawnSync("mkfifo", [held, go]);
      // The first run to take the lock stops right after the step that takes it, before anything else.
      const pausing = (tool: string) =>
        script(
          NodePath.join(bin, tool),
          [
            `/bin/${tool} "$@" || exit $?`,
            `if [[ "\${@: -1}" == *release-check* && ! -e "${dir}/paused" ]]; then`,
            `  touch "${dir}/paused"; echo held > "${held}"; read -r line < "${go}"`,
            "fi",
          ].join("\n"),
        );
      pausing("mkdir");
      pausing("ln");
      // Past the lock a run fetches; this one says so and stops.
      script(NodePath.join(bin, "git"), 'echo "entered $$"; exit 1');
      const env = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        KIN_RELEASE_CHECK_DIR: dir,
      };
      const remote = NodePath.join(dir, "scripts", "kin-release-remote.sh");
      const first = new Promise<number | null>((resolve) => {
        const child = NodeChildProcess.spawn("bash", [remote, "abc123"], { env, stdio: "ignore" });
        child.on("close", resolve);
      });
      NodeFS.readFileSync(held);
      const second = NodeChildProcess.spawnSync("bash", [remote, "abc123"], {
        env,
        encoding: "utf8",
      });
      assert.strictEqual(second.status, 75, second.stdout);
      assert.include(second.stdout, "busy");
      NodeFS.writeFileSync(go, "go\n");
      assert.strictEqual(await first, 76);
      // An owner that is gone leaves its lock behind; the next run takes it over.
      const gone = NodeChildProcess.spawnSync("bash", ["-c", "echo $$"], { encoding: "utf8" });
      NodeFS.symlinkSync(gone.stdout.trim(), NodePath.join(dir, ".t3", "release-check.pid"));
      const third = NodeChildProcess.spawnSync("bash", [remote, "abc123"], {
        env,
        encoding: "utf8",
      });
      assert.strictEqual(third.status, 76, third.stdout);
      assert.include(third.stdout, "entered");
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});
