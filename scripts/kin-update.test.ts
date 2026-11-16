// @effect-diagnostics nodeBuiltinImport:off - Sources the real host script in bash against a throwaway home.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const SCRIPT = NodePath.resolve(import.meta.dirname, "../ops/kin/host/update.sh");

// A fake host: systemctl, curl, sudo and sleep are stubs, the "server" migrates the real SQLite
// database when it starts on the new build, and everything lives in a temporary $HOME.
const HARNESS = String.raw`
set -u
mkdir -p "$HOME/.t3/userdata" "$HOME/kin-builds"
build() { # build <name> <kin migration head>
  local dir="$HOME/kin-builds/$1"
  mkdir -p "$dir/apps/server/dist" "$dir/apps/server/src/persistence/Migrations" \
    "$dir/apps/server/src/kin/persistence/migrations" "$dir/ops/kin/host"
  touch "$dir/apps/server/dist/bin.mjs" "$dir/apps/server/src/persistence/Migrations/080_Last.ts" \
    "$dir/apps/server/src/kin/persistence/migrations/K$2_Last.ts"
  for unit in kin-server.service kin-backup.service kin-backup.timer; do echo "$unit" >"$dir/ops/kin/host/$unit"; done
  echo "$dir"
}
sqlite3 "$HOME/.t3/userdata/statev2.sqlite" "CREATE TABLE effect_sql_migrations (migration_id INTEGER, name TEXT);
  CREATE TABLE kin_sql_migrations (migration_id INTEGER, name TEXT);
  INSERT INTO effect_sql_migrations VALUES (80, 'Last'); INSERT INTO kin_sql_migrations VALUES (148, 'Last');
  CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('before the update');"
OLD="$(build old 148)"
ln -s "$OLD" "$HOME/kin-current"
source "$SCRIPT"
REPO="$HOME/t3code"
SERVER_STATE=active
SERVER_MIGRATES=1
SERVER_ANSWERS=1
systemctl() {
  echo "systemctl $*" >>"$HOME/calls"
  case "$*" in
    *"-P ActiveState"*) echo "$SERVER_STATE" ;;
    *"-P NRestarts"*) echo 0 ;;
    "--system cat"*) return 1 ;;
    *"restart kin-server"* | *"start kin-server"*)
      if [ "$(readlink "$CURRENT")" = "$NEW" ] && [ "$SERVER_MIGRATES" = 1 ]; then
        sqlite3 "$DB" "INSERT INTO kin_sql_migrations VALUES (149, 'New'); INSERT INTO notes VALUES ('by the new build');"
      fi ;;
  esac
}
curl() { [ "$SERVER_ANSWERS" = 1 ]; }
sleep() { :; }
sudo() { :; }
# No real worktrees here, so removing one fails and the script falls back to rm -rf.
git() { case "$*" in *"worktree remove"*) return 1 ;; esac; }
# GNU mv -T on the host; macOS mv has no -T.
mv() { if [ "$1" = -T ]; then python3 -c 'import os, sys; os.replace(sys.argv[1], sys.argv[2])' "$2" "$3"; else command mv "$@"; fi; }
heads() { sqlite3 "$DB" "SELECT max(migration_id) FROM kin_sql_migrations;"; }
`;

