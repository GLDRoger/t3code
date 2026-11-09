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
   - `git`, `gh`, `git-filter-repo`, `gitleaks`, `sqlite3`, `pkg-config`, `libsecret-1-dev` and `gcc` come from the distribution, system-wide. `update.sh` builds the desktop bundle, which compiles a small native helper against libsecret.
3. In a kin shell: `git clone https://github.com/GLDRoger/t3code ~/t3code && cd ~/t3code && git switch kin && cp .env.example .env && ops/kin/host/update.sh`. That builds the first release into `~/kin-builds/<sha>`, points `~/kin-current` at it and starts the server.
4. As the owner: `sudo ~kin/t3code/ops/kin/host/setup.sh` again. Every check should pass.

`~/t3code` is only the clone `update.sh` fetches into. The server runs from `~/kin-current`, a link to a finished build.

### How the unit finds Node

`ExecStart` runs `/usr/bin/env mise exec node@${KIN_NODE_VERSION} -- node …`. systemd doesn't expand variables in the executable path, so `env` finds `mise` on the unit's `PATH` (`~/.local/bin` first, then mise's shims, then the system directories). `setup.sh` and `update.sh` write `PATH`, `KIN_ENABLED=true`, `KIN_CHECKOUT=~/kin-current` and `KIN_NODE_VERSION` (the build's `engines.node`) into `~/.config/kin/kin-server.env`, so a Node bump in the repo moves the server with it.

Owner overrides such as `T3CODE_LAN=true` go in `~/.t3/service.env`, which the unit reads and the backup copies. The unit reads it before `kin-server.env`, so it can't change `PATH`, the build or the Node version.

## Memory repo access

Memory git ignores the system and global git config, so the host's credential helpers and `GIT_SSH_COMMAND` don't reach it. Give it a credential through `~/.t3/service.env`. The whole server and its agents see these variables, but only memory git turns them into `GIT_SSH_COMMAND` or a credential helper. Without one, cloning a private memory repo fails and every wake-up fails with it.

**SSH (use this for now).** Add a deploy key with write access to the memory repo only, and keep the private key outside `~/.ssh`:

```bash
install -d -m 700 ~/.config/kin
ssh-keygen -t ed25519 -N '' -C kin-memory -f ~/.config/kin/kin-memory-deploy-key
chmod 600 ~/.config/kin/kin-memory-deploy-key
```

Then in `~/.t3/service.env`:

```bash
KIN_MEMORY_SSH_COMMAND="ssh -i /home/kin/.config/kin/kin-memory-deploy-key -o IdentitiesOnly=yes"
```

Point `KIN_MEMORY_REPOSITORIES` at the SSH URL (`git@github.com:<owner>/<memory repo>.git`), make sure `~/.ssh/known_hosts` holds GitHub's host key, and restart `kin-server`. The key stays out of `~/.ssh` because the approvals credential check tries every key there against GitHub, and a deploy key's greeting names a repo instead of the bot, so the check fails with `non_bot_identity` and privileged actions stop. **The key is not contained.** Agents run as `kin` and can read the file, so a prompt-injected lead or worker can push to the memory repo directly, around Kin's memory writer and its rules (owner-only `rules.md`, server-set trust, secret scanning, L0 writes only on `kin/shadow/*`). Until Kin runs memory git as a separate OS user, contain it on GitHub:

- While every lead is at L0, protect `main` in the memory repo with a ruleset that requires a pull request and the `memory-check` workflow, with no bypass for this deploy key. The key can then update every ref except `main`, so a branch it pushes is never trusted on its own (see `ops/kin/memory-repo/README.md`, Workflow permissions).
- Don't raise any lead to L1 (whose memory writes Kin merges into `main`) until memory git runs as a separate OS user whose key agents can't read. This is the same gap as the approval key (approvals spec, section 12) and has the same fix.

**HTTPS.** Set `KIN_MEMORY_CREDENTIAL_HELPER` to a git credential helper's name or absolute path, with an `https://` repo URL. There is no GitHub App installation-token helper yet, so this route has nothing to point at until one is written.

Both values must name a credential, never hold it: the server refuses to start Kin when the helper is an inline `!` script, or when the SSH command isn't `ssh` with plain arguments (shell syntax, `ProxyCommand`, `LocalCommand`, `-F`, `-J` and options that weaken host-key checks are refused). It appends `-F none -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityAgent=none`, so `~/.ssh/config` and the agent are ignored and nothing prompts, and it never logs either value.

## Link the laptop and phone

Use `connect link`, not `up --connect`. On Linux with systemd, `up` installs the upstream background service: it downloads the pinned upstream release that matches the version and writes `~/.config/systemd/user/t3.service`. That would be a second server on kin's state.

```bash
node ~/kin-current/apps/server/dist/bin.mjs connect link --base-dir ~/.t3 --headless
systemctl --user restart kin-server
```

Then turn on **Hold webhooks while offline** for this environment in Settings, from any client.

## Create the first lead

A fresh host has no lead, so the phone shows "No chats yet". Pair the phone first (above), then in a kin shell find its session id:

```bash
KIN_ENABLED=true node ~/kin-current/apps/server/dist/bin.mjs auth session list --base-dir ~/.t3
```

Create the lead with that session as its owner:

```bash
KIN_ENABLED=true node ~/kin-current/apps/server/dist/bin.mjs kin lead create --base-dir ~/.t3 \
  --session <session id> --name <lead name> \
  --strong codex:<model> --cheap codex:<model> \
  --worker-project <project id>
```

The lead starts at L0 with a direct chat to you. Models are `<provider instance id>:<model>`. Repeat `--worker-project` for each project its workers may use, or leave it out; `project add` prints a project's id. Instead of `--session` you can pass `--person kin-default-owner`. Either one has to resolve to the Kin owner.

Running it again changes nothing and prints the existing lead. A host has one live lead, so a second one is refused until you retire the first. It's safe while `kin-server` runs; a phone that's already open shows the new chat once it reconnects.

- `kin lead list` shows every lead with its level, owner chat and whether it's retired.
- `kin lead retire <agent id>` retires one. Its rows and chat stay. Its Kin tool calls are refused at once. A running server expires its queued events and ends its thread once any current wake-up finishes (up to 15 minutes; pause Kin to halt it sooner), or at its next start if it's stopped. After that, `kin lead create` makes a new lead.

## Update

In a kin shell: `~/t3code/ops/kin/host/update.sh`. It fetches `kin` and builds it in a fresh worktree, `~/kin-builds/<sha>`: `vp i`, then `(cd apps/server && vp test run kin-contract)`, then `vp run build:desktop`. The running build is never touched. Only after every step passes does it refresh the units and the Node version, switch `~/kin-current` to the new build and run `systemctl --user restart kin-server`. A failed step deletes the half-built worktree and the server keeps running the old build. It keeps the 3 newest builds.

After the restart it waits 15 seconds. If the server isn't still up with no restarts, it switches `~/kin-current` and the Node version back to the previous build, restarts it and exits non-zero. On a first install there is nothing to go back to, so it stops `kin-server` and removes `~/kin-current`; the next run rebuilds. A failed build stays in `~/kin-builds` for inspection until the next good update. Unit files are not rolled back; if a failed build changed one, re-run `sudo ops/kin/host/setup.sh` after the rollback.

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
