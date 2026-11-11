# Kin: handover brief

Read this first if you're joining Kin, whether you're a person or an agent. It tells you what exists, where it lives and how to run it. The specs hold the detail.

## What Kin is

Read [VISION.md](VISION.md) first. It's short, and it overrides any summary that treats Kin as a single-owner assistant.

In one line: Kin is a messaging app, built on [T3 Code](https://github.com/pingdotgg/t3code), from which the owner runs a company on his phone. AI leads (one per domain: engineering, growth, finance and so on) and people talk in DMs and groups. Leads decide, remember and follow up. The actual work runs in ordinary T3 threads ("workers"). Only the owner approves privileged actions, by signing on his phone.

[DESIGN.md](DESIGN.md) is the full design, [PLAN.md](PLAN.md) the roadmap, and [specs/](specs/) describe each area as built.

## Where the code lives

All Kin work is on branch `kin` of `GLDRoger/t3code`, a public fork. `main` mirrors upstream; never commit to it. [KIN.md](../../KIN.md) has the branch, sync and branding rules.

| Where                              | What                                                                                     |
| ---------------------------------- | ---------------------------------------------------------------------------------------- |
| `apps/server/src/kin/chat/`        | Chats, messages, members, identity, the live hub, task cards, chat RPCs                  |
| `apps/server/src/kin/floor/`       | Who may speak: `FloorManager` (pure rules) and `KinFloor` (runs and grants in SQLite)    |
| `apps/server/src/kin/lead/`        | The event queue, wake-up runner, prompt, permissions, budget, stop switch, workers, CLI  |
| `apps/server/src/kin/reply/`       | The reply bridge (lead text → chat messages) and presence ("thinking", "working")        |
| `apps/server/src/kin/memory/`      | Memory reads, the git writer, change cards and memory PRs                                |
| `apps/server/src/kin/dreaming/`    | The nightly dream                                                                        |
| `apps/server/src/kin/triggers/`    | Time triggers, deferrals, routines, watchdogs, pings, GitHub webhooks, the trigger inbox |
| `apps/server/src/kin/approvals/`   | `request_action`, pending actions, approver keys, grant checks, the executor, audit      |
| `apps/server/src/kin/github/`      | The GitHub App, rulesets and the owner's merge client                                    |
| `apps/server/src/kin/push/`        | Kin's own APNs sender                                                                    |
| `apps/server/src/kin/persistence/` | Kin's migration track (`kin_sql_migrations`, K001 onward)                                |
| `apps/server/src/kin/mcp/`         | The `/kin/mcp` endpoint that only registered agent threads get                           |
| `packages/contracts/src/kin*.ts`   | Schemas shared by server and clients                                                     |
| `packages/client-runtime/src/kin/` | Client logic shared by web and mobile                                                    |
| `apps/mobile/src/features/chats/`  | The mobile app's Kin screens                                                             |
| `apps/web/src/kin/`                | The web and desktop Kin screens                                                          |
| `ops/kin/host/`                    | Host install, update, backup and restore                                                 |

Kin code lives in its own files. Upstream files get a hook of a line or two at most, so upstream merges stay easy.

## How a message flows

1. **Chat.** A client calls `kin.messages.send`. `KinChatService` checks membership, stores the message with the next sequence number, and calls `KinFloor.open`, which opens a floor run and grants a turn. In a direct chat that is the lead; in a group it is the mentioned agent, and with no mention it will be the group's lead (W3-1). After commit, `KinChatHub` publishes the message to every member's stream.
2. **Queue.** `ChatWake` turns the message into a `chat.message` event in `KinEventQueue` (`kin_events`) and shows the lead's working line ("Catching up", or "Finishing something else" behind a running wake-up) at once. Triggers, worker reports and approval results become events the same way. Code sets each event's priority; an owner message is P0.
3. **Wake-up.** `WakeupRunner` waits briefly for a burst to finish, then claims a batch of events for one lead and one chat. It checks the stop switch and budget, prepares a read-only memory checkout, builds the prompt (`LeadPrompt`) and runs the lead as a T3 thread. A message that arrives during a wake-up is steered into it.
4. **Lead.** The lead runs on Claude with no shell. It acts only through Kin's MCP tools: memory, deferrals, workers, cards, `request_action`. Its plain text is its reply.
5. **Reply bridge.** `KinReplyBridge` reads the lead's text as it streams and posts it through `LevelGate`, so membership, the floor and permissions apply.
6. **Clients.** Members' streams deliver the reply, and `KinPushSender` pushes it to phones that aren't showing the chat.

The [lead spec](specs/lead.md) covers queue, wake-up and replies in full. The [chat spec](specs/chat.md) covers chats, streams and the floor.

## Memory

Memory is plain Markdown files with front matter in a private git repo per organization: rules, objectives, commitments, deferrals, decisions, people, claims and a journal. Only a lead writes it, and only inside a wake-up. Each wake-up's changes land as one commit through `MemoryWriter`, which scans for secrets and validates the writer checkout first. Nothing is deleted: items are marked invalid. Every item records who said it and with what trust. The owner sees a change card with Undo. See the [lead spec, "The Memory interface and git writer"](specs/lead.md#the-memory-interface-and-git-writer-design-4).

## Dreams

Once a night per organization, `DreamRunner` collects the day's originals (journal, chat messages, worker reports, GitHub events) and runs an isolated lead session in dream mode on a scratch checkout. It merges duplicates, supersedes stale items and lists contradictions, which a stronger model turns into a resolution or a question for the owner. Code checks every change (schema, sources, no deletions, secret scan) before the result goes to a `dream/<date>` branch for the owner to approve. The morning routine uses it for the brief. See the [triggers spec, "Dreaming pipeline"](specs/triggers.md#dreaming-pipeline-one-per-org-per-night).

## Triggers

Everything that wakes a lead without a chat message goes through one inbox (`kin_trigger_inbox`) into the event queue. Time triggers (deferrals, morning and evening routines, watchdogs that chase stale items) run on T3's scheduler in the owner's time zone. GitHub webhooks arrive verified and deduplicated by delivery id. A deferral is a memory item with a due time and an `on_due` of remind, start, ask or chase; the lead creates one with `kin_defer`. See the [triggers spec](specs/triggers.md).

## Approvals

Authority never passes through a model. A lead can only propose a privileged action (merge, enrol a key) with `request_action`, which stores a pending action bound to an exact target, such as a PR at a pinned head SHA. The owner's phone shows an approval card and signs a single-use grant with a hardware key behind Face ID. `ActionExecutor` checks the grant and runs the action with an executor-held credential, then writes a hash-chained audit row. Chat text, including "approved", never counts. See the [approvals spec](specs/approvals.md).

A lead just works in chats its owner placed it in (its DM, the owner's groups): posts, workers, draft PRs. There is no ladder and the owner never sees a level. An internal gate (`KinLevels`) refuses the lead in any other chat, so members can't widen what it does; only an owner-signed `set_level` changes it. See [DESIGN.md section 10](DESIGN.md#10-permissions) and the [lead spec, "Permissions"](specs/lead.md#permissions-design-10).

## Running Kin locally

Set up the repo as upstream's [development runbook](../operations/development.md) describes (`vp i`). Then:

1. Make a local bare git repo for memory and commit a `rules.md` to it:

   ```sh
   git init --bare /path/to/kin-memory.git
   git clone /path/to/kin-memory.git /tmp/kin-memory && cd /tmp/kin-memory
   echo "# Rules" > rules.md && git add rules.md && git commit -m "init" && git push
   ```

2. Start the dev server with Kin on:

   ```sh
   KIN_ENABLED=true KIN_MEMORY_DIRECT_PUSH=true \
   KIN_MEMORY_REPOSITORIES='[{"orgId":"kin-default","repoUrl":"/path/to/kin-memory.git"}]' \
   vp run dev
   ```

   Memory writes to the default branch go through PRs when the GitHub App is set up. Without it they're refused, unless `KIN_MEMORY_DIRECT_PUSH=true` lets them push directly, which is what a local bare repo needs.

3. Pair a browser, then create a lead from another shell. Point `--base-dir` at the dev server's home (in a worktree, its `.t3`):

   ```sh
   KIN_ENABLED=true node apps/server/src/bin.ts kin lead create --base-dir .t3 \
     --person kin-default-owner --name "Tech lead" \
     --strong claudeAgent:<model> --cheap claudeAgent:<model>
   ```

   **A lead must run on Claude.** Only Claude sessions get the lead's no-shell tool set, so creation refuses any other provider. Workers can use any provider.

Real lead turns cost money. Use the cheapest Claude model while developing.

## The Kin host

Kin runs from a source build on an always-on Linux machine, as a dedicated `kin` user. [ops/kin/host/README.md](../../ops/kin/host/README.md) covers install, updates, creating the first lead, backups and reading reply latency.

## Shipping work

- Pick a task from [PLAN.md](PLAN.md). Branch from `kin` and open the PR against the fork, never upstream: `gh pr create --repo GLDRoger/t3code --base kin`.
- Run `vp run check:changed <remote>/kin` and the task's own tests before pushing. Don't run repo-wide checks.
- Conventional Commits (`feat(kin): …`). PR body: **Why**, **How**, **Tests**.
- If a spec turns out to be wrong, fix it in the same PR.
- Never give an agent a way to approve, merge or change permissions. If a task seems to need one, stop and say so.
- The repo is public. Organization data, memory, tokens and keys never go in it.

## Words we use

| Word          | Meaning                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------- |
| Lead          | The code name for an agent that talks in chats, decides and keeps memory. People and agents only ever read "agent". |
| Worker        | A T3 thread a lead starts for one piece of work, in its own worktree.                                               |
| Wake-up       | One run of a lead over a batch of events for one chat.                                                              |
| Owner         | The person whose machine, subscriptions and repos Kin uses. Only the owner approves.                                |
| Grant         | The owner's signed, single-use approval of one pending action.                                                      |
| Floor manager | Plain code that decides which agent may speak in a chat. There is no judge model.                                   |
| Deferral      | "Let's do this Friday": a memory item with a due time and what to do then.                                          |
| Dream         | The nightly job that tidies memory into a PR and prepares the morning brief.                                        |
| L0–L3         | The server's internal permission gate per lead and chat. Never shown to the owner.                                  |

## Who to ask

Nishchay Chandra ([GLDRoger](https://github.com/GLDRoger)) owns the design and approves security-sensitive work. Ask about a task on its PR, and about the design in a PR that edits DESIGN.md, so the answer ends up written down.