function onFakeHost(program: string) {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kin-update-"));
  try {
    const { stdout, stderr } = NodeChildProcess.spawnSync(
      "bash",
      ["-c", `${HARNESS}\n${program}`, "bash"],
      { encoding: "utf8", env: { ...process.env, HOME: home, SCRIPT, LC_ALL: "C" } },
    );
    return { out: stdout.trim().split("\n"), said: stderr };
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
}

const deploy = `(set -euo pipefail; deploy "$(printf 'b%.0s' {1..40})" "$NEW" "$OLD" 24.13.1); echo "status $?"`;

describe("kin update.sh", () => {
  it("backs up before migrating, switches to a healthy build, and prunes old builds and backups", () => {
    const { out, said } = onFakeHost(`
NEW="$(build new 149)"
for n in 1 2 3; do build "older$n" 147 >/dev/null; command sleep 0.01; done
mkdir -p "$BACKUP_DIR"
for n in $(seq -w 1 12); do touch "$BACKUP_DIR/statev2-202601\${n}T000000Z-aaaaaaaaaaaa.sqlite"; done
touch "$BACKUP_DIR/hand-made.sqlite"
${deploy}
echo "current $(basename "$(readlink "$CURRENT")")"
echo "builds $(ls "$HOME/kin-builds" | sort | tr '\\n' ' ')"
echo "backups $(ls "$BACKUP_DIR" | grep -c '^statev2-')"
ls "$BACKUP_DIR" | grep -q hand-made && echo "hand-made kept"
latest="$(ls "$BACKUP_DIR"/statev2-*-bbbbbbbbbbbb.sqlite)"
echo "backup holds $(sqlite3 "$latest" "SELECT max(migration_id) FROM kin_sql_migrations; SELECT group_concat(body) FROM notes;" | tr '\\n' ' ')"
echo "database at $(heads)"`);
    expect(out, said).toEqual([
      "status 0",
      "current new",
      "builds new old older3 ",
      "backups 10",
      "hand-made kept",
      "backup holds 148 before the update ",
      "database at 149",
    ]);
    expect(said).toContain("healthy: up, answering, migrations at 80/K149");
  });

  it("goes back to the previous build when the new one's migrations don't run", () => {
    const { out, said } = onFakeHost(`
NEW="$(build new 149)"
SERVER_MIGRATES=0
${deploy}
echo "current $(basename "$(readlink "$CURRENT")")"
echo "database at $(heads)"
[ -e "$NEW/.failed" ] && echo "new marked failed"`);
    expect(out, said).toEqual(["status 1", "current old", "database at 148", "new marked failed"]);
    expect(said).toContain("the database is at migrations 80/K148, the build expects 80/K149");
    expect(said).toContain("rolled back to");
    expect(said).not.toContain("restored the database");
  });

  it("restores the backup when a build migrates the database and then fails", () => {
    const { out, said } = onFakeHost(`
NEW="$(build new 149)"
SERVER_STATE=failed
${deploy}
echo "current $(basename "$(readlink "$CURRENT")")"
echo "database at $(heads): $(sqlite3 "$DB" "SELECT group_concat(body) FROM notes;")"
echo "kept $(sqlite3 "$DB.failed-bbbbbbbbbbbb" "SELECT max(migration_id) FROM kin_sql_migrations;")"`);
    expect(out, said).toEqual([
      "status 1",
      "current old",
      "database at 148: before the update",
      "kept 149",
    ]);
    expect(said).toContain("didn't stay up (ActiveState=failed NRestarts=0)");
    expect(said).toContain("restored the database from");
  });

  it("leaves the server stopped, data intact, when the backup can't be copied back", () => {
    const { out, said } = onFakeHost(`
NEW="$(build new 149)"
SERVER_STATE=failed
cp() { case "$*" in *.restoring) return 28 ;; esac; command cp "$@"; }
{ ${deploy}; } 2>"$HOME/said"
cat "$HOME/said" >&2
tail -n1 "$HOME/said" | grep -q '^update\\.sh: ROLLBACK STOPPED: ' && echo "ends with the rollback line"
echo "current $(readlink "$CURRENT" || echo none)"
echo "database at $(heads): $(sqlite3 "$DB" "SELECT group_concat(body) FROM notes;")"
echo "starts after rollback stop $(sed -n '/reset-failed/,$p' "$HOME/calls" | grep -c 'start kin-server')"
ls "$HOME/.t3/userdata" | grep -q 'restoring\\|failed-' && echo "leftovers"
# Then the recovery the last line prints, once the disk has room again.
unset -f cp
export -f mv
recover="$(tail -n1 "$HOME/said")"
eval "\${recover#*then run: }" &&
  echo "recovered: current $(basename "$(readlink "$CURRENT")"), database at $(heads), kept $(sqlite3 "$DB.failed-bbbbbbbbbbbb" "SELECT max(migration_id) FROM kin_sql_migrations;")"
echo "last call $(tail -n1 "$HOME/calls")"`);
    expect(out, said).toEqual([
      "status 1",
      "ends with the rollback line",
      "current none",
      "database at 149: before the update,by the new build",
      "starts after rollback stop 0",
      "recovered: current old, database at 148, kept 149",
      "last call systemctl --user start kin-server",
    ]);
    const last = said.split("\n").find((line) => line.includes("ROLLBACK STOPPED")) ?? "";
    expect(last).toContain("kin-server is NOT running and its data is intact");
    expect(last).toMatch(
      /Good copy from before the update: \S+\/statev2-\S+-bbbbbbbbbbbb\.sqlite\./,
    );
    expect(last).toContain(`Database ${"b".repeat(40)} migrated: `);
    expect(said.indexOf("restored the database")).toBeGreaterThan(said.indexOf(last));
  });

  it("starts the previous build again when the new env file can't be written", () => {
    const { out, said } = onFakeHost(`
NEW="$(build new 149)"
mkdir -p "$(dirname "$ENV_FILE")" && echo "KIN_NODE_VERSION=22" >"$ENV_FILE"
mktemp() { return 1; }
${deploy}
echo "current $(basename "$(readlink "$CURRENT")")"
echo "env $(cat "$ENV_FILE")"
echo "database at $(heads)"
echo "last call $(tail -n1 "$HOME/calls")"`);
    expect(out, said).toEqual([
      "status 1",
      "current old",
      "env KIN_NODE_VERSION=22",
      "database at 148",
      "last call systemctl --user start kin-server",
    ]);
    expect(said.trim().split("\n").at(-1)).toMatch(
      /^update\.sh: the server runs \S+\/old again\.$/,
    );
  });

  it("rolls back when the server never answers", () => {
    const { out, said } = onFakeHost(`
NEW="$(build new 149)"
SERVER_ANSWERS=0
${deploy}
echo "current $(basename "$(readlink "$CURRENT")")"`);
    expect(out, said).toEqual(["status 1", "current old"]);
    expect(said).toContain("didn't answer on http://127.0.0.1:3773 within 90s");
  });

  it("reads the port from service.env", () => {
    const { out } = onFakeHost(`
printf 'T3CODE_LAN=true\\nexport T3CODE_PORT="4100"\\n' >"$SERVICE_ENV"
server_url`);
    expect(out).toEqual(["http://127.0.0.1:4100"]);
  });
});
