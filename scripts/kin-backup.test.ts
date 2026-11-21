// @effect-diagnostics nodeBuiltinImport:off - Runs the real host script in bash against a throwaway home.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it } from "vite-plus/test";

const SCRIPT = NodePath.resolve(import.meta.dirname, "../ops/kin/host/backup.sh");

// A fake host: getent and findmnt are stubs on PATH; the backup volume is $HOME/backup on
// $BACKUP_DEVICE, and kin's data is on /dev/data.
const STUBS = {
  getent: `#!/bin/sh\necho "$(id -un):x:0:0::$FAKE_HOME:/bin/sh"\n`,
  findmnt: String.raw`#!/bin/sh
for last; do :; done
case "$*" in
  *TARGET*) case "$last" in "$FAKE_HOME/backup"*) echo /mnt/backup ;; *) echo /home ;; esac ;;
  *SOURCE*) case "$last" in "$FAKE_HOME/backup"*) echo "$BACKUP_DEVICE" ;; *) echo /dev/data ;; esac ;;
esac
`,
};

function onFakeHost(program: string) {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kin-backup-"));
  try {
    NodeFS.mkdirSync(NodePath.join(home, "stubs"));
    for (const [name, body] of Object.entries(STUBS))
      NodeFS.writeFileSync(NodePath.join(home, "stubs", name), body, { mode: 0o755 });
    const { stdout, stderr } = NodeChildProcess.spawnSync("bash", ["-c", program, "bash"], {
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_HOME: home,
        HOME: home,
        PATH: `${home}/stubs:${process.env.PATH}`,
        SCRIPT,
        LC_ALL: "C",
      },
    });
    return { out: stdout.trim().split("\n"), said: stderr };
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
}

describe("kin backup.sh", () => {
  // The host is Linux: backup.sh uses GNU tar and date, which macOS lacks.
  it.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
    "records each run's outcome where Kin reads it, keeping the last good time through a failure",
    () => {
      const { out, said } = onFakeHost(String.raw`
set -u
mkdir -p "$HOME/.t3/userdata" "$HOME/backup"
sqlite3 "$HOME/.t3/userdata/statev2.sqlite" "CREATE TABLE notes (body TEXT);"
STATUS="$HOME/.t3/userdata/kin-backup-status.json"
export BACKUP_DEVICE=/dev/backup
backup() { bash "$SCRIPT" --dest "$HOME/backup" --user "$(id -un)" --i-know-dest-is-encrypted >/dev/null; echo "status $?"; }
backup
good="$(sed -n 's/.*"lastGoodAt":\([0-9]*\).*/\1/p' "$STATUS")"
sed 's/[0-9]\{13\}/<ms>/g; s/"bytes":[0-9]*/"bytes":<n>/' "$STATUS"
[ -e "$HOME/backup/kin-$(date +%F)/userdata/kin-backup-status.json" ] || echo "not in the backup"
BACKUP_DEVICE=/dev/data backup
sed 's/"ranAt":[0-9]*/"ranAt":<ms>/' "$STATUS" | sed "s/$good/<the good run>/; s|$HOME|<home>|g"
rm "$STATUS"
BACKUP_DEVICE=/dev/data backup
sed 's/[0-9]\{13\}/<ms>/g; s|"error":".*"|"error":<said>|' "$STATUS"`);
      expect(out, said).toEqual([
        "status 0",
        '{"ranAt":<ms>,"ok":true,"lastGoodAt":<ms>,"bytes":<n>,"error":""}',
        "not in the backup",
        "status 1",
        '{"ranAt":<ms>,"ok":false,"lastGoodAt":<the good run>,"bytes":null,"error":"<home>/backup is on /dev/data (/mnt/backup), the same disk as kin\'s data or the root filesystem.\\nMount the backup volume there first."}',
        "status 1",
        '{"ranAt":<ms>,"ok":false,"lastGoodAt":null,"bytes":null,"error":<said>}',
      ]);
    },
  );
});
