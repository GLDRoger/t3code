# Kin host

Runs the Kin server from a source build on the always-on Linux machine, as the dedicated `kin` user. Design and reasons: [triggers spec, "Running on the Kin host"](../../../docs/kin/specs/triggers.md#running-on-the-kin-host).

| File                                      | What it does                                                                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setup.sh`                                | As root: creates `kin`, turns on linger, masks sleep, installs and enables the units, prints a checklist. `--dry-run` changes nothing.            |
| `kin-server.service`                      | The server, as a systemd user unit for `kin`.                                                                                                     |
| `backup.sh`, `kin-backup.{service,timer}` | Nightly backup of `~/.t3/userdata` and `service.env` to an encrypted volume, keeping 14 days.                                                     |
| `update.sh`                               | As `kin`: builds `kin` in its own worktree, runs the contract tests, then switches `~/kin-current` to it and restarts. Also does the first build. |
| `restore.md`                              | The restore drill.                                                                                                                                |
| `kin-worker.sh`, `kin-worker-*`           | As root: the worker environment, where Kin's workers run as `kin-worker` in a sandbox with no view of Kin's state. See [Workers](#workers).       |

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

Point `KIN_MEMORY_REPOSITORIES` at the SSH URL (`git@github.com:<owner>/<memory repo>.git`), make sure `~/.ssh/known_hosts` holds GitHub's host key, and restart `kin-server`. The key stays out of `~/.ssh` because the approvals credential check tries every key there against GitHub, and a deploy key's greeting names a repo instead of the bot, so the check fails with `non_bot_identity` and privileged actions stop. **Who can read the key.** Leads have no shell, and workers run as `kin-worker` in a sandbox that has no `/home/kin` (see [Workers](#workers)), so no agent can read it. Kin's server process can, and so can anything else that runs as `kin`. Keep GitHub's own containment as a second wall:

- While every lead is at L0, protect `main` in the memory repo with a ruleset that requires a pull request and the `memory-check` workflow, with no bypass for this deploy key. The key can then update every ref except `main`, so a branch it pushes is never trusted on its own (see `ops/kin/memory-repo/README.md`, Workflow permissions).
- Raising a lead to L1 (whose memory writes Kin merges into `main`) needed a key no agent can read. With workers isolated and `sudo kin-worker check` all ✓, that holds; the server itself still holds the key, as it holds the approval key (approvals spec, section 12). L1 stays the owner's call.

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
  --strong claudeAgent:<model> --cheap claudeAgent:<model> \
  --worker-project <project id>
```

The lead starts at L0 with a direct chat to you. Models are `<provider instance id>:<model>`, and both must be Claude instances: a lead runs only on Claude. Repeat `--worker-project` for each project its workers may use, or leave it out. To register a checkout as a project, run `node ~/kin-current/apps/server/dist/bin.mjs project add <path> --base-dir ~/.t3`; it prints `Added project <project id>`, or fails naming the existing id if the path is already a project. Instead of `--session` you can pass `--person kin-default-owner`. Either one has to resolve to the Kin owner.

Running it again changes nothing and prints the existing lead. A host has one live lead, so a second one is refused until you retire the first. It's safe while `kin-server` runs; a phone that's already open shows the new chat once it reconnects.

- `kin lead list` shows every lead with its level, owner chat and whether it's retired.
- `kin lead projects <agent id> --worker-project <project id> ...` replaces a live lead's worker projects, keeping its chat and history; pass no `--worker-project` to clear them. Its next tool call sees the change: new and follow-up work in a removed project is refused, but a worker already running there keeps running until it ends or you stop it.
- `kin lead retire <agent id>` retires one. Its rows and chat stay. Its Kin tool calls are refused at once. A running server expires its queued events and ends its thread once any current wake-up finishes (up to 15 minutes; pause Kin to halt it sooner), or at its next start if it's stopped. After that, `kin lead create` makes a new lead.

## Reply latency

Each wake-up logs one `Kin wake-up latency` line with every stage's ms since its first message was queued: claimed, memory prepared, provider launched, first token, reply posted, and whether it was warm. For p50 and p90 over the last 20 owner-message wake-ups, read the database without writing to it:

```bash
sqlite3 -readonly ~/.t3/userdata/statev2.sqlite "
WITH w AS (
  SELECT * FROM kin_wakeups
  WHERE org_id = (SELECT org_id FROM kin_leads ORDER BY org_id LIMIT 1) AND enqueued_at IS NOT NULL
    AND EXISTS (SELECT 1 FROM kin_events e WHERE e.org_id = kin_wakeups.org_id
      AND e.wakeup_id = kin_wakeups.wakeup_id AND e.priority = 'P0' AND e.tag = 'chat.message')
  ORDER BY started_at DESC LIMIT 20
), s(warm, stage, ms) AS (
  SELECT resumed, '1 claimed', started_at - enqueued_at FROM w
  UNION ALL SELECT resumed, '2 prepared', prepared_at - enqueued_at FROM w
  UNION ALL SELECT resumed, '3 launched', launched_at - enqueued_at FROM w
  UNION ALL SELECT resumed, '4 first token', first_token_at - enqueued_at FROM w
  UNION ALL SELECT resumed, '5 posted', posted_at - enqueued_at FROM w
), r AS (
  SELECT warm, stage, ms, ROW_NUMBER() OVER (PARTITION BY warm, stage ORDER BY ms) AS n,
    COUNT(*) OVER (PARTITION BY warm, stage) AS c
  FROM s WHERE ms IS NOT NULL
)
SELECT CASE warm WHEN 1 THEN 'warm' ELSE 'cold' END AS session, stage, c AS wakeups,
  MAX(CASE WHEN n = (c + 1) / 2 THEN ms END) AS p50_ms,
  MAX(CASE WHEN n = (9 * c + 9) / 10 THEN ms END) AS p90_ms
FROM r GROUP BY warm, stage ORDER BY warm, stage;"
```

`seen` shows in the chat as soon as the message is queued, before any of these stages.

## Workers

Kin's lead hands coding work to worker threads. They have a full shell, so they never run on kin-server: they run in the **worker environment**, a plain T3 server with Kin off, as the `kin-worker` user, linked from kin-server. kin-server launches, follows and stops them over that link. A worker's shell runs in a systemd sandbox where `/home` is empty apart from `/home/kin-worker`, `/tmp` is its own, other users' processes are hidden and `sudo` can't raise privileges. Kin's build is mounted in read-only. So a worker can't read Kin's database, `~/.t3/userdata/secrets`, `~/.config/kin/*` (memory deploy key, APNs key, GitHub App key), `service.env`, kin's or the owner's logins, and can't run Kin's CLI against Kin's state (`auth session`, `kin lead projects`, direct SQL). It holds no credential for kin-server. `kin_delegate` refuses until a worker environment is configured.

What a worker does get: its own checkouts and worktrees in `/home/kin-worker`, its own Claude and Codex logins, and a GitHub token that can push branches and open pull requests but not merge.

### Set up workers

Steps marked **root** need sudo. **account** marks one the owner creates outside the host. Run the installer only from a **root-owned clone**: root runs what it installs, so a clone `kin`, `kin-worker` or your own user can write would hand root to whoever changes it. The installer refuses a clone, or any directory above it, that isn't root-owned or is writable by others. After the first run, `/usr/local/sbin/kin-worker` (root-owned) does the rest.

1. **root:** a root-owned clone: `sudo git clone --branch kin https://github.com/GLDRoger/t3code /root/kin-ops`. Update it with `sudo git -C /root/kin-ops pull --ff-only` before each later run.
2. **root:** `sudo /root/kin-ops/ops/kin/host/kin-worker.sh`. It creates `kin-worker` (home mode 700, not in group `kin`), sets `/home/kin` to mode 700, installs `/usr/local/sbin/kin-worker`, the units `kin-worker-server.service` and `kin-worker-link.{service,timer}`, and `/etc/sudoers.d/kin-worker`, turns on Linked environments in the worker environment's settings, writes `~kin-worker/.claude/settings.json` with only the gateway URL and an `apiKeyHelper` that reads `~kin-worker/.config/kin-worker/gateway-key`, and starts the worker server on `127.0.0.1:3874` if Kin has a build. The gateway URL is `KIN_WORKER_GATEWAY_URL` when set (`sudo KIN_WORKER_GATEWAY_URL=https://... /root/kin-ops/...`), else the `ANTHROPIC_BASE_URL` in kin's Claude settings; nothing else is read from kin's file. A changed unit is reloaded and the server restarted. It prints a checklist; the first run fails it until the steps below are done. `--dry-run` changes nothing.
3. **root:** tools in kin-worker's own home, like kin's (step 2 of [Install](#install)): `sudo -iu kin-worker`, then `curl https://mise.run | sh`, `mise use -g node@<engines.node>`, `npm i -g @anthropic-ai/claude-code @openai/codex`. `git`, `gh`, `curl`, `python3` and util-linux (`nsenter`, `setpriv`) are system-wide; `check` uses the last two.
4. **account, then root: Claude.** Create a gateway key for kin-worker alone, never kin's or yours. `sudo install -D -m 600 -o kin-worker -g kin-worker <key file> /home/kin-worker/.config/kin-worker/gateway-key`, shred the file, then `sudo kin-worker run -- claude -p ok` should answer.
5. **account, then root: Codex.** Use a separate OpenAI account or an API key with a spending cap, never the owner's login or token. `sudo kin-worker run -- codex login` and sign in to that account, or `sudo kin-worker run -- codex login --with-api-key < <key file>`.
6. **account, then root: GitHub.** Workers push with a token of their own, never the owner's or the GitHub App's. Use a separate bot account with Write on the worker repos, and a fine-grained token limited to those repos with Contents and Pull requests read and write. Protect with a ruleset that requires a pull request and an approving review and restricts updates, with no bypass for the bot: the default branch of every worker repo, and **both `kin` and `main`** of Kin's own repo if the bot can write to it. `update.sh` builds and runs `origin/kin` as `kin`, so a bot push to `kin` would be code running as Kin. Then **root:** `sudo kin-worker run -- gh auth login --with-token < <token file>` (shred the file after) and `sudo kin-worker run -- gh auth setup-git`.
7. **Projects. root:** for each of the lead's worker projects, clone the same repository into the worker environment and register it there: `sudo kin-worker run -- git clone https://github.com/<owner>/<repo> /home/kin-worker/projects/<repo>`, then `sudo kin-worker run t3 project add /home/kin-worker/projects/<repo> --base-dir /home/kin-worker/.t3`. Kin matches a lead's worker project to the worker environment's project with the same repository, so `kin lead create --worker-project` keeps naming this host's project.
8. **Linked environments on kin-server:** Settings → Labs → Linked environments, from any client.
9. **root:** `sudo kin-worker link`. Links kin-server to `http://127.0.0.1:3874` with full access and writes `KIN_WORKER_ENVIRONMENT_ID` into `~kin/.t3/service.env`. Restart kin-server at a quiet moment, as it says. A link lasts 30 days; `kin-worker-link.timer` renews it weekly.
10. **root:** `sudo /root/kin-ops/ops/kin/host/kin-worker.sh` again, then `sudo kin-worker check`. Every line must be ✓ before a lead goes to L2.

**Network.** The sandbox denies cloud metadata (`169.254.0.0/16`), link-local, the tailnet (`100.64.0.0/10`, `fc00::/7`) and private LAN ranges. Loopback stays open, so the worker server answers kin-server and DNS through `127.0.0.53` works. If the Claude gateway or the DNS resolver is on one of those ranges, allow just that address: `sudo systemctl edit kin-worker-server` with

```ini
[Service]
IPAddressAllow=100.101.102.103
```

then `sudo systemctl restart kin-worker-server`. `kin-worker run` copies the unit's `IPAddressAllow`, so `check` and setup commands see the same network. The sandbox can't bind kin-server's port 3773, and the worker cgroup is capped at 60% of memory and 4096 tasks.

**What workers can read of Kin's build.** The build is mounted read-only at `/opt/kin-current`, including the `.env` that `update.sh` copies in. That file may hold only the public identifiers `.env.example` names; `update.sh` refuses to build when it sets anything else. Server settings and secrets go in `~kin/.t3/service.env`, which workers can't read.

`check` is the isolation transcript, and fails unless every line passes. First it checks what the probes stand on: kin-server and kin-worker-server are running (`kill -0` on each MainPID), no unit has a `daemon-reload` pending, and the running server has every sandbox setting of `kin-worker run` (compared through a throwaway unit, in systemd's own form). Then, as kin-worker, inside the running server's mount namespace (`nsenter`), in a fresh sandbox and as a plain login, it tries to read Kin's database, list `secrets` and `~/.config/kin`, read `service.env`, kin's Claude and Codex logins, kin-server's process environment, `/run/user/<kin uid>` and its `bus`, kin's keyring and the owner's home. In the sandbox it tries `t3 auth session list` and `kin lead list` against `/home/kin/.t3`, `sudo`, binding `127.0.0.1:3773` and `[::1]:3773`, and cloud metadata, and checks DNS still works. It calls kin-server's `/mcp`, `/kin/mcp`, `/ws` and auth endpoints with no credential and expects 401 or 403. It fails on any other listener or abstract socket of kin's, a file of kin's outside `/home` that everyone can read, a mode other than 700 or an ACL on either home, a gateway key, GitHub login or token kin-worker shares with kin, a token in the worker's Claude settings, a bot token that could push to Kin's `kin` or `main`, any link of the worker environment's own, and a `KIN_WORKER_ENVIRONMENT_ID` that isn't kin-server's link to `127.0.0.1:3874`. `KIN_URL=http://127.0.0.1:<port>` points it at kin-server when that isn't on 3773.

### Running workers

- `systemctl status kin-worker-server` and `journalctl -u kin-worker-server -f` (system units, as root).
- `update.sh` restarts the worker server after it switches `~kin/kin-current` (the sudoers entry allows `kin` that one restart), so workers run kin-server's build. Running worker turns stop and continue as after any restart.
- Pausing Kin stops every worker kin-server tracks, in the worker environment. A stop that fails or hangs for 10 s makes kin-server kill the worker server (`systemctl kill -s SIGKILL`, the other command the sudoers entry allows); systemd starts it again and Kin stops any turn it continues. A thread or scheduled task a worker starts there on its own isn't tracked, so the pause doesn't reach it unless that kill does; stop it in that environment, and don't give the worker environment's own sessions to anyone else.
- To watch a worker's thread, pair a client with the worker environment too: `sudo kin-worker run t3 pair --base-dir /home/kin-worker/.t3`. The port is loopback only, so reach it over SSH or Tailscale. Task cards update without it.
- The worker environment has no Kin budget of its own: worker token use isn't visible to kin-server over the link yet, so worker units don't grow. Each worker still needs budget left to start.

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
