# Kin host

Runs the Kin server from a source build on the always-on Linux machine, as the dedicated `kin` user. Design and reasons: [triggers spec, "Running on the Kin host"](../../../docs/kin/specs/triggers.md#running-on-the-kin-host).

| File                                              | What it does                                                                                                                                                                      |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setup.sh`                                        | As root, from `/root/kin-ops`: creates `kin`, turns on linger, masks sleep, installs and enables the units, installs T3's policy (`/etc/t3code/policy.json`), prints a checklist. |
| `kin-server.service`                              | The server, as a systemd user unit for `kin`.                                                                                                                                     |
| `backup.sh`, `kin-backup.{service,timer}`         | Nightly backup of `~/.t3/userdata` and `service.env` to an encrypted volume, keeping 14 days.                                                                                     |
| `update.sh`                                       | As `kin`: builds `kin` in its own worktree, runs the contract tests, then switches `~/kin-current` to it and restarts. Also does the first build.                                 |
| `restore.md`                                      | The restore drill.                                                                                                                                                                |
| `retire-workers.sh`                               | As root, once: removes what the retired workers installed and lists what they left in kin's files; keeps the GitHub App.                                                          |
| `clean-temp.sh`, `kin-temp-clean.{service,timer}` | Hourly: removes kin's old temporary files (see Storage).                                                                                                                          |

## A kin shell

Every `kin` step below runs in a kin shell. `sudo -iu kin` starts no user session, so point `systemctl --user` at kin's user manager first:

```bash
sudo -iu kin
export XDG_RUNTIME_DIR=/run/user/$(id -u)
```

`update.sh` sets this itself.

## Install

Root runs only scripts from a **root-owned clone**, `/root/kin-ops`. A clone `kin` or your own user can write would hand root to whoever changes it, so `setup.sh` refuses to run from one, or below any directory that isn't root-owned or is writable by others. Before each root step, refresh it as root: `sudo git -C /root/kin-ops pull --ff-only`.

0. As the owner: `sudo git clone --branch kin https://github.com/GLDRoger/t3code /root/kin-ops`.
1. As the owner: `sudo /root/kin-ops/ops/kin/host/setup.sh`. It creates `kin`, installs the units and reports what is still missing. `--dry-run` changes nothing.
2. In a kin shell, install the tools in kin's own home so the owner's logins never reach it:
   - mise: `curl https://mise.run | sh` (it lands in `~/.local/bin`), then `mise use -g node@<engines.node from package.json>`. The global default puts npm-installed CLIs such as `codex` on mise's shims, which the unit's `PATH` includes. A Node bump in the repo installs the new Node, but globals installed under the old one don't move: rerun `mise use -g node@<new>` and reinstall them.
   - `vp` ([Vite+](https://viteplus.dev/guide/)), Claude Code and Codex. Sign the two CLIs in to the owner's plans.
   - `git`, `gh`, `git-filter-repo`, `gitleaks`, `sqlite3`, `pkg-config`, `libsecret-1-dev` and `gcc` come from the distribution, system-wide. `update.sh` builds the desktop bundle, which compiles a small native helper against libsecret.
3. In a kin shell: `git clone https://github.com/GLDRoger/t3code ~/t3code && cd ~/t3code && git switch kin && cp .env.example .env && ops/kin/host/update.sh <commit>`, with the commit the release check passed (`--tip` takes `kin`'s tip unchecked). That builds the first release into `~/kin-builds/<sha>`, points `~/kin-current` at it and starts the server.
4. As the owner: `sudo git -C /root/kin-ops pull --ff-only && sudo /root/kin-ops/ops/kin/host/setup.sh` again. Every check should pass. Never run root scripts from `~kin/t3code`: kin owns it.

`~/t3code` is only the clone `update.sh` fetches into. The server runs from `~/kin-current`, a link to a finished build.

### How the unit finds Node

`ExecStart` runs `/usr/bin/env mise exec node@${KIN_NODE_VERSION} -- node …`. systemd doesn't expand variables in the executable path, so `env` finds `mise` on the unit's `PATH` (`~/.local/bin` first, then mise's shims, then the system directories). `setup.sh` and `update.sh` write `PATH`, `KIN_ENABLED=true`, `KIN_CHECKOUT=~/kin-current`, `KIN_NODE_VERSION` (the build's `engines.node`) and `TMPDIR` (see Storage) into `~/.config/kin/kin-server.env`, so a Node bump in the repo moves the server with it.

Owner overrides such as `T3CODE_LAN=true` go in `~/.t3/service.env`, which the unit reads and the backup copies. The unit reads it before `kin-server.env`, so it can't change `PATH`, the build or the Node version.

On a phone, the invite page offers to open the join link in the app at `kin://`. A fork whose app registers another scheme sets `KIN_APP_SCHEME` (such as `kin-preview`) in `~/.t3/service.env` and restarts kin-server.

Team memory is the owner's switch in **Settings → Memory**, taking effect on the next reply. Until the owner sets it once, `KIN_TEAM_MEMORY=on` in `~/.t3/service.env` is its starting value (unset or any other value is off): while it is off, a chat other people read gets no memory at all, and your own chats, the Memory page and its suggestions work as before.

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

Point `KIN_MEMORY_REPOSITORIES` at the SSH URL (`git@github.com:<owner>/<memory repo>.git`), make sure `~/.ssh/known_hosts` holds GitHub's host key, and restart `kin-server`. Keeping the key out of `~/.ssh` keeps it to the memory repo alone. **Who can read the key.** Anything that runs as `kin`: Kin's server, and an agent's shell in a turn only the owner and co-owners read that has read no outside text (chats with other people, and turns that read outside text, get no shell). Keep GitHub's own containment as a second wall:

- While every lead is at L0, protect `main` in the memory repo with a ruleset that requires a pull request and the `memory-check` workflow, with no bypass for this deploy key. The key can then update every ref except `main`, so a branch it pushes is never trusted on its own (see `ops/kin/memory-repo/README.md`, Workflow permissions).
- Raising a lead to L1 (whose memory writes Kin merges into `main`) wants a key no agent can read. An owner-only turn's shell can read this one, so L1 gives that agent's shell `main` too. It stays the owner's call.

**HTTPS.** Set `KIN_MEMORY_CREDENTIAL_HELPER` to a git credential helper's name or absolute path, with an `https://` repo URL.

Both values must name a credential, never hold it: the server refuses to start Kin when the helper is an inline `!` script, or when the SSH command isn't `ssh` with plain arguments (shell syntax, `ProxyCommand`, `LocalCommand`, `-F`, `-J` and options that weaken host-key checks are refused). It appends `-F none -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityAgent=none`, so `~/.ssh/config` and the agent are ignored and nothing prompts, and it never logs either value.

## Link the laptop and phone

Use `connect link`, not `up --connect`. On Linux with systemd, `up` installs the upstream background service: it downloads the pinned upstream release that matches the version and writes `~/.config/systemd/user/t3.service`. That would be a second server on kin's state.

```bash
node ~/kin-current/apps/server/dist/bin.mjs connect link --base-dir ~/.t3 --headless
systemctl --user restart kin-server
```

## Create the first lead

A fresh host has no lead, so the phone shows "No chats yet". Pair the phone first (above), then in a kin shell find its session id:

```bash
KIN_ENABLED=true node ~/kin-current/apps/server/dist/bin.mjs auth session list --base-dir ~/.t3
```

Create the lead with that session as its owner:

```bash
KIN_ENABLED=true node ~/kin-current/apps/server/dist/bin.mjs kin lead create --base-dir ~/.t3 \
  --session <session id> --name <lead name> \
  --model claudeAgent:<model>
```

The lead starts at L0 with a direct chat to you. Models are `<provider instance id>:<model>`, and both must be Claude instances: a lead runs only on Claude. Instead of `--session` you can pass `--person kin-default-owner`. Either one has to resolve to the Kin owner.

A charter says what the lead does, in the words the lead should use with you. Write what it does itself, not what it hands away: a lead told it "never does another lead's work" will send you to ask someone else. For a chief of staff, something like: "The owner's chief of staff and front door. Takes any request and answers it from what it can read: repos, PRs, CI and memory. Keeps one agenda across leads, runs reminders and routines, and sends a short daily brief." Change one later with `kin lead charter <agent id> --charter <text>`; it applies at the lead's next turn.

Running it again with the same name and domain changes nothing and prints the existing lead. A host can run several live leads: give each its own `--domain <slug>` (default `engineering`) and `--charter <text>`. When `--model` is left out, a new lead uses the company default, else the first live lead's model. Older notes say `--strong`, which still works. It's safe while `kin-server` runs; a phone that's already open shows the new chat once it reconnects.

- `kin lead list` shows every lead with its level, owner chat and whether it's retired.
- `kin lead character` lists each lead's character doc; `--agent <agent id> --file <path>` or `--from-dir <dir>` sets characters from Markdown files on the host, as a new version each. See [Setting agents' characters](../../../docs/operations/kin-characters.md).
- `kin lead retire <agent id>` retires one and `kin lead restore <agent id>` brings it back; the owner's last lead can't be retired. Nothing is deleted. Its queued events expire, its timers and schedules pause and its approval requests close at once; a running server stops its current turn within a minute, or at its next start if it's stopped.

## Approve from the phone

Level raises need your signature from a phone's approval key. Any phone paired as you can become one: only the genuine Kin app on a real phone can make a key Kin accepts, and only your own session can register it.

1. Pair the phone (above). On it, open Kin, then Approvals, and tap **Set up approvals on this phone**. It makes a key in the phone's secure hardware, and the phone can approve straight away. Every approval asks for Face ID.
2. Kin posts a notice in your own chat (the chief of staff's, if you have one) and pushes it to your phones, saying which phone and when. If that wasn't you, remove it.

**Settings → Approvals** in Kin on the web or desktop, and **Approvals** in the phone app, list the phones that can approve and the last few changes. Remove a lost phone there; anything it approved that hadn't run yet is cancelled. You can remove the last one, and then nothing can be approved until a phone is set up again. At most 10 phones can approve at once.

The host must recognise the Kin app: set `KIN_IOS_APP_ID` (`<teamId>.<bundleId>`) and, for Android, `KIN_ANDROID_PACKAGE` and `KIN_ANDROID_SIGNING_CERT_SHA256` in `~/.t3/service.env`. Without them every phone is refused. `KIN_IOS_APP_ATTEST_DEVELOPMENT=true` also accepts development builds of the iPhone app; leave it unset on a real host. Simulators are always refused.

## Phone notifications

iPhones are notified through Apple (the `KIN_APNS_*` lines in `~/.t3/service.env`; see [the mobile spec](../../../docs/kin/specs/mobile.md)). Android phones are notified through Firebase Cloud Messaging:

1. Download a service-account key (JSON) for the Firebase project the Android app is registered in (Project settings, Service accounts), copy it to the host as `~/.config/kin/fcm-service-account.json`, owned by kin with `chmod 600`, outside any checkout. The nightly backup doesn't copy it; a lost key is replaced by downloading a new one.
2. Add `KIN_FCM_SERVICE_ACCOUNT_FILE=/home/kin/.config/kin/fcm-service-account.json` (its full path) to `~/.t3/service.env`, then `systemctl --user restart kin-server`. The log says `Kin push to Android is on.`; without the line it says Android push is off once, and Android phones get nothing.

## Reply latency

Each wake-up logs one `Kin wake-up latency` line with every stage's ms since its first message was queued: claimed, memory prepared, provider launched, first token, reply posted. Wake-ups from before warm sessions were removed still group as `warm`. For p50 and p90 over the last 20 owner-message wake-ups, read the database without writing to it:

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

The lead's working line shows in the chat as soon as the message is queued, before any of these stages.

## Connect GitHub from the phone

Kin watches your repos with your own login, held by `gh` on this host. In the Kin app (or on the web), **Settings → Connections → GitHub → Connect**, then **Get a code**, open GitHub, enter the code and authorize, granting your organizations if GitHub asks. A classic token with `repo`, `read:org` and `workflow` works instead of a code. The server runs `gh auth login` and `gh auth setup-git` as kin, and Kin checks your repos about once a minute for what should wake an agent.

**Disconnect** signs this host out of GitHub; revoke GitHub CLI under GitHub's Settings → Applications to end it there too.

### Agents work as Kin's GitHub App

With a GitHub App set up, agents' commits, pushes, pull requests, comments and reviews show the App as author, with the agent's name on each commit (`Kin-Agent:`) and post. Repos the App isn't installed on, and any command an agent runs with `kin-as-owner`, go out as you; Connections lists those runs. Without an App, everything goes out as you. Kin asks GitHub for tokens without administration, secrets, hooks or member permissions, so the App can't change a repo's settings, access or secrets. Its tokens can still merge and approve as far as GitHub is concerned: an agent's `gh` and `git` refuse to, and refuse pushes to a default branch, but they run in the same shell that can read those tokens, so they aren't a lock. Branch protection on each default branch (pull requests only, a review from someone other than the App) is what stops a merge you didn't make.

To set one up, open **Settings → Connections → GitHub → Create Kin's GitHub App** as the owner or a co-owner. Kin names it ("Kin for <company>", which you can change), sends your browser to GitHub with the App filled in (no webhook; Contents, Pull requests, Issues and Checks read and write; Actions and Metadata read), and when you choose **Create GitHub App** GitHub sends you back. Kin keeps the key in its secret store, `~/.t3/userdata/secrets/` (owner-only files, kept by backups like every other secret), and starts using the App straight away, with no restart. Then install it from the account rows. The App is made public when you watch an organisation's repos, since a private App installs only on the account that owns it. **Disconnect the App** makes Kin forget the App and its key; the App itself stays on GitHub until you delete it from its settings page, which Kin links to.

Create is the way. Only if your browser can't reach GitHub and Kin in one go, or you already have an App you want Kin to use, set it up by hand as a fallback:

1. On GitHub, Settings → Developer settings → GitHub Apps → New GitHub App, with the permissions above and no webhook. Make it public (its settings → Advanced) to use it on organisations. Generate a private key.
2. As kin, put the key in Kin's secret store:

   ```bash
   APP_ID=<app id> KEY=<path to the .pem> node -e 'const fs = require("fs"); const dir = `${process.env.HOME}/.t3/userdata/secrets`; fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.writeFileSync(`${dir}/kin-github-app-${process.env.APP_ID}.bin`, JSON.stringify({ privateKeyPem: fs.readFileSync(process.env.KEY, "utf8") }), { mode: 0o600 })'
   ```

   Then delete the `.pem`.

3. Add `KIN_GITHUB_APP_ID=<app id>` and `KIN_GITHUB_BOT_LOGIN=<app slug>[bot]` to `~/.t3/service.env`, then `systemctl --user restart kin-server`. These lines only hand the App to Kin: on its next look at GitHub Kin adopts it into Settings → Connections, which owns it from then on. Disconnect and making another work there, a Disconnect stays after a restart even with the lines still set, and once Connections shows the App you may delete them.

The key stays in the server; agents' shells only ever hold one-hour tokens. Hosts that kept the key in kin's keyring (the `kin-github-app` item) keep working: when the secret store has no key, Kin reads that item and copies it into the store once. The item stays in the keyring; once Connections shows the App working you may delete it, or keep it as a spare.

**Hosts set up before November 2026** still carry the retired workers. Once `update.sh` has built a current `kin`, run `sudo /root/kin-ops/ops/kin/host/retire-workers.sh` to see what it would remove, then again with `--yes`. It removes the `kin-worker` user, its units, sudoers entry and mount, and never touches kin's home, `~/.t3`, the database or backups. It then lists what only you remove: the `KIN_WORKER_*` lines in `~/.t3/service.env`, the `kin-owner-merge` keyring item and the "Kin · GitHub App" scheduled task. Keep the App: if Settings → Connections → GitHub doesn't show it yet, leave its `KIN_GITHUB_*` lines and the `kin-github-app` keyring item until it does, since Kin adopts the App from them on its next look.

## Documents

Files an agent asks for (`kin_document`: invoices, the accountant's pack, reports) are made by kin-server from the org's recipes, in the call that asks for them.

- Each org's recipes are a git repository in `~/.t3/userdata/kin/workspaces/`, made from Kin's three starter recipes on first use and never pushed anywhere. It is backed up with the rest of `~/.t3/userdata`. A recipe change an agent makes is committed there by kin-server, with its history.
- Typst 0.15.1 is fetched from its GitHub release the first time a recipe needs it, checked against the checksum pinned in kin-server, and kept in `~/.t3/kin-tools/`; an agent's shell can read it and finds it on its PATH. Unpacking needs `tar` with xz support (`xz-utils`). On a host without internet, put the release's `typst` in `~/.t3/kin-tools/typst-0.15.1/` with its archive's SHA-256 in a `.sha256` file beside it.
- A job's worktree, `~/.t3/worktrees/kin-documents/<job>`, holds its inputs while it runs and is removed once kin-server has taken the files back.

## Update

In a kin shell: `~/t3code/ops/kin/host/update.sh <commit>`, with the commit the release check passed. It fetches `kin` and builds that commit in a fresh worktree, even when `kin` has moved on since the check. Without a commit it refuses and names `kin`'s tip; `--tip` deploys the tip unchecked. The worktree is `~/kin-builds/<sha>`, and the steps are `vp i`, then `(cd apps/server && vp test run kin-contract)`, then `node scripts/kin-brand.ts --scope web --in-place` (the web app it serves is named Kin, with Kin's icons; the server itself stays unbranded), then `vp run build:desktop`, then `node scripts/kin-served-brand.ts apps/server/dist/client` (the packaged web app the server serves has Kin's title, manifest names and icons). The running build is never touched. A failed step deletes the half-built worktree and the server keeps running the old build.

Before building, and again before stopping anything, it checks that each disk it writes to has room for the build, the database backup and twice the database beside it, with 1 GiB to spare, and stops with a sentence naming the short disk if not. Only after every step passes does it wait for agents' running turns and a running nightly dream to end, up to 2 minutes, saying how many it waits for; past that it stops the server anyway, and a stopped turn saves what it had noted to memory as it stops. Then it stops `kin-server`, backs the database up into `~/kin-update-backups` (or `$KIN_UPDATE_BACKUPS`; the 10 newest are kept, or 3 while the nightly backup last succeeded within 36 hours), refreshes the units and the Node version, switches `~/kin-current` and starts the server. It then checks that the service stays up with no restarts, answers on its port (`T3CODE_PORT` from `~/.t3/service.env`, else 3773), and that the database reached the build's highest T3 and Kin migrations. If not, it switches `~/kin-current` and the Node version back to the previous build, restores the backup when the failed build had migrated the database (keeping that copy as `statev2.sqlite.failed-<sha>`), restarts it and exits non-zero. On a first install there is nothing to go back to, so it leaves `kin-server` stopped and removes `~/kin-current`; the next run rebuilds. A failed build stays in `~/kin-builds` for inspection until the next good update. It keeps the 3 newest builds. Unit files are not rolled back; if a failed build changed one, re-run `sudo /root/kin-ops/ops/kin/host/setup.sh` after the rollback (refresh `/root/kin-ops` to the build you rolled back to first).

`update.sh` builds with the steps of the copy you run, and it hands over to the fetched copy only when the copy you run already knows how. An older copy builds the new commit its own way, without Kin's name and without the check. So before the first update that brings the Kin name and its check:

1. Fast-forward the clone the script lives in: `git -C ~/t3code fetch origin +refs/heads/kin:refs/remotes/origin/kin && git -C ~/t3code merge --ff-only origin/kin` (if `~/.config/kin/kin-server.env` sets `KIN_REPO`, do steps 1 to 3 in that clone instead).
2. Confirm the script now has the hand-over: `grep -n 'hand_over' ~/t3code/ops/kin/host/update.sh` shows it.
3. Then run `~/t3code/ops/kin/host/update.sh <commit>`.

If a host already runs the right commit built without the name (the tab says T3 Code, and `update.sh` says `already running <sha>`), running it again does not repair that build. Deploy a newer commit of `kin`. Don't delete files inside the running build to force a rebuild: the server runs from that directory.

Before deploying, run the release check on this Mac: [Releasing Kin](../../../docs/operations/kin-release.md).

To roll back: `ln -sfn ~/kin-builds/<previous-sha> ~/kin-current.new && mv -T ~/kin-current.new ~/kin-current && systemctl --user restart kin-server`. Use the absolute path `update.sh` printed, with no trailing slash. If the build you leave had migrated the database, stop the server first and copy the newest `~/kin-update-backups/statev2-*.sqlite` over `~/.t3/userdata/statev2.sqlite`, after moving that file and its `-wal` and `-shm` aside. If the Node version changed, re-run `sudo /root/kin-ops/ops/kin/host/setup.sh`, which rewrites `KIN_NODE_VERSION` from `~/kin-current`.

## Backups

Put the destination in `~kin/.config/kin/backup.env`:

```bash
KIN_BACKUP_DEST=/mnt/backup/kin
# Only if the destination is encrypted in a way lsblk can't see (not LUKS/dm-crypt):
# KIN_BACKUP_FLAGS=--i-know-dest-is-encrypted
```

The destination must be a mounted volume of its own: `backup.sh` refuses one on the same filesystem as `~/.t3`, or on `/`, which is what an unmounted mountpoint looks like. The encryption override doesn't skip that check.

The timer does nothing until that file exists. Each run records its outcome in `~/.t3/userdata/kin-backup-status.json`; when the last good backup is over 36 hours old, or there is none, Kin tells the owner in their Chief of staff chat, once a day. Run one by hand with `systemctl --user start kin-backup` and read the details with `journalctl --user -u kin-backup`.

## Storage

Kin's temporary files live on the main disk in `~/.cache/kin-tmp`, not in `/tmp`, which on many hosts is a small part of memory with a per-user limit. `setup.sh` and `update.sh` create the folder and set `TMPDIR` to it in `~/.config/kin/kin-server.env`, so the server, its agents and `update.sh`'s own build all use it. For another folder, set `TMPDIR=<absolute path>` in `~/.t3/service.env`: the next `update.sh` or `setup.sh` copies it into `kin-server.env`, which the unit reads last, and the restart applies it.

Every hour `kin-temp-clean.timer` runs `clean-temp.sh`. It removes kin's own top-level files and folders in `/tmp` and in Kin's temp folder that nothing inside has changed for 24 hours, or for 2 hours while that disk, or kin's quota on it, has less than 20% left (a git checkout always gets the full 24 hours, since an agent may have unpushed work in it). It never removes what a running kin process is working in, has open or listens on, anything another user owns, or anything outside those two folders. Run it by hand with `systemctl --user start kin-temp-clean`; `journalctl --user -u kin-temp-clean` shows one line a run saying how many items it removed and how much space came back.

Each wake-up also checks the free space on the disks holding Kin's temp folder, `/tmp` and `~/.t3`. When one has less than 20% free, the log gets a `Kin host is low on space` warning with the figures, and Kin tells the owner in their Chief of staff chat, once a day, that Kin's computer is running low on space. If a wake-up fails because the disk or quota is full, Kin tells the owner, once a day, that Kin's computer has run out of temporary space and agents can't run until some is freed. The free-space check sees the whole disk, not kin's quota on it; only the hourly clean reads the quota. To free space at once, run the clean by hand, then see what is left with `du -sh /tmp/* ~/.cache/kin-tmp/* 2>/dev/null | sort -h | tail` and remove what you know is no longer needed. `update.sh` prunes old builds and update backups itself.

## Operating

In a kin shell:

- `systemctl --user status kin-server` and `journalctl --user -u kin-server -f`
- `systemctl --user restart kin-server`. Running agent turns stop.
