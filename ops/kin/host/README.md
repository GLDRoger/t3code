# Kin host

Runs the Kin server from a source build on the always-on Linux machine, as the dedicated `kin` user. Design and reasons: [triggers spec, "Running on the Kin host"](../../../docs/kin/specs/triggers.md#running-on-the-kin-host).

| File                                      | What it does                                                                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setup.sh`                                | As root, from `/root/kin-ops`: creates `kin`, turns on linger, masks sleep, installs and enables the units, prints a checklist.                   |
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

Root runs only scripts from a **root-owned clone**, `/root/kin-ops`. A clone `kin`, `kin-worker` or your own user can write would hand root to whoever changes it, so `setup.sh` and `kin-worker.sh` refuse to run from one, or below any directory that isn't root-owned or is writable by others. Before each root step, refresh it as root: `sudo git -C /root/kin-ops pull --ff-only`.

0. As the owner: `sudo git clone --branch kin https://github.com/GLDRoger/t3code /root/kin-ops`.
1. As the owner: `sudo /root/kin-ops/ops/kin/host/setup.sh`. It creates `kin`, installs the units and reports what is still missing. `--dry-run` changes nothing.
2. In a kin shell, install the tools in kin's own home so the owner's logins never reach it:
   - mise: `curl https://mise.run | sh` (it lands in `~/.local/bin`), then `mise use -g node@<engines.node from package.json>`. The global default puts npm-installed CLIs such as `codex` on mise's shims, which the unit's `PATH` includes. A Node bump in the repo installs the new Node, but globals installed under the old one don't move: rerun `mise use -g node@<new>` and reinstall them.
   - `vp` ([Vite+](https://viteplus.dev/guide/)), Claude Code and Codex. Sign the two CLIs in to the owner's plans.
   - `git`, `gh`, `git-filter-repo`, `gitleaks`, `sqlite3`, `pkg-config`, `libsecret-1-dev` and `gcc` come from the distribution, system-wide. `update.sh` builds the desktop bundle, which compiles a small native helper against libsecret.
3. In a kin shell: `git clone https://github.com/GLDRoger/t3code ~/t3code && cd ~/t3code && git switch kin && cp .env.example .env && ops/kin/host/update.sh`. That builds the first release into `~/kin-builds/<sha>`, points `~/kin-current` at it and starts the server.
4. As the owner: `sudo git -C /root/kin-ops pull --ff-only && sudo /root/kin-ops/ops/kin/host/setup.sh` again. Every check should pass. Never run root scripts from `~kin/t3code`: kin owns it.

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

Running it again with the same name and domain changes nothing and prints the existing lead. A host can run several live leads: give each its own `--domain <slug>` (default `engineering`) and `--charter <text>`. When `--strong` and `--cheap` are left out, a new lead copies the first live lead's models. It's safe while `kin-server` runs; a phone that's already open shows the new chat once it reconnects.

- `kin lead list` shows every lead with its level, owner chat and whether it's retired.
- `kin lead projects <agent id> --worker-project <project id> ...` replaces a live lead's worker projects, keeping its chat and history; pass no `--worker-project` to clear them. Its next tool call sees the change: new and follow-up work in a removed project is refused, but a worker already running there keeps running until it ends or you stop it.
- `kin lead retire <agent id>` retires one. Its rows and chat stay. Its Kin tool calls are refused at once. A running server expires its queued events and ends its thread once any current wake-up finishes (up to 15 minutes; pause Kin to halt it sooner), or at its next start if it's stopped.

## Approve from the phone

Merges and level raises need your signature from a phone's approval key. The first key in an org is confirmed only here, on the host, by you in a kin shell. No client, remote session or agent can confirm one.

1. Pair the phone (above). On it, open Kin, then Approvals, and tap **Set up approvals**. It makes a key in the Secure Enclave and shows a 6-digit code and the key's thumbprint. The code works for 10 minutes and takes 5 tries.
2. In a kin shell:

   ```bash
   KIN_ENABLED=true node ~/kin-current/apps/server/dist/bin.mjs kin approvals confirm-key --base-dir ~/.t3
   ```

   It lists each phone waiting: device name, platform, hardware, the full key thumbprint, org and person, the session it registered from, and when its code runs out. Check the thumbprint against the phone, pick it (or pass `--key <thumbprint>`), and type the code.

3. On the phone, tap **Check again**. It now says "This phone approves for Kin".

Only attested keys are listed. A simulator, or a phone that couldn't prove its key is in secure hardware, never appears and can't approve. The command is safe while `kin-server` runs, and `--code <digits>` skips the prompt.

**A second phone.** Set it up the same way. Instead of a host step, the phone that already approves shows a card for it under Approvals, with its name, thumbprint and hardware. Approve that card with Face ID. Running `confirm-key` for it is refused while another key is active.

**A lost phone.** Set up the new phone, then run the same command with `--recover`. It revokes every other key you hold, voids anything they approved that hasn't run yet, and activates the new one. The audit log records each revoked key and the recovery (`key_revoked`, `key_confirmed`).

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

What a worker does get: its own checkouts and worktrees in `/home/kin-worker`, its own Claude and Codex logins, and at most read access to GitHub. **Workers hold no GitHub write credential**, so no worker can push, approve or merge anything. A build worker commits on `kin/worker/<worker id>` in its worktree. When its run ends, kin-server reads that branch through `kin-worker upload-pack` (root runs `git upload-pack` as kin-worker in the sandbox, read-only and capped at 512 MiB), checks it, and pushes it to GitHub itself with a Kin GitHub App `server` token it mints for that repository and never hands to an agent. Then it opens a draft PR and puts it on the task card and in the lead's report. Each publish fetches into a fresh scratch repository under kin's state directory, deleted afterwards, and is refused when the worker's objects take more than 1 GiB on disk. It publishes only `kin/worker/<id>`, refuses a branch with no new commits or with any commit, merges included, that changes `.github` or anything under it (workflows and composite actions; the App has no Workflows permission, so GitHub would refuse a workflow change too), and never publishes while Kin is paused: it checks again just before the push and before opening the PR. Without `KIN_GITHUB_APP_ID`, the commits stay in the worker environment and the report says so.

### Set up workers

Steps marked **root** need sudo. **account** marks one the owner creates outside the host. Run the installer only from `/root/kin-ops` (see [Install](#install)); it refuses a clone that isn't root-owned. After the first run, `/usr/local/sbin/kin-worker` (root-owned) does the rest. Root never writes, chowns or chmods anything under `/home/kin-worker`: the installer does that as kin-worker, so a symlink a worker plants there reaches only what kin-worker could change anyway.

1. **root:** `sudo git -C /root/kin-ops pull --ff-only` (the clone from step 0 of [Install](#install)).
2. **root:** `sudo /root/kin-ops/ops/kin/host/kin-worker.sh`. It creates `kin-worker` (home mode 700, not in group `kin`), sets `/home/kin` to mode 700, installs `/usr/local/sbin/kin-worker`, the units `kin-worker-server.service` and `kin-worker-link.{service,timer}`, and `/etc/sudoers.d/kin-worker`, which lets `kin` run exactly `systemctl stop`, `start` and `try-restart` on the worker unit and `kin-worker upload-pack <path>`. As kin-worker, it turns on Linked environments in the worker environment's settings and writes `~kin-worker/.claude/settings.json` with only the gateway URL and an `apiKeyHelper` that reads `~kin-worker/.config/kin-worker/gateway-key`. Then it starts the worker server on `127.0.0.1:3874` if Kin has a build and isn't paused. The gateway URL is `KIN_WORKER_GATEWAY_URL` when set (`sudo KIN_WORKER_GATEWAY_URL=https://... /root/kin-ops/...`), else the `ANTHROPIC_BASE_URL` in kin's Claude settings; nothing else is read from kin's file. A changed unit is reloaded and the server restarted. It prints a checklist; the first run fails it until the steps below are done. `--dry-run` changes nothing.
3. **root:** tools in kin-worker's own home, like kin's (step 2 of [Install](#install)): `sudo -iu kin-worker`, then `curl https://mise.run | sh`, `mise use -g node@<engines.node>`, `npm i -g @anthropic-ai/claude-code @openai/codex`. `git`, `gh`, `curl`, `python3`, `sqlite3`, iproute2 (`ss`) and util-linux (`nsenter`, `setpriv`) come from the distribution, system-wide. The worker unit's start check and `check`'s probes run only those root-owned copies, never anything on the worker's `PATH`.
4. **account, then root: Claude.** Create a gateway key for kin-worker alone, never kin's or yours. Write it as kin-worker: `sudo kin-worker run -- sh -c 'umask 077 && mkdir -p ~/.config/kin-worker && cat > ~/.config/kin-worker/gateway-key' < <key file>`, shred the file, then `sudo kin-worker run -- claude -p ok` should answer.
5. **account, then root: Codex.** Use a separate OpenAI account or an API key with a spending cap, never the owner's login or token. `sudo kin-worker run -- codex login` and sign in to that account, or `sudo kin-worker run -- codex login --with-api-key < <key file>`.
6. **GitHub: Kin publishes, workers only read.** Before you list any repo in `KIN_GITHUB_REPOS`, that repo's default branch must carry the CI guard: every workflow job that reads a secret skips `kin/worker/*` heads (`if: ${{ !startsWith(github.head_ref, 'kin/worker/') }}`, or `github.event.workflow_run.head_branch` for `workflow_run` jobs; see this repo's `.github/workflows`). A worker's PR runs that repo's workflows on the worker's code, so without the guard a worker gets the repo's secrets. The Kin GitHub App must **not** have the **Workflows** permission: Kin's refusal of `.github` changes is backed by GitHub refusing the push. Check it on GitHub under Settings → Developer settings → GitHub Apps → the Kin App → Permissions & events → Repository permissions, where Workflows must read "No access", and on each installation's Configure page, which must not list workflows. On kin-server, set `KIN_GITHUB_APP_ID` (the Kin GitHub App, approvals spec section 10), install the App on every worker repo, and list those repos in `KIN_GITHUB_REPOS` in `~kin/.t3/service.env`: Kin mints its `server` push token only for those. Public repos need nothing on the worker side; Kin's server publishes for workers. For a private repo, **account, then root:** a fine-grained token limited to the worker repos with **Contents: read** and nothing else, never a token with write, never the owner's, kin's or the App's. Then `sudo kin-worker run -- gh auth login --with-token < <token file>` (shred the file after) and `sudo kin-worker run -- gh auth setup-git`. No bot account needs write access to anything. **Hosts set up under the earlier steps,** where workers pushed as a bot account: delete that bot's fine-grained token (the bot's Settings → Developer settings → Personal access tokens → Fine-grained tokens) and remove the bot's Write access on the worker repos, then `sudo kin-worker run -- gh auth logout` and, for private repos, log in again with the read-only token above. `sudo kin-worker check` fails while kin-worker still holds a token that can push.
7. **Disk. root:** put `/home/kin-worker` on its own filesystem, or give `kin-worker` a disk quota, so a worker filling its home can't fill the disk kin-server, its database and its backups live on.
8. **Projects. root:** for each of the lead's worker projects, clone the same repository into the worker environment and register it there: `sudo kin-worker run -- git clone https://github.com/<owner>/<repo> /home/kin-worker/projects/<repo>`, then `sudo kin-worker run t3 project add /home/kin-worker/projects/<repo> --base-dir /home/kin-worker/.t3`. Kin matches a lead's worker project to the worker environment's project with the same repository, so `kin lead create --worker-project` keeps naming this host's project.
9. **Linked environments on kin-server:** Settings → Labs → Linked environments, from any client.
10. **root:** `sudo kin-worker link`. Links kin-server to `http://127.0.0.1:3874` with full access and writes `KIN_WORKER_ENVIRONMENT_ID` into `~kin/.t3/service.env`. Restart kin-server at a quiet moment, as it says. A link lasts 30 days; `kin-worker-link.timer` renews it weekly.
11. **root:** `sudo git -C /root/kin-ops pull --ff-only && sudo /root/kin-ops/ops/kin/host/kin-worker.sh` again, then `sudo kin-worker check`. Every line must be ✓ before a lead goes to L2.

**Network.** The sandbox denies cloud metadata (`169.254.0.0/16`), link-local, the tailnet (`100.64.0.0/10`, `fc00::/7`) and private LAN ranges. Loopback stays open, so the worker server answers kin-server and DNS through `127.0.0.53` works. If the Claude gateway or the DNS resolver is on one of those ranges, allow just that address: `sudo systemctl edit kin-worker-server` with

```ini
[Service]
IPAddressAllow=100.101.102.103
```

then `sudo systemctl restart kin-worker-server`. `kin-worker run` copies the unit's `IPAddressAllow`, so `check` and setup commands see the same network. The sandbox can't bind kin-server's port 3773, and the worker cgroup is capped at 60% of memory and 4096 tasks.

**What workers can read of Kin's build.** The build is mounted read-only at `/opt/kin-current`, including the `.env` that `update.sh` copies in. That file may hold only the public identifiers `.env.example` names; `update.sh` refuses to build when it sets anything else. Server settings and secrets go in `~kin/.t3/service.env`, which workers can't read.

`check` is the isolation transcript, and fails unless every line passes. It verifies the sandbox's **configuration**. It is not attestation against a hostile worker: a worker controls its own server, database and home, so it can keep a credential where no probe looks, or behave differently after `check` ran. Every probe runs root-owned system binaries (`/usr/bin/python3`, `sqlite3`, `curl`, `ss`, `/bin/sh`, `cat`), never the worker's `gh`, Python or T3, and root reads the worker's files only as kin-worker. Any error, an unreachable GitHub API included, fails the line.

First it checks what the probes stand on: kin-server and kin-worker-server are running (`kill -0` on each MainPID), no unit has a `daemon-reload` pending, and the running server has every sandbox setting of `kin-worker run` (compared through a throwaway unit, in systemd's own form). Then, as kin-worker, inside the running server's mount namespace (`nsenter`), in a fresh sandbox and as a plain login, it tries to read Kin's database, list `secrets` and `~/.config/kin`, read `service.env`, kin's Claude and Codex logins, kin-server's process environment, `/run/user/<kin uid>` and its `bus`, kin's keyring and the owner's home. In the sandbox it tries `sudo`, binding `127.0.0.1:3773` and `[::1]:3773`, and cloud metadata, and checks DNS still works. It calls kin-server's `/mcp`, `/kin/mcp`, `/ws` and auth endpoints with no credential and expects 401 or 403. It fails on any other listener or abstract socket of kin's, a file of kin's outside `/home` that everyone can read, a mode other than 700 or an ACL on either home, a gateway key kin-worker shares with kin, a token in the worker's Claude settings, a GitHub token in kin-worker's `gh` or git credential store that is kin's or that GitHub says can push to a repo in `KIN_GITHUB_REPOS` or Kin's own, a link in the worker environment's database (read-only), a worker server listening anywhere but `127.0.0.1:3874` (`ss`, from root), a worker unit without its pause condition, a sudoers entry other than the one above, and a `KIN_WORKER_ENVIRONMENT_ID` that isn't kin-server's link to `127.0.0.1:3874`. `KIN_URL=http://127.0.0.1:<port>` points it at kin-server when that isn't on 3773.

### Running workers

- `systemctl status kin-worker-server` and `journalctl -u kin-worker-server -f` (system units, as root).
- `update.sh` restarts the worker server after it switches `~kin/kin-current` (`try-restart`, so a stopped server stays stopped), so workers run kin-server's build. Running worker turns stop and continue as after any restart.
- **Pausing Kin stops the worker server.** kin-server first asks it to stop each worker, then always runs `systemctl stop kin-worker-server`, whatever it answered: every process in the unit ends, a thread or scheduled task a worker started on its own included. The unit's `ExecCondition` (`kin-worker may-start`, run as root) reads Kin's pause state as kin with the system `sqlite3` and keeps the unit from starting while any org is paused, at boot, on a restart and from a manual `systemctl start`. Resume starts it again. Until then nothing runs there, and nothing is published. A pause fails, and says so, only when systemd can't stop the unit. systemd doesn't retry a start that `ExecCondition` skipped, so if kin-server wasn't up yet when the host booted and the worker server stayed down, run `sudo systemctl start kin-worker-server` once kin-server is up.
- To watch a worker's thread, pair a client with the worker environment too: `sudo kin-worker run t3 pair --base-dir /home/kin-worker/.t3`. The port is loopback only, so reach it over SSH or Tailscale. Task cards update without it.
- The worker environment has no Kin budget of its own: worker token use isn't visible to kin-server over the link yet, so worker units don't grow. Each worker still needs budget left to start.

## Update

In a kin shell: `~/t3code/ops/kin/host/update.sh`. It fetches `kin` and builds it in a fresh worktree, `~/kin-builds/<sha>`: `vp i`, then `(cd apps/server && vp test run kin-contract)`, then `vp run build:desktop`. The running build is never touched. Only after every step passes does it refresh the units and the Node version, switch `~/kin-current` to the new build and run `systemctl --user restart kin-server`. A failed step deletes the half-built worktree and the server keeps running the old build. It keeps the 3 newest builds.

After the restart it waits 15 seconds. If the server isn't still up with no restarts, it switches `~/kin-current` and the Node version back to the previous build, restarts it and exits non-zero. On a first install there is nothing to go back to, so it stops `kin-server` and removes `~/kin-current`; the next run rebuilds. A failed build stays in `~/kin-builds` for inspection until the next good update. Unit files are not rolled back; if a failed build changed one, re-run `sudo /root/kin-ops/ops/kin/host/setup.sh` after the rollback (refresh `/root/kin-ops` to the build you rolled back to first).

To roll back: `ln -sfn ~/kin-builds/<previous-sha> ~/kin-current.new && mv -T ~/kin-current.new ~/kin-current && systemctl --user restart kin-server`. Use the absolute path `update.sh` printed, with no trailing slash. If the Node version changed, re-run `sudo /root/kin-ops/ops/kin/host/setup.sh`, which rewrites `KIN_NODE_VERSION` from `~/kin-current`.

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
