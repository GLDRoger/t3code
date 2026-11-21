# Kin: handover brief

Read this first if you're joining Kin, whether you're a person or an agent. It tells you what exists, where it lives and how to run it. The specs hold the detail.

## What Kin is

Read [VISION.md](VISION.md) first. It's short, and it overrides any summary that treats Kin as a single-owner assistant.

In one line: Kin is a messaging app, built on [T3 Code](https://github.com/pingdotgg/t3code), from which the owner runs a company on his phone. AI leads (one per domain: engineering, growth, finance and so on) and people talk in DMs and groups. Leads decide, remember and follow up. The actual work runs in ordinary T3 threads ("workers"). The owner level (the owner and his co-owners) approves privileged actions, by signing on a phone; who may do what is in [RULES.md](RULES.md).

[DESIGN.md](DESIGN.md) is the full design, [PLAN.md](PLAN.md) the roadmap, and [specs/](specs/) describe each area as built.

## Where the code lives

All Kin work is on branch `kin` of `GLDRoger/t3code`, a public fork. `main` mirrors upstream; never commit to it. [KIN.md](../../KIN.md) has the branch, sync and branding rules.

| Where                                  | What                                                                                                                                                           |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/kin/work/`            | Work: tasks, clients and prospects, deals, projects and campaigns, money, statements, docs, tags and lists, import and export, the live Work and Money streams |
| `apps/server/src/kin/pulse/`           | The pulse: what is open, late or quiet, read at tick time and told once (`kin_pulse_told`); check-ins and the morning brief                                    |
| `apps/server/src/kin/open/`            | Everything open for one person, built at read time from the sources' own reads                                                                                 |
| `apps/server/src/kin/chat/`            | Chats, messages, members, identity, the live hub, task cards, chat RPCs                                                                                        |
| `apps/server/src/kin/floor/`           | Who may speak: `FloorManager` (pure rules) and `KinFloor` (runs and grants in SQLite)                                                                          |
| `apps/server/src/kin/lead/`            | Agent turns: the event queue, wake-up runner, instructions, sessions per provider, budget, stop switch, workers                                                |
| `apps/server/src/kin/reply/`           | The reply bridge (lead text → chat messages) and presence ("thinking", "working")                                                                              |
| `apps/server/src/kin/team/`            | The Team room, where agents discuss with each other                                                                                                            |
| `apps/server/src/kin/people/`          | People, roles and who may do what (`KinAccess`), profiles, a leaver's hand-over                                                                                |
| `apps/server/src/kin/questions/`       | An agent's open questions to a person, and the default it takes                                                                                                |
| `apps/server/src/kin/sales/`           | The sales seat: its instructions, pipeline reads and policies                                                                                                  |
| `apps/server/src/kin/social/`          | Social posts through a provider, their cards and previews                                                                                                      |
| `apps/server/src/kin/connections/`     | Mail, Google and GitHub sign-ins, inbound mail, the outbound guard                                                                                             |
| `apps/server/src/kin/gendocs/`         | Documents an agent makes: quotes, invoices, receipts and their numbering                                                                                       |
| `apps/server/src/kin/recommend/`       | Recommendations: what Kin suggests to the owner                                                                                                                |
| `apps/server/src/kin/memory/`          | Memory reads, the git writer, change cards and memory PRs                                                                                                      |
| `apps/server/src/kin/dreaming/`        | The nightly dream                                                                                                                                              |
| `apps/server/src/kin/triggers/`        | Time triggers, deferrals, routines, watchdogs, pings, GitHub readers, the trigger inbox                                                                        |
| `apps/server/src/kin/approvals/`       | Pending actions, approver keys, grant checks, the executor, audit                                                                                              |
| `apps/server/src/kin/levels/`          | A lead's permission level, raised only through a signed grant                                                                                                  |
| `apps/server/src/kin/github/`          | The owner's GitHub watch, its triggers, signed replies and `kin_github_*` tools                                                                                |
| `apps/server/src/kin/widgets/`         | Chat cards: tasks, choices, charts, reminders and their actions                                                                                                |
| `apps/server/src/kin/tasksKey/, you/`  | Keys for a person's own coding agent, and what that agent is told                                                                                              |
| `apps/server/src/kin/auth/`            | Kin's hooks into T3's sign-in and sessions                                                                                                                     |
| `apps/server/src/kin/push/`            | Kin's own APNs sender                                                                                                                                          |
| `apps/server/src/kin/cli/`             | The `kin` commands on the host (import, people, statements, pulse)                                                                                             |
| `apps/server/src/kin/persistence/`     | Kin's migration track (`kin_sql_migrations`, K001 onward)                                                                                                      |
| `apps/server/src/kin/mcp/`             | The `/kin/mcp` endpoint that only registered agent threads get                                                                                                 |
| `apps/server/src/kin/featureMap/`      | Every feature, where it is on web and phone, for which roles, and its proof                                                                                    |
| `packages/contracts/src/kin*.ts`       | Schemas shared by server and clients                                                                                                                           |
| `packages/client-runtime/src/kin/`     | Client logic and words shared by web and mobile                                                                                                                |
| `apps/mobile/src/features/chats/`      | The mobile app's Kin screens                                                                                                                                   |
| `apps/web/src/kin/`                    | The web and desktop Kin screens                                                                                                                                |
| `ops/kin/host/`                        | Host install, update, backup and restore                                                                                                                       |
| `evals/mcp-tool-use/cases/kin*.ndjson` | Kin's agent evals and their gate (`evals/README.md`)                                                                                                           |

Kin code lives in its own files. Upstream files get a hook of a line or two at most, so upstream merges stay easy.

## How a message flows

1. **Chat.** A client calls `kin.messages.send`. `KinChatService` checks membership, stores the message with the next sequence number, and calls `KinFloor.open`, which opens a floor run and grants a turn. In a direct chat that is the lead; in a group it is the mentioned agent, and with no mention it will be the group's lead (W3-1). After commit, `KinChatHub` publishes the message to every member's stream.
2. **Queue.** `ChatWake` turns the message into a `chat.message` event in `KinEventQueue` (`kin_events`) and shows the lead's working line ("Catching up", or "Finishing something else" behind a running wake-up) at once. Triggers, finished tasks and approval results become events the same way. Code sets each event's priority; an owner message is P0.
3. **Wake-up.** `WakeupRunner` waits briefly for a burst to finish, then claims a batch of events for one lead and one chat. It checks the stop switch and budget, prepares a read-only memory checkout, builds the prompt (`LeadPrompt`) and runs the lead as a T3 thread. A message that arrives during a wake-up is steered into it.
4. **Lead.** The lead acts through Kin's MCP tools: memory, deferrals, cards, Work. In a turn only the owner reads that has read nothing from outside, it also gets a shell (with the owner's GitHub login) and T3's `delegate_task`. Its plain text is its reply.
5. **Reply bridge.** `KinReplyBridge` reads the lead's text as it streams and posts it through `LevelGate`, so membership, the floor and permissions apply.
6. **Clients.** Members' streams deliver the reply, and `KinPushSender` pushes it to phones that aren't showing the chat.

The [lead spec](specs/lead.md) covers queue, wake-up and replies in full. The [chat spec](specs/chat.md) covers chats, streams and the floor.

## Memory

Memory is plain Markdown files with front matter in a private git repo per organization: rules, objectives, commitments, deferrals, decisions, people, claims and a journal. Only a lead writes it, and only inside a wake-up. Each wake-up's changes land as one commit through `MemoryWriter`, which scans for secrets and validates the writer checkout first. Nothing is deleted: items are marked invalid. Every item records who said it and with what trust. The owner sees a change card with Undo. See the [lead spec, "The Memory interface and git writer"](specs/lead.md#the-memory-interface-and-git-writer-design-4).

## Dreams

Once a night per organization, `DreamRunner` collects the day's originals (journal, chat messages, finished tasks, GitHub events) and runs an isolated lead session in dream mode on a scratch checkout. It merges duplicates, supersedes stale items and lists contradictions, which a second turn on the same model turns into a resolution or a question for the owner. Code checks every change (schema, sources, no deletions, secret scan) before the result goes to a `dream/<date>` branch, and then lands it on the default branch the way an owner change does (direct push or the memory PR), with no approval step. It does not land when memory changed under any file it touched since it started; that night fails and its material is offered again. A night's material counts as dreamed in the transaction that lands it, or when the night passed its checks and changed nothing, so the next night starts where that night ended. See the [triggers spec, "Dreaming pipeline"](specs/triggers.md#dreaming-pipeline-one-per-org-per-night).

## Triggers

Everything that wakes a lead without a chat message goes through one inbox (`kin_trigger_inbox`) into the event queue. Time triggers (deferrals, morning and evening routines, watchdogs that chase stale items) run on T3's scheduler in the owner's time zone. GitHub activity comes from the owner's watch, which polls his watched repos with his own login and wakes a lead on a `/kin` call or a review request. A deferral is a memory item with a due time and an `on_due` of remind, start, ask or chase; the lead creates one with `kin_defer`. See the [triggers spec](specs/triggers.md).

## Approvals

Authority never passes through a model. No agent can request a privileged action. The owner asks from his own session (raising a lead's level), which stores a pending action bound to an exact target. The owner's phone shows an approval card and signs a single-use grant with a hardware key behind Face ID. `ActionExecutor` checks the grant and runs the action, then writes a hash-chained audit row. Kin never merges: the lead says when a PR is ready and the owner merges it. Chat text, including "approved", never counts. See the [approvals spec](specs/approvals.md).

A lead just works in chats its owner placed it in (its DM, the owner's groups): posts, delegated tasks, PRs. There is no ladder and the owner never sees a level. An internal gate (`KinLevels`) refuses the lead in any other chat, so members can't widen what it does; only an owner-signed `set_level` changes it. See [DESIGN.md section 10](DESIGN.md#10-permissions) and the [lead spec, "Permissions"](specs/lead.md#permissions-design-10).

## Running Kin locally

Set up the repo as upstream's [development runbook](../operations/development.md) describes (`vp i`). Then:

1. Start the dev server with Kin on:

   ```sh
   KIN_ENABLED=true T3CODE_DEV_SEED=0 vp run dev
   ```

   With no `KIN_MEMORY_REPOSITORIES`, the dev server makes a local memory repo, `kin-dev-memory.git` in its state directory, seeded with `rules.md`, and pushes to it directly. To use your own repo instead, set `KIN_MEMORY_REPOSITORIES='[{"orgId":"kin-default","repoUrl":"/path/to/kin-memory.git"}]'` and `KIN_MEMORY_DIRECT_PUSH=true`; the repo needs a commit on `main`. An installed host has no such default: without `KIN_MEMORY_REPOSITORIES` its agents don't start, and the server log and each agent chat say why.

2. `KIN_DEV_FAKE_MAIL=google:a@x.example,microsoft:b@x.example` connects fake mail accounts that answer in process, so mail can be tested with no vendor.

3. Pair a browser, then create a lead from another shell. Point `--base-dir` at the dev server's home (in a worktree, its `.t3`):

   ```sh
   KIN_ENABLED=true node apps/server/src/bin.ts kin lead create --base-dir .t3 \
     --person kin-default-owner --name "Tech lead" \
     --model claudeAgent:<model>
   ```

   **A lead must run on Claude.** Only Claude sessions get the lead's no-shell tool set, so creation refuses any other provider. Delegated tasks can use any provider.

Real lead turns cost money. Use the cheapest Claude model while developing.

To verify without a model, `node scripts/kin-verify.ts up` starts an isolated, seeded Kin whose leads run on a scripted no-model agent (allowed only on a dev server); `.agents/skills/verify-kin/SKILL.md` covers it and its lifecycle scripts.
Every Kin route, pane, phone screen and agent tool belongs to a feature in `apps/server/src/kin/featureMap/feature-map.yaml`; `featureMap.test.ts` fails when one is unlisted, a proof file is missing, or a path breaks the depth rule without a reason, and `node apps/server/scripts/kin-feature-map.ts <out.md>` renders it.

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
