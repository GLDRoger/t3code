# Kin host

Runs the Kin server from a source build on the always-on Linux machine, as the dedicated `kin` user. Design and reasons: [triggers spec, "Running on the Kin host"](../../../docs/kin/specs/triggers.md#running-on-the-kin-host).

| File                                      | What it does                                                                                                                           |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `setup.sh`                                | As root: creates `kin`, turns on linger, masks sleep, installs and enables the units, prints a checklist. `--dry-run` changes nothing. |
| `kin-server.service`                      | The server, as a systemd user unit for `kin`.                                                                                          |
| `backup.sh`, `kin-backup.{service,timer}` | Nightly backup to an encrypted volume, keeping 14 days.                                                                                |
| `update.sh`                               | As `kin`: pull, install, contract tests, build, restart.                                                                               |
| `restore.md`                              | The restore drill.                                                                                                                     |

## Install

1. As the owner, from any clone of this repo: `sudo ops/kin/host/setup.sh`. It creates `kin` and reports what is still missing.
2. As `kin` (`sudo -iu kin`), install the tools in kin's own home so the owner's logins never reach it:
   - mise: `curl https://mise.run | sh` (it lands in `~/.local/bin`), then `mise install node@<engines.node from package.json>`.
   - `vp` ([Vite+](https://viteplus.dev/guide/)), Claude Code and Codex. Sign the two CLIs in to the owner's plans.
   - `git`, `gh`, `git-filter-repo`, `gitleaks` and `sqlite3` come from the distribution, system-wide.
3. As `kin`: `git clone https://github.com/GLDRoger/t3code ~/t3code && cd ~/t3code && git switch kin && cp .env.example .env && vp i && vp run build:desktop`.
4. As the owner: `sudo ~kin/t3code/ops/kin/host/setup.sh` again. It starts the server and every check should pass.

### How the unit finds Node

`ExecStart` runs `/usr/bin/env mise exec node@${KIN_NODE_VERSION} -- node …`. systemd doesn't expand variables in the executable path, so `env` finds `mise` on the unit's `PATH` (`~/.local/bin` first, then the system directories). `setup.sh` and `update.sh` write `KIN_NODE_VERSION` from the checkout's `engines.node` into `~/.config/kin/kin-server.env`, so a Node bump in the repo moves the server with it. The unit's `PATH` also includes mise's shims, so the server finds npm-installed CLIs.

`KIN_ENABLED=true` is set in the unit. Owner overrides such as `T3CODE_LAN=true` go in `~/.t3/service.env`, which the unit reads and the backup copies.

## Link the laptop and phone

Use `connect link`, not `up --connect`. On Linux with systemd, `up` installs the upstream background service: it downloads the pinned upstream release that matches the version and writes `~/.config/systemd/user/t3.service`. That would be a second server on kin's state.

```bash
cd ~/t3code && node apps/server/dist/bin.mjs connect link --base-dir ~/.t3 --headless
systemctl --user restart kin-server
```

Then turn on **Hold webhooks while offline** for this environment in Settings, from any client.

## Update

As `kin`: `~/t3code/ops/kin/host/update.sh`. It runs `git pull --ff-only && vp i`, then `(cd apps/server && vp test run kin-contract)`, then `vp run build:desktop`, refreshes the units and the Node version, and runs `systemctl --user restart kin-server`. If any step fails, the server keeps running the old build.

## Backups

Put the destination in `~kin/.config/kin/backup.env`:

```bash
KIN_BACKUP_DEST=/mnt/backup/kin
# Only if the destination is encrypted in a way lsblk can't see (not LUKS/dm-crypt):
# KIN_BACKUP_FLAGS=--i-know-dest-is-encrypted
```

The timer does nothing until that file exists. Run one by hand with `systemctl --user start kin-backup` and read the result with `journalctl --user -u kin-backup`.

## Operating

As `kin`, from a login shell (`sudo -iu kin`, or `sudo -u kin XDG_RUNTIME_DIR=/run/user/$(id -u kin) systemctl --user …`):

- `systemctl --user status kin-server` and `journalctl --user -u kin-server -f`
- `systemctl --user restart kin-server`. Running agent turns stop.
