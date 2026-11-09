# Kin shadow dry run

> For maintainers operating a Kin host. The task is LEAD-14 in [the lead spec](../kin/specs/lead.md#tasks).

`apps/server/scripts/kin-shadow-dry-run.ts` replays a recorded day of events through the real Kin path at L0: the event queue and coalescer, the wake-up runner, the lead tools, the level gate, shadow entries, the memory writer, routine content and the summary cards. No model runs. Each lead turn replays the tool calls recorded in the day file, so a run costs nothing and gives the same result every time.

It works in a fresh state directory with its own database, and never opens `~/.t3`. It refuses a `--state-dir` that is `~/.t3` or anything inside it (through a symlink or a different letter case too), one that isn't empty, and an unset `HOME`. It reads nothing from GitHub. The routine cards use the day file's GitHub snapshot, and `request_action` never reads a PR below L3.

A run goes in this order:

1. It refuses if `refs/heads/kin/shadow/<agentId>` already exists on the memory remote.
2. It mirror-clones the memory remote into `<state dir>/memory-mirror.git`.
3. It replays the day against that local mirror. Nothing in the replay knows the real remote's URL or credential.
4. It runs three checks against the mirror, and exits non-zero unless all pass:
   - the only ref created or moved is `refs/heads/kin/shadow/<agentId>`;
   - no agent or system message reached any chat except the owner's direct chat;
   - nothing ran: no worker, no pending action, and no thread except the lead's.
5. Only with `--push`, and only if every check passed, it makes its one write to the real remote: `git push <memory-url> <sha>:refs/heads/kin/shadow/<agentId>`, with no `+`. It prints the full SHA and confirms the remote reports it.

Without `--push`, nothing outside the state directory changes. Run that first.

## Run it against the fixture first

On the Kin host, as `kin`, from a build that has had `vp i` (for example `~/kin-current`):

```sh
cd ~/kin-current/apps/server
node scripts/kin-shadow-dry-run.ts \
  --day scripts/kin-shadow-dry-run.day.json \
  --state-dir "$(mktemp -d)/state" \
  --push
```

With no `--memory-url`, the script makes a local bare remote from the day file's `memory` inside the state directory, and `--push` writes only to that. This proves the build before you touch the real repository.

## Run it against `GLDRoger/kin-memory`

The script ignores system and global git config, so it can't use your `gh` login. Give it the `kin` user's memory credential by one of these flags. Each takes a path or a name, never a secret: the script refuses a value with shell syntax, such as an inline `!` helper, `;`, `$` or `~`. Never put a credential in the day file, the repository or this page.

- SSH: `--ssh-command`, a plain `ssh` command naming the deploy key with write access to `GLDRoger/kin-memory`. It becomes `GIT_SSH_COMMAND`. Keep the key outside `~/.ssh`, for example `/home/kin/.config/kin/kin-memory-deploy-key`, mode `0600`. The approvals credential hygiene check ([approvals spec, section 12](../kin/specs/approvals.md#12-credential-hygiene-check)) probes every key in `~/.ssh`, and a deploy key there fails it as `non_bot_identity`.
- HTTPS: `--credential-helper`, the name or absolute path of a git credential helper on the host. A GitHub App installation-token helper is not available yet.

Use an agent id that no real lead has. The script can't see the live lead registry, which is in `~/.t3`, so it only refuses an id whose shadow branch already exists. Before the run, check with the same credential:

```sh
GIT_SSH_COMMAND="ssh -i /home/kin/.config/kin/kin-memory-deploy-key -o IdentitiesOnly=yes" \
  git ls-remote git@github.com:GLDRoger/kin-memory.git refs/heads/kin/shadow/kin-dry-run
echo "exit $?"
```

`exit 0` with no ref printed means the branch doesn't exist and the key works. An auth failure also prints no ref, so read the exit code: it prints `git@github.com: Permission denied (publickey).` or `ERROR: Repository not found.`, then `fatal: Could not read from remote repository.`, and exits `128`.

Then do a first run with no push:

```sh
cd ~/kin-current/apps/server
node scripts/kin-shadow-dry-run.ts \
  --day scripts/kin-shadow-dry-run.day.json \
  --state-dir "$(mktemp -d)/state" \
  --agent-id kin-dry-run \
  --memory-url git@github.com:GLDRoger/kin-memory.git \
  --ssh-command "ssh -i /home/kin/.config/kin/kin-memory-deploy-key -o IdentitiesOnly=yes"
```

If it ends in `PASS`, rerun it with a fresh `--state-dir` and `--push` to write the shadow branch. For HTTPS, use `--memory-url https://github.com/GLDRoger/kin-memory.git --credential-helper <helper name or absolute path>` instead.

The lead's memory reads and the morning brief come from the real repository. The fixture day's writes are synthetic: a commitment, a deferral and journal lines, all committed to the shadow branch. A recorded call that names an item the real memory lacks is printed as `refused`. That doesn't fail the run. `--verbose` shows the server's logs.

Git against a real remote can hang on a network stall, and the script's timeouts don't fire because it runs on a test clock. Press Ctrl-C to stop it.

A passing run doesn't prove the live Kin server can reach `kin-memory`: the script passes its own credential. The server's own setting is `KIN_MEMORY_SSH_COMMAND` or `KIN_MEMORY_CREDENTIAL_HELPER`, which a separate change adds to [the Kin host README](../../ops/kin/host/README.md).

## What the output looks like

```text
Kin shadow dry run: 2026-11-09, lead kin-dry-run at L0
Memory remote: git@github.com:GLDRoger/kin-memory.git
Local mirror: /tmp/tmp.X/state/memory-mirror.git

Replay:
  08:30 routine brief
  08:30 wake-up 1
  09:05 message owner-morning
  09:05 wake-up 2
         kin_chat_post: ok
  10:15 message sam-review
  10:15 wake-up 3
         kin_chat_post: shadowed
         request_action: shadowed
         memory_write: ok
  ...

Owner's direct chat:
  08:30 Kin: Morning brief, Mon 9 Nov
    [morning_brief card, 2026-11-09]
  09:05 Fixture Lead: Rate limits start today at 10:00, ...
  10:15 Kin: What Fixture Lead would have done today
    [shadow_summary card] What Fixture Lead would have done today
      - kin_chat_post -> team: I've asked the owner to review #7 before lunch. ...
  18:30 Kin: Evening summary, Mon 9 Nov
  18:30 Kin: Review what Fixture Lead would have done today: 0 of 3 reviewed, 3 unreviewed

Local mirror refs:
  + refs/heads/kin/shadow/kin-dry-run (new) -> 46febb6a859b0bc043279f9fb32ca51105cfb226

Checks:
  PASS: only refs/heads/kin/shadow/kin-dry-run written, nothing posted outside the owner's direct chat, nothing executed.

Push:
  + refs/heads/kin/shadow/kin-dry-run 46febb6a859b0bc043279f9fb32ca51105cfb226 -> git@github.com:GLDRoger/kin-memory.git
```

A failed run ends its checks in `FAIL`, lists every violation, for example `The mirror ref refs/heads/main changed; only refs/heads/kin/shadow/kin-dry-run may.`, and pushes nothing.

## Clean up

The push is the only write the script can make, so the shadow branch is the only thing to undo. Delete it with the same credential, naming the full SHA the run printed so you delete only what it pushed, then check that it's gone and remove the state directory:

```sh
GIT_SSH_COMMAND="ssh -i /home/kin/.config/kin/kin-memory-deploy-key -o IdentitiesOnly=yes" \
  git push --force-with-lease=refs/heads/kin/shadow/kin-dry-run:<full sha> \
  git@github.com:GLDRoger/kin-memory.git :refs/heads/kin/shadow/kin-dry-run
GIT_SSH_COMMAND="ssh -i /home/kin/.config/kin/kin-memory-deploy-key -o IdentitiesOnly=yes" \
  git ls-remote git@github.com:GLDRoger/kin-memory.git refs/heads/kin/shadow/kin-dry-run
rm -rf <state dir>
```

Over HTTPS, run the same two git commands as `git -c credential.helper= -c credential.helper=<helper> ...` against `https://github.com/GLDRoger/kin-memory.git`.

## Recording another day

The day file is JSON, and every value in it is invented. It has the lead's name, the people and group chats to seed, the worker projects, a GitHub snapshot for the routine cards, the fixture `memory` files, and `events`. Each event is a `message`, `routine`, `github` or `watchdog` at a UTC time. An event's `lead` list holds the tool calls the lead makes in the wake-up that handles it. In tool arguments, `$ownerChat`, `$event`, `$chat` and `$message` stand for the owner's direct chat, the event id, and the event's chat and message. See [`kin-shadow-dry-run.day.json`](../../apps/server/scripts/kin-shadow-dry-run.day.json).
