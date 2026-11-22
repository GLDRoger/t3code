// @effect-diagnostics nodeBuiltinImport:off - Runs the real host script in bash against a throwaway folder.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const SCRIPT = NodePath.resolve(import.meta.dirname, "../ops/kin/host/clean-temp.sh");

// Both roots live in a fresh `mktemp -d` folder, checked before the script runs; macOS has no
// /proc, so held_paths is stubbed. Times are UTC so the case reads the same in every time zone.
const HARNESS = String.raw`
set -u
# Named physically, as /proc names what processes hold.
FIXTURE="$(cd -P "$(mktemp -d)" && pwd)"
trap 'chmod -R u+w "$FIXTURE"; rm -rf "$FIXTURE"' EXIT
[ -d "$FIXTURE" ] && [ -z "$(ls -A "$FIXTURE")" ] || { echo "fixture is not a fresh folder"; exit 99; }
case "$(cd -P "$FIXTURE" && pwd)" in
  / | "$(cd -P /tmp && pwd)" | "$(cd -P "$TMPDIR" && pwd)" | "$(cd -P "$HOME" && pwd)") echo "fixture is a real folder"; exit 99 ;;
esac
source "$SCRIPT"
# Only folders inside the fixture.
ROOTS=("$FIXTURE/tmp" "$FIXTURE/kin-tmp")
mkdir -p "$FIXTURE/tmp" "$FIXTURE/kin-tmp" "$FIXTURE/outside"
NOW=1794441600 # 2026-11-12T00:00:00Z
at() { TZ=UTC touch -h -t "$1" "$2"; } # at <YYYYMMDDhhmm> <path>
DAYS_AGO=202611100000
THREE_HOURS_AGO=202611112100
JUST_NOW=202611112330
T="$FIXTURE/tmp"
mkdir "$T/old-work" "$T/busy-work" "$T/held" "$T/cache" "$T/cache/pkg" "$T/three-hours"
mkdir "$T/three-hours-checkout" "$T/three-hours-checkout/.git"
head -c 4096 /dev/zero >"$T/old-work/out.bin"
echo x >"$T/busy-work/live.log"
echo x >"$T/held/socket-dir-file"
echo x >"$T/cache/pkg/file"
echo x >"$T/old-file"
echo keep >"$FIXTURE/outside/keep"
ln -s "$FIXTURE/outside" "$T/link-out"
mkdir "$FIXTURE/kin-tmp/old" "$FIXTURE/kin-tmp/fresh"
for path in "$T"/* "$T"/*/* "$T/cache/pkg/file" "$FIXTURE/kin-tmp"/* "$FIXTURE/outside" "$FIXTURE/outside/keep"; do
  at "$DAYS_AGO" "$path"
done
at "$JUST_NOW" "$T/busy-work/live.log"
at "$JUST_NOW" "$FIXTURE/kin-tmp/fresh"
at "$THREE_HOURS_AGO" "$T/three-hours"
at "$THREE_HOURS_AGO" "$T/three-hours-checkout"
at "$THREE_HOURS_AGO" "$T/three-hours-checkout/.git"
# A package cache's read-only folders.
chmod 555 "$T/cache/pkg"
held_paths() { echo "$T/held/socket-dir-file"; }
left() { (cd "$FIXTURE" && find tmp kin-tmp outside -mindepth 1 -maxdepth 1 | sort | tr '\n' ' '); }
`;

function inFixture(program: string) {
  const { stdout, stderr } = NodeChildProcess.spawnSync(
    "bash",
    ["-c", `${HARNESS}\n${program}`, "bash"],
    { encoding: "utf8", env: { ...process.env, SCRIPT, LC_ALL: "C" } },
  );
  return { out: stdout.trim().split("\n"), said: stderr };
}

describe("kin clean-temp.sh", () => {
  it("removes the user's entries untouched for a day, keeps live, held and outside ones", () => {
    const { out, said } = inFixture(`
percent_left() { echo 50; }
main
echo "left $(left)"
echo "outside $(cat "$FIXTURE/outside/keep")"`);
    expect(out[0], said).toMatch(
      /^Cleared 5 old temporary item\(s\) and gave back \d+(\.\d)? (KB|MB)\.$/,
    );
    expect(out.slice(1)).toEqual([
      "left kin-tmp/fresh outside/keep tmp/busy-work tmp/held tmp/three-hours tmp/three-hours-checkout ",
      "outside keep",
    ]);
  });

  it("counts two hours as old while space is low, except for a git checkout, and says so", () => {
    const { out, said } = inFixture(`
percent_left() { echo 19; }
main
echo "left $(left)"`);
    expect(out[0], said).toMatch(
      /^Cleared 6 old temporary item\(s\) and gave back .+\. Space was low, so anything untouched for 2 hours counted as old\.$/,
    );
    expect(out[1]).toBe(
      "left kin-tmp/fresh outside/keep tmp/busy-work tmp/held tmp/three-hours-checkout",
    );
  });

  it("never touches what another user owns", () => {
    const { out, said } = inFixture(`
percent_left() { echo 50; }
id() { if [ "$*" = -u ]; then echo 4242; else command id "$@"; fi; }
main
echo "left $(left | wc -w | tr -d ' ')"`);
    expect(out, said).toEqual(["Nothing old to clear from the temporary folders.", "left 11"]);
  });
});
