# Kin host

Runs the Kin server from a source build on the always-on Linux machine, as the dedicated `kin` user. Design and reasons: [triggers spec, "Running on the Kin host"](../../../docs/kin/specs/triggers.md#running-on-the-kin-host).

| File                                      | What it does                                                                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setup.sh`                                | As root: creates `kin`, turns on linger, masks sleep, installs and enables the units, prints a checklist. `--dry-run` changes nothing.            |
| `kin-server.service`                      | The server, as a systemd user unit for `kin`.                                                                                                     |
| `backup.sh`, `kin-backup.{service,timer}` | Nightly backup of `~/.t3/userdata` and `service.env` to an encrypted volume, keeping 14 days.                                                     |
| `update.sh`                               | As `kin`: builds `kin` in its own worktree, runs the contract tests, then switches `~/kin-current` to it and restarts. Also does the first build. |
| `restore.md`                              | The restore drill.                                                                                                                                |

## A kin shell

Every `kin` step below runs in a kin shell. `sudo -iu kin` starts no user session, so point `systemctl --user` at kin's user manager first:

```bash
sudo -iu kin
export XDG_RUNTIME_DIR=/run/user/$(id -u)
```

`update.sh` sets this itself.

## Install

1. As the owner, from any clone of this repo: `sudo ops/kin/host/setup.sh`. It creates `kin`, installs the units and reports what is still missing.
2. In a kin shell, install the tools in kin's own home so the owner's logins never reach it:
   - mise: `curl https://mise.run | sh` (it lands in `~/.local/bin`), then `mise use -g node@<engines.node from package.json>`. The global default puts npm-installed CLIs such as `codex` on mise's shims, which the unit's `PATH` includes. A Node bump in the repo installs the new Node, but globals installed under the old one don't move: rerun `mise use -g node@<new>` and reinstall them.
   - `vp` ([Vite+](https://viteplus.dev/guide/)), Claude Code and Codex. Sign the two CLIs in to the owner's plans.
   - `git`, `gh`, `git-filter-repo`, `gitleaks` and `sqlite3` come from the distribution, system-wide.
3. In a kin shell: `git clone https://github.com/GLDRoger/t3code ~/t3code && cd ~/t3code && git switch kin && cp .env.example .env && ops/kin/host/update.sh`. That builds the first release into `~/kin-builds/<sha>`, points `~/kin-current` at it and starts the server.
4. As the owner: `sudo ~kin/t3code/ops/kin/host/setup.sh` again. Every check should pass.

`~/t3code` is only the clone `update.sh` fetches into. The server runs from `~/kin-current`, a link to a finished build.

### How the unit finds Node

`ExecStart` runs `/usr/bin/env mise exec node@${KIN_NODE_VERSION} -- node …`. systemd doesn't expand variables in the executable path, so `env` finds `mise` on the unit's `PATH` (`~/.local/bin` first, then mise's shims, then the system directories). `setup.sh` and `update.sh` write `PATH`, `KIN_ENABLED=true`, `KIN_CHECKOUT=~/kin-current` and `KIN_NODE_VERSION` (the build's `engines.node`) into `~/.config/kin/kin-server.env`, so a Node bump in the repo moves the server with it.

Owner overrides such as `T3CODE_LAN=true` go in `~/.t3/service.env`, which the unit reads and the backup copies. The unit reads it before `kin-server.env`, so it can't change `PATH`, the build or the Node version.

## Link the laptop and phone

Use `connect link`, not `up --connect`. On Linux with systemd, `up` installs the upstream background service: it downloads the pinned upstream release that matches the version and writes `~/.config/systemd/user/t3.service`. That would be a second server on kin's state.

```bash
node ~/kin-current/apps/server/dist/bin.mjs connect link --base-dir ~/.t3 --headless
systemctl --user restart kin-server
```

Then turn on **Hold webhooks while offline** for this environment in Settings, from any client.

## Update

In a kin shell: `~/t3code/ops/kin/host/update.sh`. It fetches `kin` and builds it in a fresh worktree, `~/kin-builds/<sha>`: `vp i`, then `(cd apps/server && vp test run kin-contract)`, then `vp run build:desktop`. The running build is never touched. Only after every step passes does it refresh the units and the Node version, switch `~/kin-current` to the new build and run `systemctl --user restart kin-server`. A failed step deletes the half-built worktree and the server keeps running the old build. It keeps the 3 newest builds.

After the restart it waits 15 seconds and fails if the server isn't still up with no restarts, printing the rollback command.

To roll back: `ln -sfn ~/kin-builds/<previous-sha> ~/kin-current.new && mv -T ~/kin-current.new ~/kin-current && systemctl --user restart kin-server`. Use the absolute path `update.sh` printed, with no trailing slash. If the Node version changed, re-run `sudo ops/kin/host/setup.sh`, which rewrites `KIN_NODE_VERSION` from `~/kin-current`.

## Backups

Put the destination in `~kin/.config/kin/backup.env`:

```bash
KIN_BACKUP_DEST=/mnt/backup/kin
# Only if the destination is encrypted in a way lsblk can't see (not LUKS/dm-crypt):
# KIN_BACKUP_FLAGS=--i-know-dest-is-encrypted
```

The destination must be a mounted volume of its own: `backup.sh` refuses one on the same filesystem as `~/.t3`, or on `/`, which is what an unmounted mountpoint looks like. The encryption override doesn't skip that check.

The timer does nothing until that file exists. Run one by hand with `systemctl --user start kin-backup` and read the result with `journalctl --user -u kin-backup`.

## Operating

In a kin shell:

- `systemctl --user status kin-server` and `journalctl --user -u kin-server -f`
- `systemctl --user restart kin-server`. Running agent turns stop.
