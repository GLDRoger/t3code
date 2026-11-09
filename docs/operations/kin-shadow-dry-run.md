# Kin shadow dry run

> For maintainers operating a Kin host. The task is LEAD-14 in [the lead spec](../kin/specs/lead.md#tasks).

`apps/server/scripts/kin-shadow-dry-run.ts` replays a recorded day of events through the real Kin path at L0: the event queue and coalescer, the wake-up runner, the lead tools, the level gate, shadow entries, the memory writer, routine content and the summary cards. No model runs. Each lead turn replays the tool calls recorded in the day file, so a run costs nothing and gives the same result every time.

It works in a fresh state directory with its own database, and never opens `~/.t3`. It refuses a `--state-dir` that is `~/.t3` or anything inside it, including through a symlink, and one that isn't empty. Its only outside write is to the memory remote: commits on `kin/shadow/<agentId>`. It reads nothing from GitHub. The routine cards use the day file's GitHub snapshot, and `request_action` never reads a PR below L3.

It exits non-zero unless all three checks pass:

- the only remote ref it created or moved is `refs/heads/kin/shadow/<agentId>`;
- no agent or system message reached any chat except the owner's direct chat;
- nothing ran: no worker, no pending action, and no thread except the lead's.

## Run it against the fixture first

On the Kin host, as `kin`, from a build that has had `vp i` (for example `~/kin-current`):

```sh
cd ~/kin-current/apps/server
node scripts/kin-shadow-dry-run.ts \
  --day scripts/kin-shadow-dry-run.day.json \
  --state-dir "$(mktemp -d)/state"
```

With no `--memory-url`, the script makes a local bare remote from the day file's `memory` and pushes only to that. This proves the build before you touch the real repository.

## Run it against `GLDRoger/kin-memory`

The memory writer ignores system and global git config, so it can't use your `gh` login. Give it the `kin` user's memory credential by one of these flags. Never put a credential value in the day file, the repository or this page.

- SSH: `--ssh-command`, an `ssh` command that names the deploy key with write access to `GLDRoger/kin-memory`. It becomes `GIT_SSH_COMMAND`.
- HTTPS: `--credential-helper`, a git credential helper command that answers with the GitHub App's installation token.

Use an agent id that no real lead has, so the run can't touch a real lead's shadow week. First confirm that its branch doesn't exist yet. `git ls-remote` should print nothing:

```sh
git ls-remote git@github.com:GLDRoger/kin-memory.git refs/heads/kin/shadow/kin-dry-run
```

Then run:

```sh
cd ~/kin-current/apps/server
node scripts/kin-shadow-dry-run.ts \
  --day scripts/kin-shadow-dry-run.day.json \
  --state-dir "$(mktemp -d)/state" \
  --agent-id kin-dry-run \
  --memory-url git@github.com:GLDRoger/kin-memory.git \
  --ssh-command "ssh -i <deploy key path> -o IdentitiesOnly=yes"
```

For HTTPS, use `--memory-url https://github.com/GLDRoger/kin-memory.git --credential-helper '<helper command>'` instead.

The lead's memory reads and the morning brief come from the real repository. The fixture day's writes are synthetic: a commitment, a deferral and journal lines, all committed to the shadow branch. A recorded call that names an item the real memory lacks is printed as `refused`. That doesn't fail the run. `--verbose` shows the server's logs.

## What the output looks like

```text
Kin shadow dry run: 2026-11-09, lead kin-dry-run at L0
Memory remote: git@github.com:GLDRoger/kin-memory.git

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

Memory remote refs:
  + refs/heads/kin/shadow/kin-dry-run (new) -> 59e1f53feff1

Checks:
  PASS: only refs/heads/kin/shadow/kin-dry-run written, nothing posted outside the owner's direct chat, nothing executed.
```

A failed run ends in `FAIL` and lists every violation, for example `The remote ref refs/heads/main changed; only refs/heads/kin/shadow/kin-dry-run may.`

## Clean up

Delete the dry run's shadow branch with the same credential, check that it's gone, and remove the state directory:

```sh
GIT_SSH_COMMAND="ssh -i <deploy key path> -o IdentitiesOnly=yes" \
  git push git@github.com:GLDRoger/kin-memory.git --delete kin/shadow/kin-dry-run
git ls-remote git@github.com:GLDRoger/kin-memory.git refs/heads/kin/shadow/kin-dry-run
rm -rf <state dir>
```

## Recording another day

The day file is JSON, and every value in it is invented. It has the lead's name, the people and group chats to seed, the worker projects, a GitHub snapshot for the routine cards, the fixture `memory` files, and `events`. Each event is a `message`, `routine`, `github` or `watchdog` at a UTC time. An event's `lead` list holds the tool calls the lead makes in the wake-up that handles it. In tool arguments, `$ownerChat`, `$event`, `$chat` and `$message` stand for the owner's direct chat, the event id, and the event's chat and message. See [`kin-shadow-dry-run.day.json`](../../apps/server/scripts/kin-shadow-dry-run.day.json).
