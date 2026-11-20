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
# The temporary disk's real free space decides nothing here; the space test sets its own.
SPACE_HEADROOM=0
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
PUBLISHED="$(printf 'b%.0s' {1..40})"
${deploy}
echo "current $(basename "$(readlink "$CURRENT")")"
echo "env $(grep '^KIN_BUILD_COMMIT=' "$ENV_FILE")"
echo "builds $(ls "$HOME/kin-builds" | sort | tr '\\n' ' ')"
echo "backups $(ls "$BACKUP_DIR" | grep -c '^statev2-')"
ls "$BACKUP_DIR" | grep -q hand-made && echo "hand-made kept"
latest="$(ls "$BACKUP_DIR"/statev2-*-bbbbbbbbbbbb.sqlite)"
echo "backup holds $(sqlite3 "$latest" "SELECT max(migration_id) FROM kin_sql_migrations; SELECT group_concat(body) FROM notes;" | tr '\\n' ' ')"
echo "database at $(heads)"`);
    expect(out, said).toEqual([
      "status 0",
      "current new",
      // memory-check in the memory repo is pinned to this commit when Kin updates it.
      `env KIN_BUILD_COMMIT=${"b".repeat(40)}`,
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
# Then the recovery the last line prints, once the disk has room again, typed into a fresh
# login shell: no user-bus variables and none of this harness's functions.
mkdir -p "$HOME/stubs"
printf '#!/bin/sh\\necho "systemctl $* XDG_RUNTIME_DIR=\${XDG_RUNTIME_DIR:-unset} DBUS_SESSION_BUS_ADDRESS=\${DBUS_SESSION_BUS_ADDRESS:-unset}" >>"$HOME/calls"\\n' >"$HOME/stubs/systemctl"
printf '#!/bin/sh\\nif [ "$1" = -T ]; then exec python3 -c "import os, sys; os.replace(sys.argv[1], sys.argv[2])" "$2" "$3"; fi\\nexec /bin/mv "$@"\\n' >"$HOME/stubs/mv"
chmod +x "$HOME/stubs/systemctl" "$HOME/stubs/mv"
recover="$(tail -n1 "$HOME/said")"
env -i HOME="$HOME" PATH="$HOME/stubs:$PATH" LC_ALL=C bash --noprofile --norc -l -c "\${recover#*then run: }" &&
  echo "recovered: current $(basename "$(readlink "$CURRENT")"), database at $(heads), kept $(sqlite3 "$DB.failed-bbbbbbbbbbbb" "SELECT max(migration_id) FROM kin_sql_migrations;")"
echo "last call $(tail -n1 "$HOME/calls")"`);
    expect(out, said).toEqual([
      "status 1",
      "ends with the rollback line",
      "current none",
      "database at 149: before the update,by the new build",
      "starts after rollback stop 0",
      "recovered: current old, database at 148, kept 149",
      `last call systemctl --user start kin-server XDG_RUNTIME_DIR=/run/user/${process.getuid?.()} DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${process.getuid?.()}/bus`,
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

  it("refuses before stopping anything when a disk it writes to lacks room", () => {
    const { out, said } = onFakeHost(`
NEW="$(build new 149)"
KIN_DATA_FREE=$((5 * 1024 * 1024 * 1024))
df() { echo "Filesystem 1-blocks Used Available Capacity Mounted"; echo "/dev/data 0 0 $KIN_DATA_FREE 0% /home"; }
SPACE_HEADROOM=$((5 * 1024 * 1024 * 1024))
${deploy}
echo "current $(basename "$(readlink "$CURRENT")")"
echo "stops $(cat "$HOME/calls" 2>/dev/null | grep -c 'stop kin-server')"
SPACE_HEADROOM=0
space_short && echo "room once the headroom fits"
KIN_DATA_FREE=100
space_short $((1024 * 1024))`);
    expect(out, said).toEqual([
      "status 1",
      "current old",
      "stops 0",
      "room once the headroom fits",
      "/home has 100 free, and the update needs 1.1M there (the database backup, room to migrate and roll back the database, the new build, and 0 to spare)",
    ]);
    expect(said).toMatch(
      /^update\.sh: not enough disk space: \/home has 5\.0G free, and the update needs 5\.1G there \(the database backup, room to migrate and roll back the database, and 5\.0G to spare\)\. Nothing changed; the server still runs \S+\/old\.$/m,
    );
  });

  it("keeps 3 update backups while the nightly backup is good and recent, else 10", () => {
    const { out } = onFakeHost(`
now=$(date +%s%3N)
for status in "" '"ok":true,"lastGoodAt":'$((now - 3600000)) '"ok":true,"lastGoodAt":'$((now - 37 * 3600000)) '"ok":false,"lastGoodAt":'$((now - 3600000)); do
  mkdir -p "$BACKUP_DIR" && rm -f "$BACKUP_DIR"/* "$BACKUP_STATUS"
  [ -z "$status" ] || echo "{\"ranAt\":$now,$status,\"bytes\":1,\"error\":\"\"}" >"$BACKUP_STATUS"
  for n in $(seq -w 1 12); do touch "$BACKUP_DIR/statev2-202601\${n}T000000Z-aaaaaaaaaaaa.sqlite"; done
  prune_backups
  echo "kept $(ls "$BACKUP_DIR" | wc -l | tr -d ' ')"
done`);
    expect(out).toEqual(["kept 10", "kept 3", "kept 10", "kept 10"]);
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

  it("keeps the previous build running when the web app the build packaged isn't Kin's", () => {
    const repoRoot = NodePath.resolve(import.meta.dirname, "..");
    // A whole update from main: the repo, mise and the build are stubs; the brand check is real.
    const update = (packaged: string) =>
      onFakeHost(`
SHA="$(printf 'c%.0s' {1..40})"
# origin/kin moved on after the release check passed $SHA.
TIP="$(printf 'd%.0s' {1..40})"
NEW="$BUILDS/$SHA"
export KIN_UPDATE_HANDED_OVER=1
mkdir -p "$REPO" && touch "$REPO/.env" "$HOME/calls"
id() { if [ "$1" = -un ]; then echo kin; else command id "$@"; fi; }
git() {
  case "$*" in
    *"branch --show-current"*) echo kin ;;
    *"rev-parse --verify --quiet $SHA^{commit}"*) echo "$SHA" ;;
    *rev-parse*) echo "$TIP" ;;
    *"worktree add"*)
      build "$SHA" 149 >/dev/null && rm "$NEW/apps/server/dist/bin.mjs" && touch "$NEW/.env.example"
      echo '{ "engines": { "node": "24.13.1" } }' >"$NEW/package.json"
      ln -s "${repoRoot}/scripts" "$NEW/scripts" ;;
    *"worktree remove"*) return 1 ;;
  esac
}
mise() {
  [ "$1" = exec ] || return 0
  shift 3
  case "$*" in
    "vp run build:desktop") package ;;
    "node scripts/kin-served-brand.ts"*) shift && "${process.execPath}" "$@" || return ;;
  esac
}
TITLE=Kin SHORT_NAME=Kin FAVICON="${repoRoot}/branding/assets/apps/web/public/favicon.ico"
package() {
  local client=apps/server/dist/client
  mkdir -p "$client" apps/server/dist/visual-lib
  touch apps/server/dist/bin.mjs apps/server/dist/visual-lib/{echarts,mermaid,d3}.js
  cp "${repoRoot}"/branding/assets/apps/web/public/* "$client"
  cp "$FAVICON" "$client/favicon.ico"
  printf '<!doctype html><html><head><title>%s</title><link rel="icon" href="/favicon.ico"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="manifest" href="/manifest.webmanifest"></head></html>' "$TITLE" >"$client/index.html"
  printf '{ "name": "Kin", "short_name": "%s", "icons": [{ "src": "/icon-192x192.png" }] }' "$SHORT_NAME" >"$client/manifest.webmanifest"
}
${packaged}
(main "$SHA"); echo "status $?"
echo "current $(basename "$(readlink "$CURRENT")")"
echo "stops $(grep -c 'stop kin-server' "$HOME/calls")"`);

    const good = update("");
    expect(good.out, good.said).toEqual([
      expect.stringMatching(/apps\/server\/dist\/client is named Kin and has Kin's icons$/),
      "status 0",
      `current ${"c".repeat(40)}`,
      "stops 1",
    ]);
    expect(good.said).toContain("origin/kin has moved on to dddddddddddd; deploying cccccccccccc");
    for (const [packaged, problem] of [
      ['TITLE="T3 Code (Beta)"', 'index.html: <title> is "T3 Code (Beta)", not "Kin"'],
      ["SHORT_NAME=T3", 'manifest.webmanifest: short_name is "T3", not "Kin"'],
      // What the server build's development icon override copies over the client.
      [
        `FAVICON="${repoRoot}/assets/dev/blueprint-web-favicon.ico"`,
        "favicon.ico is not Kin's icon",
      ],
    ] as const) {
      const { out, said } = update(packaged);
      expect(out, said).toEqual(["status 1", "current old", "stops 0"]);
      expect(said).toContain(problem);
      expect(said).toContain("failed; the server still runs");
    }
  });

  it("deploys the commit it is given, and the tip only when told to", () => {
    const { out, said } = onFakeHost(`
unset -f git
git init -q -b kin "$HOME/origin" && cd "$HOME/origin"
git -c user.name=Rhea -c user.email=rhea@ambermill.test commit -q --allow-empty -m checked
CHECKED="$(git rev-parse HEAD)"
git -c user.name=Rhea -c user.email=rhea@ambermill.test commit -q --allow-empty -m "merged after the check"
TIP="$(git rev-parse HEAD)"
git clone -q -b kin "$HOME/origin" "$REPO" && cd "$HOME"
(deploy_target) || echo "no commit: refused"
[ "$(deploy_target --tip)" = "$TIP" ] && echo "--tip: the tip"
[ "$(deploy_target "\${CHECKED:0:12}")" = "$CHECKED" ] && echo "named: the checked commit"
(deploy_target 0123456789ab) || echo "unknown: refused"`);
    expect(out, said).toEqual([
      "no commit: refused",
      "--tip: the tip",
      "named: the checked commit",
      "unknown: refused",
    ]);
    expect(said).toContain("name the commit the release check passed: update.sh <commit>.");
    expect(said).toContain("origin/kin has moved on to");
    expect(said).toContain("0123456789ab is not a commit in");
  });

  it("hands over to the merged script once, when the merge changed it", () => {
    const { out } = onFakeHost(`
mkdir -p "$REPO/ops/kin/host"
cp "$SCRIPT" "$REPO/ops/kin/host/update.sh"
(hand_over first); echo "same script: stayed"
echo 'echo "merged script ran: $KIN_UPDATE_HANDED_OVER $*"' >"$REPO/ops/kin/host/update.sh"
(hand_over a b)
(KIN_UPDATE_HANDED_OVER=1; hand_over c); echo "second time: stayed"`);
    expect(out).toEqual(["same script: stayed", "merged script ran: 1 a b", "second time: stayed"]);
  });

  it("reads the port from service.env", () => {
    const { out } = onFakeHost(`
printf 'T3CODE_LAN=true\\nexport T3CODE_PORT="4100"\\n' >"$SERVICE_ENV"
server_url`);
    expect(out).toEqual(["http://127.0.0.1:4100"]);
  });
});

describe("kin retire-workers.sh", () => {
  it("prints a restart that reaches kin's user manager from a bare login shell", () => {
    const retire = NodePath.resolve(import.meta.dirname, "../ops/kin/host/retire-workers.sh");
    const { out, said } = onFakeHost(`
grep -q 'restart kin-server: $(restart_hint)' "${retire}" || echo "leftovers print another restart"
eval "$(sed -n '/^restart_hint()/p' "${retire}")"
KIN_USER="$(id -un)"
mkdir -p "$HOME/stubs"
printf '#!/bin/sh\\necho "systemctl $* XDG_RUNTIME_DIR=\${XDG_RUNTIME_DIR:-unset}" >>"$HOME/calls"\\n' >"$HOME/stubs/systemctl"
chmod +x "$HOME/stubs/systemctl"
: >"$HOME/calls"
env -i HOME="$HOME" PATH="$HOME/stubs:$PATH" LC_ALL=C bash --noprofile --norc -l -c "$(restart_hint)"
tail -n1 "$HOME/calls"`);
    expect(out, said).toEqual([
      `systemctl --user restart kin-server XDG_RUNTIME_DIR=/run/user/${process.getuid?.()}`,
    ]);
  });
});
