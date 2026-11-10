// @effect-diagnostics nodeBuiltinImport:off - Sources the real host script's helpers in bash.
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const SCRIPT = NodePath.resolve(import.meta.dirname, "../ops/kin/host/kin-worker.sh");

// Sourcing the script defines its functions and runs nothing; `program` then calls them.
function runHelpers(program: string) {
  const { status, stdout, stderr } = NodeChildProcess.spawnSync(
    "bash",
    ["-c", `source "$1"\n${program}`, "bash", SCRIPT],
    { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } },
  );
  expect(status, stderr).toBe(0);
  return stdout.trim().split("\n");
}

// The helpers hash with /usr/bin/sha256sum and run on the Ubuntu host.
describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("kin-worker setup", () => {
  it("knows kin's gateway key whatever its line ends, and never matches when kin has none", () => {
    expect(
      runHelpers(`kin="$(printf 'sk-kin\\r\\n' | key_hash)"
printf 'sk-kin' | is_kin_key "$kin" && echo same || echo different
printf 'sk-kin\\r' | is_kin_key "$kin" && echo same || echo different
printf 'sk-other' | is_kin_key "$kin" && echo same || echo different
printf 'sk-kin' | is_kin_key "" && echo same || echo different`),
    ).toEqual(["same", "same", "different", "different"]);
  });

  it("reads registration from the exit status, and 'already registered' only from its message", () => {
    expect(
      runHelpers(`registration_result 0 "Added project p1 (app) at /home/kin-worker/projects/app."
registration_result 1 "Active project p1 already exists for '/home/kin-worker/projects/app'."
registration_result 1 "ProjectLiveServerRequestError: connect ECONNREFUSED, file already exists"
registration_result 0 ""
registration_result 7 ""`),
    ).toEqual(["added", "registered", "failed", "added", "failed"]);
  });

  it("fails when a repository is missing, after trying every other one", () => {
    const lines = runHelpers(`kin_repos() { echo GLDRoger/t3code; }
memory_repos() { echo GLDRoger/memory; }
setup_project() { echo "tried $1"; [ "$1" != acme/private ]; }
setup_projects acme/private GLDRoger/memory && echo "status 0" || echo "status $?"`);
    expect(lines).toContain("tried GLDRoger/t3code");
    expect(lines).toContain("tried acme/private");
    expect(lines).not.toContain("tried GLDRoger/memory");
    expect(lines.at(-1)).toBe("status 1");
  });
});
